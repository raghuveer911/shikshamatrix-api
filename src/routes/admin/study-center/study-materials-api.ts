// apps/api/src/routes/admin/study-center/study-materials-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { assertStorageLimitNotExceeded, StorageLimitError } from "../../../services/storage.service.js";

export async function adminStudyMaterialsRoutes(app: FastifyInstance) {
  const P = "/admin/study/materials";

  // ─── DASHBOARD STATS ──────────────────────────────────────
  app.get(`${P}/stats`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [total, typeBreakdown, recentUploads, topDownloaded] = await Promise.all([
        prisma.studyMaterial.count({ where: { schoolId, isArchived: false } }),
        prisma.studyMaterial.groupBy({
          by: ["type"],
          where: { schoolId, isArchived: false },
          _count: { id: true },
          _sum: { downloadCount: true, viewCount: true },
          orderBy: { _count: { id: "desc" } },
        }),
        prisma.studyMaterial.findMany({
          where: { schoolId, isArchived: false },
          orderBy: { createdAt: "desc" },
          take: 5,
          include: {
            subject: { select: { name: true } },
            uploadedBy: { include: { user: { select: { name: true } } } },
          },
        }),
        prisma.studyMaterial.findMany({
          where: { schoolId, isArchived: false },
          orderBy: { downloadCount: "desc" },
          take: 5,
          select: { id: true, title: true, type: true, downloadCount: true, viewCount: true },
        }),
      ]);

      const totalDownloads = typeBreakdown.reduce((s, t) => s + (t._sum.downloadCount ?? 0), 0);
      const totalViews     = typeBreakdown.reduce((s, t) => s + (t._sum.viewCount ?? 0), 0);

      return rep.send({ total, typeBreakdown, recentUploads, topDownloaded, totalDownloads, totalViews });
    }
  );

  // ─── LIST / SEARCH MATERIALS ──────────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId, isArchived: false };
      if (q.classId)    where.classId   = Number(q.classId);
      if (q.subjectId)  where.subjectId = Number(q.subjectId);
      if (q.chapterId)  where.chapterId = Number(q.chapterId);
      if (q.topicId)    where.topicId   = Number(q.topicId);
      if (q.type)       where.type      = q.type;
      if (q.visibility) where.visibility = q.visibility;
      if (q.uploadedById) where.uploadedById = Number(q.uploadedById);
      if (q.search) {
        where.OR = [
          { title: { contains: q.search, mode: "insensitive" } },
          { description: { contains: q.search, mode: "insensitive" } },
          { tags: { has: q.search } },
        ];
      }

      const [materials, total] = await Promise.all([
        prisma.studyMaterial.findMany({
          where,
          include: {
            subject: { select: { name: true, code: true } },
            chapter: { select: { name: true, chapterNumber: true } },
            topic:   { select: { name: true } },
            class:   { select: { name: true } },
            uploadedBy: { include: { user: { select: { name: true, avatarUrl: true } } } },
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.studyMaterial.count({ where }),
      ]);

      return rep.send({ materials, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── GET ONE ──────────────────────────────────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const material = await prisma.studyMaterial.findFirst({
        where: { id, schoolId },
        include: {
          subject: { select: { name: true } },
          chapter: { select: { name: true } },
          topic:   { select: { name: true } },
          class:   { select: { name: true } },
          uploadedBy: { include: { user: { select: { name: true } } } },
          _count: { select: { assignmentMaterials: true, lessonPlanMaterials: true } },
        },
      });
      if (!material) return rep.code(404).send({ error: "Not found" });
      return rep.send({ material });
    }
  );

  // ─── CREATE MATERIAL ──────────────────────────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      // Find staff by userId
      const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId } });

      try {
        await assertStorageLimitNotExceeded(schoolId, b.fileSizeKb ? Number(b.fileSizeKb) * 1024 : 0);
      } catch (err) {
        if (err instanceof StorageLimitError) return rep.status(507).send({ success: false, message: err.message });
        throw err;
      }

      const material = await prisma.studyMaterial.create({
        data: {
          schoolId,
          uploadedById: staff?.id ?? null,
          classId:    b.classId   ? Number(b.classId)   : null,
          subjectId:  b.subjectId ? Number(b.subjectId) : null,
          chapterId:  b.chapterId ? Number(b.chapterId) : null,
          topicId:    b.topicId   ? Number(b.topicId)   : null,
          title:       b.title,
          description: b.description ?? null,
          type:        b.type as any ?? "PDF",
          visibility:  b.visibility as any ?? "STUDENT_VISIBLE",
          fileUrl:     b.fileUrl ?? null,
          fileName:    b.fileName ?? null,
          fileSizeKb:  b.fileSizeKb ? Number(b.fileSizeKb) : null,
          mimeType:    b.mimeType ?? null,
          thumbnailUrl: b.thumbnailUrl ?? null,
          externalUrl:  b.externalUrl ?? null,
          tags:        b.tags ?? [],
        },
      });
      return rep.code(201).send({ material });
    }
  );

  // ─── UPDATE MATERIAL ──────────────────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const material = await prisma.studyMaterial.update({
        where: { id, schoolId },
        data: {
          title:       b.title,
          description: b.description,
          type:        b.type as any,
          visibility:  b.visibility as any,
          classId:     b.classId   ? Number(b.classId)   : undefined,
          subjectId:   b.subjectId ? Number(b.subjectId) : undefined,
          chapterId:   b.chapterId ? Number(b.chapterId) : undefined,
          topicId:     b.topicId   ? Number(b.topicId)   : undefined,
          fileUrl:     b.fileUrl,
          externalUrl: b.externalUrl,
          tags:        b.tags,
          isArchived:  b.isArchived,
        },
      });
      return rep.send({ material });
    }
  );

  // ─── ARCHIVE (soft delete) ────────────────────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.studyMaterial.update({ where: { id, schoolId }, data: { isArchived: true } });
      return rep.send({ ok: true });
    }
  );

  // ─── CLONE (new version) ──────────────────────────────────
  app.post(`${P}/:id/clone`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const src = await prisma.studyMaterial.findFirst({ where: { id, schoolId } });
      if (!src) return rep.code(404).send({ error: "Not found" });

      const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId } });

      try {
        await assertStorageLimitNotExceeded(schoolId, src.fileSizeKb ? src.fileSizeKb * 1024 : 0);
      } catch (err) {
        if (err instanceof StorageLimitError) return rep.status(507).send({ success: false, message: err.message });
        throw err;
      }

      const clone = await prisma.studyMaterial.create({
        data: {
          ...src,
          id: undefined,
          title: `${src.title} (Copy)`,
          uploadedById: staff?.id ?? null,
          version: src.version + 1,
          parentId: src.id,
          viewCount: 0, downloadCount: 0,
          isArchived: false,
          createdAt: undefined, updatedAt: undefined,
        },
      });
      return rep.code(201).send({ material: clone });
    }
  );

  // ─── TRACK ACCESS ─────────────────────────────────────────
  app.patch(`${P}/:id/access`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id   = Number((req.params as any).id);
      const type = ((req.body as any).type ?? "view") as "view" | "download";
      const data: any = {};
      if (type === "view")     data.viewCount     = { increment: 1 };
      if (type === "download") data.downloadCount = { increment: 1 };
      await prisma.studyMaterial.update({ where: { id, schoolId }, data });
      return rep.send({ ok: true });
    }
  );

  // ─── SUBJECT RESOURCES (all materials for a subject) ──────
  app.get(`${P}/by-subject/:subjectId`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const subjectId = Number((req.params as any).subjectId);
      const materials = await prisma.studyMaterial.findMany({
        where: { schoolId, subjectId, isArchived: false },
        orderBy: [{ chapterId: "asc" }, { type: "asc" }, { createdAt: "desc" }],
        include: {
          chapter: { select: { name: true, chapterNumber: true } },
          topic:   { select: { name: true } },
        },
      });
      return rep.send({ materials });
    }
  );

  // ─── USAGE ANALYTICS ──────────────────────────────────────
  app.get(`${P}/analytics/usage`, { preHandler: [authenticate, requireCapability('studyCenter.advanced')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const [byType, bySubject, byVisibility] = await Promise.all([
        prisma.studyMaterial.groupBy({
          by: ["type"],
          where: { schoolId, isArchived: false },
          _count: { id: true },
          _sum: { viewCount: true, downloadCount: true },
          orderBy: { _sum: { downloadCount: "desc" } },
        }),
        prisma.studyMaterial.groupBy({
          by: ["subjectId"],
          where: { schoolId, isArchived: false, subjectId: { not: null } },
          _count: { id: true },
          orderBy: { _count: { id: "desc" } },
          take: 8,
        }),
        prisma.studyMaterial.groupBy({
          by: ["visibility"],
          where: { schoolId, isArchived: false },
          _count: { id: true },
        }),
      ]);

      const subjectIds = bySubject.map(s => s.subjectId).filter(Boolean) as number[];
      const subjectNames = await prisma.subject.findMany({
        where: { id: { in: subjectIds } },
        select: { id: true, name: true },
      });
      const subjectMap = Object.fromEntries(subjectNames.map(s => [s.id, s.name]));

      return rep.send({
        byType,
        bySubject: bySubject.map(s => ({ subjectId: s.subjectId, name: s.subjectId ? subjectMap[s.subjectId] ?? "?" : "?", count: s._count.id })),
        byVisibility,
      });
    }
  );
}
