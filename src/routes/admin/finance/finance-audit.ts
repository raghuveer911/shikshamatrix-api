// apps/api/src/routes/admin/finance-audit.ts
// Finance & Fees — Audit Logs Module

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ─── HELPER: Create audit log entry ─────────────────────────
// Call this from other route files when finance actions happen
export async function createFinanceAuditLog(data: {
  schoolId: number; userId?: number; userRole?: string; ipAddress?: string;
  module: string; action: string; entityType: string; entityId?: number;
  studentId?: number; studentName?: string; description: string;
  beforeValue?: any; afterValue?: any; amount?: number; receiptNo?: string;
  isSuspicious?: boolean; riskScore?: number; riskReason?: string;
}) {
  try {
    await prisma.financeAuditLog.create({ data: {
      schoolId: data.schoolId, userId: data.userId ?? null,
      userRole: data.userRole ?? null, ipAddress: data.ipAddress ?? null,
      module: data.module as any, action: data.action as any,
      entityType: data.entityType, entityId: data.entityId ?? null,
      studentId: data.studentId ?? null, studentName: data.studentName ?? null,
      description: data.description,
      beforeValue: data.beforeValue ?? undefined,
      afterValue: data.afterValue ?? undefined,
      amount: data.amount ?? null, receiptNo: data.receiptNo ?? null,
      isSuspicious: data.isSuspicious ?? false,
      riskScore: data.riskScore ?? 0, riskReason: data.riskReason ?? null,
    }});
  } catch {} // never break main flow
}

