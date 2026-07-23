import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";
import { assertStorageLimitNotExceeded, StorageLimitError } from "../../services/storage.service.js";

const CATEGORY_LABELS: Record<string, string> = {
  QUESTION_PAPER: "Question Paper", ANSWER_KEY: "Answer Key",
  HALL_TICKET: "Hall Ticket", SEATING_PLAN: "Seating Plan",
  MODERATION_FILE: "Moderation File", PRACTICAL_RECORD: "Practical Record",
  INTERNAL_ASSESSMENT: "Internal Assessment", CIRCULAR_NOTICE: "Circular / Notice",
  EVALUATION_SHEET: "Evaluation Sheet", RESULT_PDF: "Result PDF",
  SAMPLE_PAPER: "Sample Paper", OTHER: "Other",
};

async function logAction(documentId: number, schoolId: number, userId: number, action: string) {
  try {
    await prisma.docAuditLog.create({ data: { documentId, schoolId, userId, action } });
  } catch {}
}

export async function adminExamDocsRoutes(app: FastifyInstance) {

  // ── GET /admin/exam-docs/meta ─────────────────────────────
  app.get("/admin/exam-docs/meta",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [examConfigs, classes, subjects, stats] = await Promise.all([
        prisma.examConfig.findMany({
          where: { schoolId },
          orderBy: { createdAt: "desc" },
          select: { id: true, name: true, sessionName: true, category: true },
        }),
        prisma.class.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          select: { id: true, name: true },
        }),
        prisma.subject.findMany({
          where: { schoolId, isActive: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        }),
        (async () => {
          const [total, published, confidential, byCategory] = await Promise.all([
            prisma.examDocument.count({ where: { schoolId } }),
            prisma.examDocument.count({ where: { schoolId, status: "PUBLISHED" } }),
            prisma.examDocument.count({ where: { schoolId, isConfidential: true } }),
            prisma.examDocument.groupBy({ by: ["category"], where: { schoolId }, _count: true }),
          ]);
          return { total, published, confidential, byCategory };
        })(),
      ]);
      return reply.send({ success: true, data: { examConfigs, classes, subjects, stats, categoryLabels: CATEGORY_LABELS } });
    }
  );

  // ── GET /admin/exam-docs ──────────────────────────────────
  app.get("/admin/exam-docs",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as {
        page?: string; search?: string; category?: string;
        examConfigId?: string; classId?: string; subjectId?: string;
        status?: string; accessLevel?: string;
      };

      const page = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 20;
      const where: any = { schoolId };
      if (q.category)      where.category      = q.category;
      if (q.examConfigId)  where.examConfigId  = parseInt(q.examConfigId);
      if (q.classId)       where.classId       = parseInt(q.classId);
      if (q.subjectId)     where.subjectId     = parseInt(q.subjectId);
      if (q.status)        where.status        = q.status;
      if (q.accessLevel)   where.accessLevel   = q.accessLevel;
      if (q.search) {
        where.OR = [
          { title:    { contains: q.search, mode: "insensitive" } },
          { fileName: { contains: q.search, mode: "insensitive" } },
          { tags:     { has: q.search } },
        ];
      }

      const [docs, total] = await Promise.all([
        prisma.examDocument.findMany({
          where, skip: (page - 1) * limit, take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            examConfig: { select: { name: true } },
            class:      { select: { name: true } },
            subject:    { select: { name: true } },
            uploadedBy: { select: { name: true } },
            approvedBy: { select: { name: true } },
            _count:     { select: { auditLogs: true } },
          },
        }),
        prisma.examDocument.count({ where }),
      ]);

      // Folder tree (grouped by exam + category)
      const tree = await prisma.examDocument.groupBy({
        by: ["examConfigId", "category"],
        where: { schoolId },
        _count: true,
      });

      return reply.send({ success: true, data: { docs, total, totalPages: Math.ceil(total / limit), folderTree: tree } });
    }
  );

  // ── GET /admin/exam-docs/:id ──────────────────────────────
  app.get("/admin/exam-docs/:id",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };

      const doc = await prisma.examDocument.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          examConfig: { select: { name: true, category: true } },
          class:      { select: { name: true } },
          subject:    { select: { name: true } },
          uploadedBy: { select: { name: true } },
          approvedBy: { select: { name: true } },
          auditLogs:  { orderBy: { createdAt: "desc" }, take: 10, include: { user: { select: { name: true } } } },
        },
      });

      if (!doc) return reply.status(404).send({ success: false, message: "Document not found." });

      // Log view
      await logAction(doc.id, schoolId, userId, "VIEWED");
      await prisma.examDocument.update({ where: { id: doc.id }, data: { viewCount: { increment: 1 } } });

      // Versions (other docs with same parentDocId or same title+category)
      const versions = await prisma.examDocument.findMany({
        where: { schoolId, OR: [{ parentDocId: doc.id }, { id: doc.parentDocId ?? -1 }] },
        orderBy: { version: "desc" },
        select: { id: true, version: true, fileName: true, createdAt: true, uploadedBy: { select: { name: true } } },
      });

      return reply.send({ success: true, data: { doc, versions } });
    }
  );

  // ── POST /admin/exam-docs ─────────────────────────────────
  app.post("/admin/exam-docs",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        title: string; description?: string; category: string;
        fileName: string; fileUrl: string; fileType: string; fileSize?: number;
        examConfigId?: number; classId?: number; subjectId?: number;
        accessLevel?: string; isConfidential?: boolean;
        hasWatermark?: boolean; watermarkText?: string;
        allowDownload?: boolean; expiresAt?: string;
        visibleFrom?: string; visibleUntil?: string;
        tags?: string[];
        parentDocId?: number;  // for new version
      };

      if (!body.title?.trim() || !body.fileName || !body.fileUrl || !body.category) {
        return reply.status(400).send({ success: false, message: "title, fileName, fileUrl and category required." });
      }

      try {
        await assertStorageLimitNotExceeded(schoolId, body.fileSize ?? 0);
      } catch (err) {
        if (err instanceof StorageLimitError) {
          return reply.status(507).send({ success: false, message: err.message });
        }
        throw err;
      }

      // Auto version if parentDocId provided
      let version = 1;
      if (body.parentDocId) {
        const parent = await prisma.examDocument.findFirst({ where: { id: body.parentDocId, schoolId } });
        if (parent) version = parent.version + 1;
      }

      const doc = await prisma.examDocument.create({
        data: {
          schoolId, uploadedById: userId,
          title: body.title.trim(),
          description: body.description ?? null,
          category: body.category as any,
          fileName: body.fileName,
          fileUrl: body.fileUrl,
          fileType: body.fileType,
          fileSize: body.fileSize ?? 0,
          examConfigId: body.examConfigId ?? null,
          classId: body.classId ?? null,
          subjectId: body.subjectId ?? null,
          accessLevel: body.accessLevel as any ?? "TEACHERS_ONLY",
          isConfidential: body.isConfidential ?? false,
          hasWatermark: body.hasWatermark ?? false,
          watermarkText: body.watermarkText ?? null,
          allowDownload: body.allowDownload ?? true,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          visibleFrom: body.visibleFrom ? new Date(body.visibleFrom) : null,
          visibleUntil: body.visibleUntil ? new Date(body.visibleUntil) : null,
          tags: body.tags ?? [],
          status: "DRAFT",
          version,
          parentDocId: body.parentDocId ?? null,
        },
      });

      await logAction(doc.id, schoolId, userId, "UPLOADED");

      return reply.status(201).send({ success: true, message: "Document uploaded.", data: { docId: doc.id } });
    }
  );

  // ── PUT /admin/exam-docs/:id ──────────────────────────────
  app.put("/admin/exam-docs/:id",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const body = req.body as any;

      await prisma.examDocument.updateMany({
        where: { id: parseInt(id), schoolId },
        data: {
          ...(body.title       !== undefined && { title: body.title }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.category    !== undefined && { category: body.category }),
          ...(body.accessLevel !== undefined && { accessLevel: body.accessLevel }),
          ...(body.status      !== undefined && { status: body.status }),
          ...(body.isConfidential !== undefined && { isConfidential: body.isConfidential }),
          ...(body.hasWatermark   !== undefined && { hasWatermark: body.hasWatermark }),
          ...(body.watermarkText  !== undefined && { watermarkText: body.watermarkText }),
          ...(body.allowDownload  !== undefined && { allowDownload: body.allowDownload }),
          ...(body.tags           !== undefined && { tags: body.tags }),
          ...(body.visibleFrom    !== undefined && { visibleFrom: body.visibleFrom ? new Date(body.visibleFrom) : null }),
          ...(body.visibleUntil   !== undefined && { visibleUntil: body.visibleUntil ? new Date(body.visibleUntil) : null }),
          ...(body.expiresAt      !== undefined && { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null }),
          ...(body.examConfigId   !== undefined && { examConfigId: body.examConfigId }),
          ...(body.classId        !== undefined && { classId: body.classId }),
          ...(body.subjectId      !== undefined && { subjectId: body.subjectId }),
        },
      });

      return reply.send({ success: true, message: "Document updated." });
    }
  );

  // ── PATCH /admin/exam-docs/:id/approve ───────────────────
  app.patch("/admin/exam-docs/:id/approve",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };

      await prisma.examDocument.updateMany({
        where: { id: parseInt(id), schoolId },
        data: { status: "APPROVED", approvedById: userId, approvedAt: new Date() },
      });
      await logAction(parseInt(id), schoolId, userId, "APPROVED");
      return reply.send({ success: true, message: "Document approved." });
    }
  );

  // ── PATCH /admin/exam-docs/:id/publish ───────────────────
  app.patch("/admin/exam-docs/:id/publish",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };

      await prisma.examDocument.updateMany({
        where: { id: parseInt(id), schoolId },
        data: { status: "PUBLISHED" },
      });
      await logAction(parseInt(id), schoolId, userId, "PUBLISHED");
      return reply.send({ success: true, message: "Document published." });
    }
  );

  // ── PATCH /admin/exam-docs/:id/download ──────────────────
  app.patch("/admin/exam-docs/:id/download",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };

      const doc = await prisma.examDocument.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!doc) return reply.status(404).send({ success: false, message: "Not found." });
      if (!doc.allowDownload) return reply.status(403).send({ success: false, message: "Download not allowed for this document." });

      await prisma.examDocument.update({ where: { id: parseInt(id) }, data: { downloadCount: { increment: 1 } } });
      await logAction(parseInt(id), schoolId, userId, "DOWNLOADED");

      return reply.send({ success: true, data: { fileUrl: doc.fileUrl, fileName: doc.fileName } });
    }
  );

  // ── DELETE /admin/exam-docs/:id ───────────────────────────
  app.delete("/admin/exam-docs/:id",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const doc = await prisma.examDocument.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!doc) return reply.status(404).send({ success: false, message: "Not found." });
      if (doc.status === "LOCKED") return reply.status(400).send({ success: false, message: "Document is locked." });

      await prisma.examDocument.delete({ where: { id: parseInt(id) } });
      return reply.send({ success: true, message: "Document deleted." });
    }
  );

  // ── POST /admin/exam-docs/bulk-upload ────────────────────
  app.post("/admin/exam-docs/bulk-upload",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        files: { title: string; fileName: string; fileUrl: string; fileType: string; fileSize?: number }[];
        category: string; examConfigId?: number; classId?: number;
        accessLevel?: string; isConfidential?: boolean;
      };

      if (!body.files?.length) return reply.status(400).send({ success: false, message: "No files provided." });

      try {
        const totalIncomingBytes = body.files.reduce((sum, f) => sum + (f.fileSize ?? 0), 0);
        await assertStorageLimitNotExceeded(schoolId, totalIncomingBytes);
      } catch (err) {
        if (err instanceof StorageLimitError) {
          return reply.status(507).send({ success: false, message: err.message });
        }
        throw err;
      }

      const created = await prisma.examDocument.createMany({
        data: body.files.map(f => ({
          schoolId, uploadedById: userId,
          title: f.title, fileName: f.fileName, fileUrl: f.fileUrl,
          fileType: f.fileType, fileSize: f.fileSize ?? 0,
          category: body.category as any,
          examConfigId: body.examConfigId ?? null,
          classId: body.classId ?? null,
          accessLevel: body.accessLevel as any ?? "TEACHERS_ONLY",
          isConfidential: body.isConfidential ?? false,
          status: "DRAFT" as any,
          tags: [],
        })),
      });

      return reply.status(201).send({ success: true, message: `${created.count} documents uploaded.`, data: { count: created.count } });
    }
  );

  // ── GET /admin/exam-docs/search ───────────────────────────
  app.get("/admin/exam-docs/search",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { q } = req.query as { q: string };
      if (!q?.trim()) return reply.send({ success: true, data: { results: [] } });

      const docs = await prisma.examDocument.findMany({
        where: {
          schoolId,
          OR: [
            { title:    { contains: q, mode: "insensitive" } },
            { fileName: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
          ],
        },
        take: 10,
        include: { uploadedBy: { select: { name: true } }, examConfig: { select: { name: true } } },
      });

      return reply.send({ success: true, data: { results: docs } });
    }
  );
}
