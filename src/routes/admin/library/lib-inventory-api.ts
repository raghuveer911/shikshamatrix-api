// apps/api/src/routes/admin/library/lib-inventory-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ── Log helper ───────────────────────────────────────────────
async function logInventory(
  schoolId: number, copyId: number, action: string,
  oldVal?: string, newVal?: string, note?: string, userId?: number
) {
  await prisma.libInventoryLog.create({
    data: { schoolId, copyId, action: action as any, oldValue: oldVal ?? null, newValue: newVal ?? null, note: note ?? null, userId: userId ?? null },
  });
}

export async function adminLibInventoryRoutes(app: FastifyInstance) {
  const P = "/admin/library/inventory";

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [totalCopies, available, issued, lost, damaged, underRepair,
             totalBooks, pendingProcurement] = await Promise.all([
        prisma.libBookCopy.count({ where: { schoolId } }),
        prisma.libBookCopy.count({ where: { schoolId, status: "AVAILABLE" } }),
        prisma.libBookCopy.count({ where: { schoolId, status: "ISSUED"    } }),
        prisma.libBookCopy.count({ where: { schoolId, status: "LOST"      } }),
        prisma.libBookCopy.count({ where: { schoolId, status: "DAMAGED"   } }),
        prisma.libBookCopy.count({ where: { schoolId, status: "UNDER_REPAIR" } }),
        prisma.libBook.count({ where: { schoolId, isActive: true } }),
        prisma.libProcurementRequest.count({ where: { schoolId, status: { in: ["SUBMITTED","APPROVED","ORDERED"] } } }),
      ]);

      // Books with low stock (only 1 copy)
      const lowStock = await prisma.libBook.findMany({
        where: {
          schoolId, isActive: true,
          copies: { every: { status: { notIn: ["AVAILABLE"] } } },
        },
        include: {
          category: { select: { name: true, color: true } },
          _count: { select: { copies: true } },
        },
        take: 8,
      });

      // Recent inventory changes
      const recentChanges = await prisma.libInventoryLog.findMany({
        where: { schoolId },
        include: { copy: { include: { book: { select: { title: true } } } } },
        orderBy: { createdAt: "desc" },
        take: 10,
      });

      // Lost books recent
      const recentLost = await prisma.libBookCopy.findMany({
        where: { schoolId, status: "LOST" },
        include: { book: { select: { title: true, isbn: true } } },
        orderBy: { lostAt: "desc" },
        take: 5,
      });

      return rep.send({
        kpis: { totalCopies, available, issued, lost, damaged, underRepair, totalBooks, pendingProcurement },
        lowStock, recentChanges, recentLost,
      });
    }
  );

  // ─── STOCK MONITORING ─────────────────────────────────────
  app.get(`${P}/stock`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 30);

      const where: any = { schoolId, isActive: true };
      if (q.categoryId) where.categoryId = Number(q.categoryId);
      if (q.search)     where.title = { contains: q.search, mode: "insensitive" };

      const [books, total] = await Promise.all([
        prisma.libBook.findMany({
          where,
          include: {
            category: { select: { name: true, color: true } },
            author:   { select: { name: true } },
            _count:   { select: { copies: true } },
          },
          orderBy: { title: "asc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.libBook.count({ where }),
      ]);

      // Enrich with copy status breakdown
      const enriched = await Promise.all(books.map(async b => {
        const byStatus = await prisma.libBookCopy.groupBy({
          by: ["status"],
          where: { bookId: b.id },
          _count: { id: true },
        });
        const statusMap: Record<string, number> = {};
        byStatus.forEach(s => { statusMap[s.status] = s._count.id; });
        return { ...b, statusMap };
      }));

      return rep.send({ books: enriched, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── ASSET TRACKING — all copies with full detail ─────────
  app.get(`${P}/assets`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId };
      if (q.status)   where.status   = q.status;
      if (q.bookId)   where.bookId   = Number(q.bookId);
      if (q.location) where.location = { contains: q.location, mode: "insensitive" };
      if (q.search)   where.OR = [
        { copyCode: { contains: q.search, mode: "insensitive" } },
        { barcode:  { contains: q.search, mode: "insensitive" } },
        { book: { title: { contains: q.search, mode: "insensitive" } } },
      ];

      const [copies, total] = await Promise.all([
        prisma.libBookCopy.findMany({
          where,
          include: {
            book: { select: { id: true, title: true, isbn: true, category: { select: { name: true, color: true } } } },
            issues: { where: { status: { in: ["ACTIVE","OVERDUE"] } }, take: 1,
              include: { student: { include: { user: { select: { name: true } } } } },
            },
          },
          orderBy: { copyCode: "asc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.libBookCopy.count({ where }),
      ]);

      return rep.send({ copies, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── UPDATE COPY STATUS (with log) ────────────────────────
  app.put(`${P}/assets/:copyId`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const copyId = Number((req.params as any).copyId);
      const b = req.body as any;

      const existing = await prisma.libBookCopy.findFirst({ where: { id: copyId, schoolId } });
      if (!existing) return rep.code(404).send({ error: "Copy not found" });

      const copy = await prisma.libBookCopy.update({
        where: { id: copyId },
        data: {
          status:    b.status as any ?? undefined,
          condition: b.condition ?? undefined,
          location:  b.location ?? undefined,
          barcode:   b.barcode  ?? undefined,
          notes:     b.notes    ?? undefined,
          lostAt:    b.status === "LOST"    ? new Date() : undefined,
          damagedAt: b.status === "DAMAGED" ? new Date() : undefined,
        },
      });

      // Determine action
      const action = b.status === "LOST"    ? "LOST_REPORTED"
        : b.status === "DAMAGED" ? "DAMAGE_REPORTED"
        : b.status === "AVAILABLE" && existing.status !== "AVAILABLE" ? "REPAIRED"
        : b.barcode && !existing.barcode ? "BARCODE_ASSIGNED"
        : b.location !== existing.location ? "LOCATION_CHANGED"
        : "STATUS_CHANGED";

      await logInventory(schoolId, copyId, action, existing.status, copy.status, b.notes, Number(userId));

      return rep.send({ copy });
    }
  );

  // ─── LOST BOOKS ───────────────────────────────────────────
  app.get(`${P}/lost`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const copies = await prisma.libBookCopy.findMany({
        where: { schoolId, status: "LOST" },
        include: {
          book: { select: { title: true, isbn: true, costPrice: true, category: { select: { name: true } } } },
          issues: {
            orderBy: { issueDate: "desc" }, take: 1,
            include: { student: { include: { user: { select: { name: true } } } } },
          },
        },
        orderBy: { lostAt: "desc" },
      });
      return rep.send({ copies, total: copies.length });
    }
  );

  // Mark lost copy as found/recovered
  app.post(`${P}/lost/:copyId/recover`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const copyId = Number((req.params as any).copyId);
      const copy = await prisma.libBookCopy.update({
        where: { id: copyId, schoolId },
        data: { status: "AVAILABLE", lostAt: null, notes: (req.body as any).notes ?? null },
      });
      await logInventory(schoolId, copyId, "FOUND_ELSEWHERE" as any, "LOST", "AVAILABLE", "Recovered", Number(userId));
      return rep.send({ copy });
    }
  );

  // ─── DAMAGED BOOKS ────────────────────────────────────────
  app.get(`${P}/damaged`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const copies = await prisma.libBookCopy.findMany({
        where: { schoolId, status: "DAMAGED" },
        include: {
          book: { select: { title: true, isbn: true, costPrice: true } },
        },
        orderBy: { damagedAt: "desc" },
      });
      return rep.send({ copies, total: copies.length });
    }
  );

  // ─── PROCUREMENT REQUESTS ─────────────────────────────────
  app.get(`${P}/procurement`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const where: any = { schoolId };
      if (q.status) where.status = q.status;

      const requests = await prisma.libProcurementRequest.findMany({
        where,
        include: { book: { select: { id: true, title: true, isbn: true, _count: { select: { copies: true } } } } },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        take: Number(q.limit ?? 50),
      });
      return rep.send({ requests });
    }
  );

  app.post(`${P}/procurement`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const req_ = await prisma.libProcurementRequest.create({
        data: {
          schoolId,
          bookId:         b.bookId         ? Number(b.bookId)         : null,
          bookTitle:      b.bookTitle       ?? b.book?.title ?? "Unknown",
          isbn:           b.isbn            ?? null,
          authorName:     b.authorName      ?? null,
          publisherName:  b.publisherName   ?? null,
          categoryId:     b.categoryId      ? Number(b.categoryId)     : null,
          copiesRequested: Number(b.copiesRequested ?? 1),
          estimatedCost:  b.estimatedCost   ? Number(b.estimatedCost)  : null,
          reason:         b.reason          ?? null,
          priority:       b.priority        ?? "NORMAL",
          status:         "SUBMITTED",
          requestedById:  Number(userId),
        },
      });
      return rep.code(201).send({ request: req_ });
    }
  );

  app.put(`${P}/procurement/:id`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const data: any = { status: b.status as any };
      if (b.status === "APPROVED")  { data.approvedById = Number(userId); data.approvedAt = new Date(); }
      if (b.status === "ORDERED")   { data.orderedAt = new Date(); data.vendorName = b.vendorName ?? null; data.purchaseOrderNo = b.purchaseOrderNo ?? null; data.actualCost = b.actualCost ? Number(b.actualCost) : undefined; }
      if (b.status === "RECEIVED")  { data.receivedAt = new Date(); data.copiesReceived = Number(b.copiesReceived ?? 0); }
      if (b.status === "REJECTED")  { data.rejectionNote = b.rejectionNote ?? null; }
      if (b.notes) data.notes = b.notes;

      const req_ = await prisma.libProcurementRequest.update({ where: { id, schoolId }, data });
      return rep.send({ request: req_ });
    }
  );

  // ─── STOCK VERIFICATION SESSIONS ─────────────────────────
  app.get(`${P}/verification`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const sessions = await prisma.libStockVerification.findMany({
        where: { schoolId },
        include: { _count: { select: { items: true } } },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      return rep.send({ sessions });
    }
  );

  app.post(`${P}/verification`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const session = await prisma.libStockVerification.create({
        data: { schoolId, title: b.title, description: b.description ?? null, conductedById: Number(userId) },
      });
      return rep.code(201).send({ session });
    }
  );

  app.post(`${P}/verification/:sessionId/scan`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const sessionId = Number((req.params as any).sessionId);
      const b = req.body as any; // {copyCode, status, notes}

      const copy = await prisma.libBookCopy.findFirst({
        where: { schoolId, OR: [{ copyCode: b.copyCode }, { barcode: b.copyCode }] },
      });
      if (!copy) return rep.code(404).send({ error: `Copy not found: ${b.copyCode}` });

      const item = await prisma.libStockVerificationItem.upsert({
        where: { verificationId_copyId: { verificationId: sessionId, copyId: copy.id } },
        create: { verificationId: sessionId, copyId: copy.id, status: b.status as any ?? "VERIFIED", notes: b.notes ?? null, checkedById: Number(userId) },
        update: { status: b.status as any ?? "VERIFIED", notes: b.notes ?? null, checkedAt: new Date() },
      });

      return rep.send({ item, copy });
    }
  );

  app.post(`${P}/verification/:sessionId/complete`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const sessionId = Number((req.params as any).sessionId);

      const items = await prisma.libStockVerificationItem.findMany({ where: { verificationId: sessionId } });
      const totalVerified = items.filter(i => i.status === "VERIFIED").length;
      const totalMissing  = items.filter(i => i.status === "MISSING").length;
      const totalDamaged  = items.filter(i => i.status === "DAMAGED").length;

      const session = await prisma.libStockVerification.update({
        where: { id: sessionId, schoolId },
        data: { isComplete: true, completedAt: new Date(), totalChecked: items.length, totalVerified, totalMissing, totalDamaged },
      });
      return rep.send({ session });
    }
  );

  // ─── AUDIT LOGS ───────────────────────────────────────────
  app.get(`${P}/audit-logs`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId };
      if (q.action) where.action = q.action;
      if (q.copyId) where.copyId = Number(q.copyId);

      const [logs, total] = await Promise.all([
        prisma.libInventoryLog.findMany({
          where,
          include: { copy: { include: { book: { select: { title: true } } } } },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.libInventoryLog.count({ where }),
      ]);

      return rep.send({ logs, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── REPORTS ──────────────────────────────────────────────
  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('library.inventoryTracking')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [byStatus, byCondition, lostValue, procByStatus] = await Promise.all([
        prisma.libBookCopy.groupBy({ by: ["status"], where: { schoolId }, _count: { id: true } }),
        prisma.libBookCopy.groupBy({ by: ["condition"], where: { schoolId }, _count: { id: true } }),
        prisma.libBook.aggregate({
          where: { schoolId, copies: { some: { status: "LOST" } } },
          _sum: { costPrice: true },
        }),
        prisma.libProcurementRequest.groupBy({ by: ["status"], where: { schoolId }, _count: { id: true } }),
      ]);

      return rep.send({
        byStatus, byCondition,
        lostValue: Number(lostValue._sum.costPrice ?? 0),
        procByStatus,
      });
    }
  );
}