export async function adminFinanceAuditRoutes(app: FastifyInstance) {

  // ─── DASHBOARD ─────────────────────────────────────────────
  app.get("/admin/finance-audit/dashboard", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const [total, todayLogs, suspicious, byModule, byAction, recentLogs, trending] = await Promise.all([
        prisma.financeAuditLog.count({ where: { schoolId } }),
        prisma.financeAuditLog.count({ where: { schoolId, createdAt: { gte: todayStart } } }),
        prisma.financeAuditLog.count({ where: { schoolId, isSuspicious: true } }),

        prisma.financeAuditLog.groupBy({ by: ["module"], where: { schoolId, createdAt: { gte: monthStart } }, _count: true, orderBy: { _count: { module: "desc" } } }),

        prisma.financeAuditLog.groupBy({ by: ["action"], where: { schoolId, createdAt: { gte: monthStart } }, _count: true, orderBy: { _count: { action: "desc" } }, take: 8 }),

        prisma.financeAuditLog.findMany({ where: { schoolId }, orderBy: { createdAt: "desc" }, take: 10, include: { user: { select: { name: true } } } }),

        // Daily trend last 7 days
        Promise.all(Array.from({length:7},(_,i) => {
          const d = new Date(todayStart); d.setDate(d.getDate() - (6-i));
          const d2 = new Date(d); d2.setDate(d2.getDate() + 1);
          return prisma.financeAuditLog.count({ where: { schoolId, createdAt: { gte: d, lt: d2 } } })
            .then(count => ({ day: d.toLocaleDateString("en-IN",{day:"2-digit",month:"short"}), count }));
        })),
      ]);

      const collections = await prisma.financeAuditLog.aggregate({ where: { schoolId, action: "FEE_COLLECTED" }, _count: true, _sum: { amount: true } });
      const refunds = await prisma.financeAuditLog.count({ where: { schoolId, action: "REFUND_PROCESSED" } });
      const discounts = await prisma.financeAuditLog.count({ where: { schoolId, action: { in: ["DISCOUNT_APPLIED","SCHOLARSHIP_ASSIGNED"] } } });

      return reply.send({ success: true, data: {
        kpi: { totalActivities: total, todayActivities: todayLogs, suspicious, collections: collections._count, collectionsAmount: Number(collections._sum.amount ?? 0), refunds, discounts },
        byModule: byModule.map(m => ({ module: m.module, count: m._count })),
        byAction: byAction.map(a => ({ action: a.action, count: a._count })),
        recentLogs, trending,
      }});
    }
  );

  // ─── ACTIVITY LOGS (main feed) ─────────────────────────────
  app.get("/admin/finance-audit/activity", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; module?: string; action?: string; userId?: string; studentId?: string; from?: string; to?: string; isSuspicious?: string; search?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 30;
      const where: any = { schoolId };
      if (q.module)      where.module      = q.module;
      if (q.action)      where.action      = q.action;
      if (q.userId)      where.userId      = parseInt(q.userId);
      if (q.studentId)   where.studentId   = parseInt(q.studentId);
      if (q.isSuspicious === "true") where.isSuspicious = true;
      if (q.from || q.to) { where.createdAt = {}; if (q.from) where.createdAt.gte = new Date(q.from); if (q.to) where.createdAt.lte = new Date(q.to); }
      if (q.search) where.OR = [
        { description:   { contains: q.search, mode: "insensitive" } },
        { studentName:   { contains: q.search, mode: "insensitive" } },
        { receiptNo:     { contains: q.search, mode: "insensitive" } },
        { user: { name:  { contains: q.search, mode: "insensitive" } } },
      ];
      const [logs, total] = await Promise.all([
        prisma.financeAuditLog.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" }, include: { user: { select: { name: true } } } }),
        prisma.financeAuditLog.count({ where }),
      ]);
      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── COLLECTION LOGS ───────────────────────────────────────
  app.get("/admin/finance-audit/collections", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; from?: string; to?: string; userId?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      const where: any = { schoolId, action: { in: ["FEE_COLLECTED","RECEIPT_GENERATED","RECEIPT_REPRINTED","RECEIPT_VOIDED"] } };
      if (q.userId) where.userId = parseInt(q.userId);
      if (q.from || q.to) { where.createdAt = {}; if (q.from) where.createdAt.gte = new Date(q.from); if (q.to) where.createdAt.lte = new Date(q.to); }
      const [logs, total, totalAmount] = await Promise.all([
        prisma.financeAuditLog.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" }, include: { user: { select: { name: true } } } }),
        prisma.financeAuditLog.count({ where }),
        prisma.financeAuditLog.aggregate({ where: { ...where, action: "FEE_COLLECTED" }, _sum: { amount: true } }),
      ]);
      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/limit), totalAmount: Number(totalAmount._sum.amount ?? 0) } });
    }
  );

  // ─── FEE CHANGE LOGS ───────────────────────────────────────
  app.get("/admin/finance-audit/fee-changes", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; from?: string; to?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      const where: any = { schoolId, action: { in: ["FEE_AMOUNT_REVISED","FEE_PLAN_UPDATED","FEE_HEAD_ADDED","FEE_HEAD_REMOVED","SETTINGS_CHANGED"] } };
      if (q.from || q.to) { where.createdAt = {}; if (q.from) where.createdAt.gte = new Date(q.from); if (q.to) where.createdAt.lte = new Date(q.to); }
      const [logs, total] = await Promise.all([
        prisma.financeAuditLog.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" }, include: { user: { select: { name: true } } } }),
        prisma.financeAuditLog.count({ where }),
      ]);
      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── APPROVAL LOGS ─────────────────────────────────────────
  app.get("/admin/finance-audit/approvals", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; from?: string; to?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      const where: any = { schoolId, action: { in: ["SCHOLARSHIP_APPROVED","SCHOLARSHIP_REJECTED","DUE_WAIVER_APPROVED","DUE_WAIVER_REJECTED","REFUND_APPROVED","REFUND_REJECTED","ADJUSTMENT_APPLIED"] } };
      if (q.from || q.to) { where.createdAt = {}; if (q.from) where.createdAt.gte = new Date(q.from); if (q.to) where.createdAt.lte = new Date(q.to); }
      const [logs, total] = await Promise.all([
        prisma.financeAuditLog.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" }, include: { user: { select: { name: true } } } }),
        prisma.financeAuditLog.count({ where }),
      ]);
      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── REFUND LOGS ───────────────────────────────────────────
  app.get("/admin/finance-audit/refunds", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; from?: string; to?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      const where: any = { schoolId, action: { in: ["REFUND_REQUESTED","REFUND_APPROVED","REFUND_PROCESSED","REFUND_REJECTED"] } };
      if (q.from || q.to) { where.createdAt = {}; if (q.from) where.createdAt.gte = new Date(q.from); if (q.to) where.createdAt.lte = new Date(q.to); }
      const [logs, total, refundTotal] = await Promise.all([
        prisma.financeAuditLog.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" }, include: { user: { select: { name: true } } } }),
        prisma.financeAuditLog.count({ where }),
        prisma.financeAuditLog.aggregate({ where: { ...where, action: "REFUND_PROCESSED" }, _sum: { amount: true } }),
      ]);
      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/limit), totalRefunded: Number(refundTotal._sum.amount ?? 0) } });
    }
  );

  // ─── SECURITY LOGS ─────────────────────────────────────────
  app.get("/admin/finance-audit/security", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; from?: string; to?: string; isSuspicious?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      const where: any = { schoolId, action: { in: ["BULK_OPERATION_EXECUTED","SETTINGS_CHANGED","SESSION_LOCKED","SESSION_CLOSED","RECEIPT_VOIDED"] } };
      if (q.isSuspicious === "true") where.isSuspicious = true;
      if (q.from || q.to) { where.createdAt = {}; if (q.from) where.createdAt.gte = new Date(q.from); if (q.to) where.createdAt.lte = new Date(q.to); }
      const [logs, total] = await Promise.all([
        prisma.financeAuditLog.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" }, include: { user: { select: { name: true } } } }),
        prisma.financeAuditLog.count({ where }),
      ]);
      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── INVESTIGATION CENTER ──────────────────────────────────
  // Full-text search + user-centric investigation
  app.get("/admin/finance-audit/investigate", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { userId?: string; studentId?: string; from?: string; to?: string; receiptNo?: string; action?: string };
      if (!q.userId && !q.studentId && !q.receiptNo) return reply.status(400).send({ success: false, message: "Provide userId, studentId, or receiptNo to investigate." });
      const where: any = { schoolId };
      if (q.userId)    where.userId    = parseInt(q.userId);
      if (q.studentId) where.studentId = parseInt(q.studentId);
      if (q.receiptNo) where.receiptNo = { contains: q.receiptNo, mode: "insensitive" };
      if (q.action)    where.action    = q.action;
      if (q.from || q.to) { where.createdAt = {}; if (q.from) where.createdAt.gte = new Date(q.from); if (q.to) where.createdAt.lte = new Date(q.to); }

      const [logs, byAction, user] = await Promise.all([
        prisma.financeAuditLog.findMany({ where, orderBy: { createdAt: "asc" }, take: 200, include: { user: { select: { name: true, role: true } } } }),
        prisma.financeAuditLog.groupBy({ by: ["action"], where, _count: true, orderBy: { _count: { action: "desc" } } }),
        q.userId ? prisma.user.findUnique({ where: { id: parseInt(q.userId) }, select: { name: true, role: true, email: true } }) : null,
        q.studentId ? prisma.student.findFirst({ where: { id: parseInt(q.studentId), schoolId }, include: { user: { select: { name: true } }, class: { select: { name: true } } } }) : null,
      ]);

      return reply.send({ success: true, data: {
        logs, byAction: byAction.map(a => ({ action: a.action, count: a._count })),
        subject: user, totalLogs: logs.length, suspiciousLogs: logs.filter(l => l.isSuspicious).length,
        timeline: logs.map(l => ({ time: l.createdAt, action: l.action, description: l.description, amount: l.amount ? Number(l.amount) : null })),
      }});
    }
  );

  // ─── SUSPICIOUS LOGS ───────────────────────────────────────
  app.get("/admin/finance-audit/suspicious", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const logs = await prisma.financeAuditLog.findMany({ where: { schoolId, isSuspicious: true }, orderBy: { createdAt: "desc" }, take: 50, include: { user: { select: { name: true } } } });
      return reply.send({ success: true, data: { logs, count: logs.length } });
    }
  );

  // ─── REPORTS ───────────────────────────────────────────────
  app.get("/admin/finance-audit/reports", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string; type?: string };
      const from = q.from ? new Date(q.from) : new Date(new Date().setMonth(new Date().getMonth() - 1));
      const to   = q.to   ? new Date(q.to)   : new Date();
      const where: any = { schoolId, createdAt: { gte: from, lte: to } };
      if (q.type) where.module = q.type;

      const [byUser, byModule, byAction, daily, suspicious] = await Promise.all([
        prisma.financeAuditLog.groupBy({ by: ["userId"], where, _count: true, orderBy: { _count: { userId: "desc" } }, take: 10 }).then(async r => {
          const uids = r.map(x => x.userId).filter(Boolean) as number[];
          const users = await prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, name: true } });
          return r.map(x => ({ userId: x.userId, count: x._count, name: users.find(u => u.id === x.userId)?.name ?? "System" }));
        }),
        prisma.financeAuditLog.groupBy({ by: ["module"], where, _count: true, orderBy: { _count: { module: "desc" } } }),
        prisma.financeAuditLog.groupBy({ by: ["action"], where, _count: true, orderBy: { _count: { action: "desc" } }, take: 12 }),
        Promise.all(Array.from({length:30},(_,i) => {
          const d = new Date(from); d.setDate(d.getDate() + i); if (d > to) return Promise.resolve(null);
          const d2 = new Date(d); d2.setDate(d2.getDate() + 1);
          return prisma.financeAuditLog.count({ where: { schoolId, createdAt: { gte: d, lt: d2 } } })
            .then(c => ({ day: d.toLocaleDateString("en-IN",{day:"2-digit",month:"short"}), count: c }));
        })).then(r => r.filter(Boolean)),
        prisma.financeAuditLog.count({ where: { ...where, isSuspicious: true } }),
      ]);

      return reply.send({ success: true, data: { byUser, byModule: byModule.map(m => ({ module: m.module, count: m._count })), byAction: byAction.map(a => ({ action: a.action, count: a._count })), daily, suspicious } });
    }
  );

  // ─── WRITE AUDIT LOG (internal API, restricted) ────────────
  app.post("/admin/finance-audit/log", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId, role } = req.user as any;
      const body = req.body as { module: string; action: string; entityType: string; entityId?: number; studentId?: number; studentName?: string; description: string; beforeValue?: any; afterValue?: any; amount?: number; receiptNo?: string };
      await createFinanceAuditLog({ schoolId, userId, userRole: role, module: body.module, action: body.action, entityType: body.entityType, entityId: body.entityId, studentId: body.studentId, studentName: body.studentName, description: body.description, beforeValue: body.beforeValue, afterValue: body.afterValue, amount: body.amount, receiptNo: body.receiptNo });
      return reply.send({ success: true });
    }
  );
}
