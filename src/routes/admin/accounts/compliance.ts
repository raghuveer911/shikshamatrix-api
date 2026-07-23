// apps/api/src/routes/admin/compliance.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

function getNextDueDate(current: Date, frequency: string): Date | null {
  const next = new Date(current);
  switch (frequency) {
    case "MONTHLY":      next.setMonth(next.getMonth() + 1);     break;
    case "QUARTERLY":    next.setMonth(next.getMonth() + 3);     break;
    case "HALF_YEARLY":  next.setMonth(next.getMonth() + 6);     break;
    case "YEARLY":       next.setFullYear(next.getFullYear() + 1); break;
    case "ONE_TIME":     return null;
    default:             return null;
  }
  return next;
}

export async function adminComplianceRoutes(app: FastifyInstance) {

  // ─── GET /admin/compliance/dashboard ─────────────────────
  app.get("/admin/compliance/dashboard", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now   = new Date();
      const month = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const soon  = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

      const [total, dueThisMonth, overdue, byType, byStatus, expiring, upcomingCalendar] = await Promise.all([
        prisma.complianceItem.count({ where: { schoolId, isActive: true } }),
        prisma.complianceItem.count({ where: { schoolId, isActive: true, dueDate: { lte: month, gte: now }, status: { notIn: ["COMPLETED","WAIVED"] } } }),
        prisma.complianceItem.count({ where: { schoolId, isActive: true, dueDate: { lt: now }, status: { notIn: ["COMPLETED","WAIVED"] } } }),
        prisma.complianceItem.groupBy({ by: ["type"],   where: { schoolId, isActive: true }, _count: true }),
        prisma.complianceItem.groupBy({ by: ["status"], where: { schoolId, isActive: true }, _count: true }),
        prisma.complianceItem.findMany({ where: { schoolId, isActive: true, dueDate: { gte: now, lte: soon }, status: { notIn: ["COMPLETED","WAIVED"] } }, orderBy: { dueDate: "asc" }, take: 10 }),
        // Next 60 days calendar
        prisma.complianceItem.findMany({ where: { schoolId, isActive: true, dueDate: { gte: now, lte: new Date(now.getTime() + 60*24*3600*1000) } }, orderBy: { dueDate: "asc" } }),
      ]);

      return reply.send({ success: true, data: {
        kpi: { total, dueThisMonth, overdue, expiringSoon: expiring.length, completed: (byStatus.find(s => s.status === "COMPLETED")?._count) ?? 0 },
        byType:   byType.map(b => ({ type: b.type, count: b._count })).sort((a,b) => b.count-a.count),
        byStatus: byStatus.map(b => ({ status: b.status, count: b._count })),
        expiring, upcomingCalendar,
      }});
    }
  );

  // ─── GET /admin/compliance ────────────────────────────────
  app.get("/admin/compliance", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; type?: string; status?: string; overdue?: string; search?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const now = new Date();
      const where: any = { schoolId, isActive: true };
      if (q.type)   where.type   = q.type;
      if (q.status) where.status = q.status;
      if (q.overdue === "true") { where.dueDate = { lt: now }; where.status = { notIn: ["COMPLETED","WAIVED"] }; }
      if (q.search) where.OR = [
        { title: { contains: q.search, mode: "insensitive" } },
        { description: { contains: q.search, mode: "insensitive" } },
        { gstNumber: { contains: q.search, mode: "insensitive" } },
        { tanNumber: { contains: q.search, mode: "insensitive" } },
      ];
      const [items, total] = await Promise.all([
        prisma.complianceItem.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: [{ status: "asc" },{ dueDate: "asc" }],
          include: { assignedTo: { select: { name: true } }, completedBy: { select: { name: true } }, createdBy: { select: { name: true } } } }),
        prisma.complianceItem.count({ where }),
      ]);
      const enriched = items.map(item => ({
        ...item,
        isOverdue: new Date(item.dueDate) < now && !["COMPLETED","WAIVED"].includes(item.status),
        daysUntilDue: Math.floor((new Date(item.dueDate).getTime() - now.getTime()) / 86400000),
      }));
      return reply.send({ success: true, data: { items: enriched, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── GET /admin/compliance/:id ────────────────────────────
  app.get("/admin/compliance/:id", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const item = await prisma.complianceItem.findFirst({ where: { id: parseInt(id), schoolId },
        include: { assignedTo: { select: { name: true } }, completedBy: { select: { name: true } }, alerts: true } });
      if (!item) return reply.status(404).send({ success: false, message: "Not found." });
      return reply.send({ success: true, data: { item } });
    }
  );

  // ─── POST /admin/compliance ───────────────────────────────
  app.post("/admin/compliance", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { title: string; description?: string; type: string; frequency: string; dueDate: string; gstNumber?: string; tanNumber?: string; vendorId?: number; contractExpiry?: string; assignedToId?: number; notes?: string; alertDays?: number[] };
      if (!body.title || !body.dueDate) return reply.status(400).send({ success: false, message: "title and dueDate required." });

      const item = await prisma.complianceItem.create({ data: {
        schoolId, createdById: userId,
        title: body.title.trim(), description: body.description ?? null, type: body.type as any ?? "OTHER",
        frequency: body.frequency as any ?? "YEARLY", dueDate: new Date(body.dueDate),
        gstNumber: body.gstNumber ?? null, tanNumber: body.tanNumber ?? null,
        vendorId: body.vendorId ?? null, contractExpiry: body.contractExpiry ? new Date(body.contractExpiry) : null,
        assignedToId: body.assignedToId ?? null, notes: body.notes ?? null, status: "PENDING",
      }});

      // Create alerts
      const alertDays = body.alertDays ?? [30, 15, 7];
      if (alertDays.length) {
        await prisma.complianceAlert.createMany({ data: alertDays.map(d => ({ schoolId, complianceId: item.id, alertDaysBefore: d })) });
      }

      return reply.status(201).send({ success: true, data: { id: item.id } });
    }
  );

  // ─── PUT /admin/compliance/:id ────────────────────────────
  app.put("/admin/compliance/:id", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const data: any = {};
      ["title","description","type","frequency","dueDate","gstNumber","tanNumber","vendorId","contractExpiry","assignedToId","notes","isActive"].forEach(k => {
        if (body[k] !== undefined) data[k] = ["dueDate","contractExpiry"].includes(k) && body[k] ? new Date(body[k]) : body[k];
      });
      await prisma.complianceItem.updateMany({ where: { id: parseInt(id), schoolId }, data });
      return reply.send({ success: true });
    }
  );

  // ─── PATCH /admin/compliance/:id/complete ────────────────
  app.patch("/admin/compliance/:id/complete", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { notes, attachmentUrls } = req.body as { notes?: string; attachmentUrls?: string[] };

      const item = await prisma.complianceItem.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!item) return reply.status(404).send({ success: false, message: "Not found." });

      const nextDue = getNextDueDate(new Date(item.dueDate), item.frequency);
      await prisma.complianceItem.update({ where: { id: parseInt(id) }, data: {
        status: "COMPLETED", completedById: userId, completedDate: new Date(),
        nextDueDate: nextDue, notes: notes ?? item.notes,
        attachmentUrls: attachmentUrls?.length ? attachmentUrls : item.attachmentUrls,
      }});

      // Create next recurring item
      if (nextDue && item.frequency !== "ONE_TIME") {
        await prisma.complianceItem.create({ data: {
          schoolId, createdById: userId, title: item.title, description: item.description, type: item.type,
          frequency: item.frequency, dueDate: nextDue, gstNumber: item.gstNumber, tanNumber: item.tanNumber,
          assignedToId: item.assignedToId, notes: null, status: "PENDING",
        }});
      }

      return reply.send({ success: true, message: "Marked complete." + (nextDue ? ` Next due: ${nextDue.toLocaleDateString("en-IN")}` : "") });
    }
  );

  // ─── PATCH /admin/compliance/:id/waive ───────────────────
  app.patch("/admin/compliance/:id/waive", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };
      await prisma.complianceItem.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "WAIVED", notes: reason } });
      return reply.send({ success: true });
    }
  );

  // ─── DELETE /admin/compliance/:id ────────────────────────
  app.delete("/admin/compliance/:id", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.complianceItem.updateMany({ where: { id: parseInt(id), schoolId }, data: { isActive: false } });
      return reply.send({ success: true });
    }
  );

  // ─── GET /admin/compliance/calendar ──────────────────────
  app.get("/admin/compliance/calendar", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { year?: string; month?: string };
      const now = new Date();
      const y = parseInt(q.year ?? String(now.getFullYear()));
      const m = parseInt(q.month ?? String(now.getMonth() + 1));
      const start = new Date(y, m - 1, 1);
      const end   = new Date(y, m, 0, 23, 59, 59);
      const items = await prisma.complianceItem.findMany({ where: { schoolId, isActive: true, dueDate: { gte: start, lte: end } }, orderBy: { dueDate: "asc" } });
      // Group by day
      const byDay: Record<number, any[]> = {};
      items.forEach(item => { const d = new Date(item.dueDate).getDate(); if (!byDay[d]) byDay[d] = []; byDay[d].push(item); });
      return reply.send({ success: true, data: { items, byDay, year: y, month: m } });
    }
  );

  // ─── GET /admin/compliance/alerts ────────────────────────
  app.get("/admin/compliance/alerts", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const alerts7  = await prisma.complianceItem.findMany({ where: { schoolId, isActive: true, dueDate: { gte: now, lte: new Date(now.getTime()+7*86400*1000) }, status: { notIn: ["COMPLETED","WAIVED"] } }, orderBy: { dueDate: "asc" } });
      const alerts15 = await prisma.complianceItem.findMany({ where: { schoolId, isActive: true, dueDate: { gt: new Date(now.getTime()+7*86400*1000), lte: new Date(now.getTime()+15*86400*1000) }, status: { notIn: ["COMPLETED","WAIVED"] } }, orderBy: { dueDate: "asc" } });
      const alerts30 = await prisma.complianceItem.findMany({ where: { schoolId, isActive: true, dueDate: { gt: new Date(now.getTime()+15*86400*1000), lte: new Date(now.getTime()+30*86400*1000) }, status: { notIn: ["COMPLETED","WAIVED"] } }, orderBy: { dueDate: "asc" } });
      const overdue  = await prisma.complianceItem.findMany({ where: { schoolId, isActive: true, dueDate: { lt: now }, status: { notIn: ["COMPLETED","WAIVED"] } }, orderBy: { dueDate: "asc" } });
      return reply.send({ success: true, data: { overdue, alerts7, alerts15, alerts30, total: overdue.length + alerts7.length + alerts15.length + alerts30.length } });
    }
  );

  // ─── GET /admin/compliance/reports ───────────────────────
  app.get("/admin/compliance/reports", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [byType, byStatus, byFreq, recent] = await Promise.all([
        prisma.complianceItem.groupBy({ by: ["type"],      where: { schoolId, isActive: true }, _count: true }),
        prisma.complianceItem.groupBy({ by: ["status"],    where: { schoolId, isActive: true }, _count: true }),
        prisma.complianceItem.groupBy({ by: ["frequency"], where: { schoolId, isActive: true }, _count: true }),
        prisma.complianceItem.findMany({ where: { schoolId, isActive: true, status: "COMPLETED" }, orderBy: { completedDate: "desc" }, take: 10, include: { completedBy: { select: { name: true } } } }),
      ]);
      return reply.send({ success: true, data: {
        byType:   byType.map(b => ({ type: b.type, count: b._count })).sort((a,b) => b.count-a.count),
        byStatus: byStatus.map(b => ({ status: b.status, count: b._count })),
        byFreq:   byFreq.map(b => ({ freq: b.frequency, count: b._count })),
        recent,
      }});
    }
  );
}
