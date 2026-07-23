// apps/api/src/routes/admin/financial-documents.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { assertStorageLimitNotExceeded, StorageLimitError } from "../../../services/storage.service.js";

async function genDocNo(schoolId: number): Promise<string> {
  const y = new Date().getFullYear().toString().slice(-2);
  const m = String(new Date().getMonth() + 1).padStart(2, "0");
  const cnt = await prisma.financialDocument.count({ where: { schoolId } });
  return `DOC-${y}${m}-${String(cnt + 1).padStart(5, "0")}`;
}

export async function adminFinancialDocumentRoutes(app: FastifyInstance) {

  // ─── GET /admin/financial-docs/meta ──────────────────────
  app.get("/admin/financial-docs/meta", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const thirtyDays = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

      const [byStatus, byCategory, total, expiringSoon, staff] = await Promise.all([
        prisma.financialDocument.groupBy({ by: ["status"],   where: { schoolId, isArchived: false }, _count: true }),
        prisma.financialDocument.groupBy({ by: ["category"], where: { schoolId, isArchived: false }, _count: true }),
        prisma.financialDocument.count({ where: { schoolId } }),
        prisma.financialDocument.findMany({ where: { schoolId, isArchived: false, expiryDate: { gte: now, lte: thirtyDays } }, orderBy: { expiryDate: "asc" }, take: 10, include: { uploadedBy: { select: { name: true } }, relatedStaff: { include: { user: { select: { name: true } } } } } }),
        prisma.staff.findMany({ where: { schoolId, isActive: true }, include: { user: { select: { id: true, name: true } } }, take: 80 }),
      ]);

      const sm: Record<string, number> = {};
      byStatus.forEach(b => { sm[b.status] = b._count; });

      return reply.send({ success: true, data: {
        kpi: { total, verified: sm.VERIFIED ?? 0, pending: sm.PENDING ?? 0, expired: sm.EXPIRED ?? 0, archived: await prisma.financialDocument.count({ where: { schoolId, isArchived: true } }), expiringSoon: expiringSoon.length },
        byCategory: byCategory.map(b => ({ category: b.category, count: b._count })).sort((a, b) => b.count - a.count),
        expiringSoon, staff,
      }});
    }
  );

  // ─── GET /admin/financial-docs ────────────────────────────
  app.get("/admin/financial-docs", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; category?: string; status?: string; staffId?: string; archived?: string; search?: string; from?: string; to?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.category)  where.category      = q.category;
      if (q.status)    where.status        = q.status;
      if (q.staffId)   where.relatedStaffId = parseInt(q.staffId);
      where.isArchived = q.archived === "true";
      if (q.from || q.to) { where.createdAt = {}; if (q.from) where.createdAt.gte = new Date(q.from); if (q.to) where.createdAt.lte = new Date(q.to); }
      if (q.search) where.OR = [
        { name:  { contains: q.search, mode: "insensitive" } },
        { docNo: { contains: q.search, mode: "insensitive" } },
        { description: { contains: q.search, mode: "insensitive" } },
      ];
      const [docs, total] = await Promise.all([
        prisma.financialDocument.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" },
          include: { uploadedBy: { select: { name: true } }, verifiedBy: { select: { name: true } }, relatedStaff: { include: { user: { select: { name: true } } } } } }),
        prisma.financialDocument.count({ where }),
      ]);
      // Flag expiry
      const now = new Date();
      const enriched = docs.map(d => ({ ...d, isExpiringSoon: d.expiryDate ? new Date(d.expiryDate) <= new Date(now.getTime() + 30*24*3600*1000) && d.status !== "ARCHIVED" : false }));
      return reply.send({ success: true, data: { docs: enriched, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── GET /admin/financial-docs/:id ───────────────────────
  app.get("/admin/financial-docs/:id", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const doc = await prisma.financialDocument.findFirst({ where: { id: parseInt(id), schoolId },
        include: { uploadedBy: { select: { name: true } }, verifiedBy: { select: { name: true } }, relatedStaff: { include: { user: { select: { name: true } } } } } });
      if (!doc) return reply.status(404).send({ success: false, message: "Document not found." });
      return reply.send({ success: true, data: { doc } });
    }
  );

  // ─── POST /admin/financial-docs ───────────────────────────
  app.post("/admin/financial-docs", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { name: string; category: string; description?: string; fileUrl: string; fileType?: string; fileSizeKb?: number; relatedStaffId?: number; relatedVendorId?: number; relatedEntityId?: number; relatedEntityType?: string; expiryDate?: string; tags?: string[] };
      if (!body.name?.trim() || !body.fileUrl) return reply.status(400).send({ success: false, message: "name and fileUrl required." });
      try {
        await assertStorageLimitNotExceeded(schoolId, (body.fileSizeKb ?? 0) * 1024);
      } catch (err) {
        if (err instanceof StorageLimitError) return reply.status(507).send({ success: false, message: err.message });
        throw err;
      }
      const docNo = await genDocNo(schoolId);
      const doc = await prisma.financialDocument.create({ data: { schoolId, uploadedById: userId, docNo, name: body.name.trim(), category: body.category as any ?? "OTHER", description: body.description ?? null, fileUrl: body.fileUrl, fileType: body.fileType ?? "PDF", fileSizeKb: body.fileSizeKb ?? null, relatedStaffId: body.relatedStaffId ?? null, relatedVendorId: body.relatedVendorId ?? null, relatedEntityId: body.relatedEntityId ?? null, relatedEntityType: body.relatedEntityType ?? null, expiryDate: body.expiryDate ? new Date(body.expiryDate) : null, tags: body.tags ?? [], status: "PENDING" } });
      return reply.status(201).send({ success: true, message: "Document uploaded.", data: { docId: doc.id, docNo } });
    }
  );

  // ─── PUT /admin/financial-docs/:id ───────────────────────
  app.put("/admin/financial-docs/:id", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const data: any = {};
      ["name","description","category","expiryDate","tags","relatedStaffId","relatedVendorId"].forEach(k => { if (body[k] !== undefined) data[k] = k === "expiryDate" && body[k] ? new Date(body[k]) : body[k]; });
      await prisma.financialDocument.updateMany({ where: { id: parseInt(id), schoolId }, data });
      return reply.send({ success: true, message: "Document updated." });
    }
  );

  // ─── PATCH /admin/financial-docs/:id/verify ──────────────
  app.patch("/admin/financial-docs/:id/verify", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { notes } = req.body as { notes?: string };
      await prisma.financialDocument.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "VERIFIED", verifiedById: userId, verifiedAt: new Date(), verificationNotes: notes ?? null } });
      return reply.send({ success: true, message: "Document verified." });
    }
  );

  // ─── PATCH /admin/financial-docs/:id/reject ──────────────
  app.patch("/admin/financial-docs/:id/reject", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };
      await prisma.financialDocument.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "REJECTED", verifiedById: userId, verifiedAt: new Date(), rejectedReason: reason } });
      return reply.send({ success: true, message: "Document rejected." });
    }
  );

  // ─── PATCH /admin/financial-docs/:id/archive ─────────────
  app.patch("/admin/financial-docs/:id/archive", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.financialDocument.updateMany({ where: { id: parseInt(id), schoolId }, data: { isArchived: true, archivedAt: new Date(), status: "ARCHIVED" } });
      return reply.send({ success: true, message: "Document archived." });
    }
  );

  // ─── PATCH /admin/financial-docs/:id/restore ─────────────
  app.patch("/admin/financial-docs/:id/restore", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.financialDocument.updateMany({ where: { id: parseInt(id), schoolId }, data: { isArchived: false, archivedAt: null, status: "PENDING" } });
      return reply.send({ success: true, message: "Document restored." });
    }
  );

  // ─── DELETE /admin/financial-docs/:id ────────────────────
  app.delete("/admin/financial-docs/:id", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.financialDocument.deleteMany({ where: { id: parseInt(id), schoolId, status: { in: ["REJECTED"] } } });
      return reply.send({ success: true });
    }
  );

  // ─── POST /admin/financial-docs/bulk-upload ───────────────
  app.post("/admin/financial-docs/bulk-upload", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { docs } = req.body as { docs: { name: string; category: string; fileUrl: string; fileType?: string; description?: string; expiryDate?: string; relatedStaffId?: number; tags?: string[] }[] };
      if (!docs?.length) return reply.status(400).send({ success: false, message: "docs array required." });
      let created = 0;
      for (const d of docs) {
        const docNo = await genDocNo(schoolId);
        await prisma.financialDocument.create({ data: { schoolId, uploadedById: userId, docNo, name: d.name, category: d.category as any ?? "OTHER", fileUrl: d.fileUrl, fileType: d.fileType ?? "PDF", description: d.description ?? null, expiryDate: d.expiryDate ? new Date(d.expiryDate) : null, relatedStaffId: d.relatedStaffId ?? null, tags: d.tags ?? [], status: "PENDING" } });
        created++;
      }
      return reply.send({ success: true, message: `${created} documents uploaded.`, data: { created } });
    }
  );

  // ─── GET /admin/financial-docs/expiry-report ─────────────
  app.get("/admin/financial-docs/expiry-report", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const [expired, expiring30, expiring90] = await Promise.all([
        prisma.financialDocument.findMany({ where: { schoolId, isArchived: false, expiryDate: { lt: now } }, include: { relatedStaff: { include: { user: { select: { name: true } } } } }, orderBy: { expiryDate: "asc" } }),
        prisma.financialDocument.findMany({ where: { schoolId, isArchived: false, expiryDate: { gte: now, lte: new Date(now.getTime() + 30*24*3600*1000) } }, include: { relatedStaff: { include: { user: { select: { name: true } } } } }, orderBy: { expiryDate: "asc" } }),
        prisma.financialDocument.findMany({ where: { schoolId, isArchived: false, expiryDate: { gte: new Date(now.getTime() + 30*24*3600*1000), lte: new Date(now.getTime() + 90*24*3600*1000) } }, orderBy: { expiryDate: "asc" } }),
      ]);
      return reply.send({ success: true, data: { expired, expiring30, expiring90 } });
    }
  );

  // ─── GET /admin/financial-docs/reports ───────────────────
  app.get("/admin/financial-docs/reports", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string };
      const where: any = { schoolId };
      if (q.from || q.to) { where.createdAt = {}; if (q.from) where.createdAt.gte = new Date(q.from); if (q.to) where.createdAt.lte = new Date(q.to); }

      const [byCategory, byStatus, byFileType, recent] = await Promise.all([
        prisma.financialDocument.groupBy({ by: ["category"], where, _count: true }),
        prisma.financialDocument.groupBy({ by: ["status"],   where, _count: true }),
        prisma.financialDocument.groupBy({ by: ["fileType"], where, _count: true }),
        prisma.financialDocument.findMany({ where, orderBy: { createdAt: "desc" }, take: 5, include: { uploadedBy: { select: { name: true } } } }),
      ]);

      return reply.send({ success: true, data: {
        byCategory: byCategory.map(b => ({ category: b.category, count: b._count })).sort((a, b) => b.count - a.count),
        byStatus:   byStatus.map(b => ({ status: b.status, count: b._count })),
        byFileType: byFileType.map(b => ({ type: b.fileType, count: b._count })),
        recent,
      }});
    }
  );
}
