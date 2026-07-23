// apps/api/src/routes/admin/audit-logs.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ── Helper: create audit log from anywhere in the app ─────────
export async function createAuditLog(data: {
  schoolId: number; userId: number; module: string; actionType: string;
  action: string; entityId?: number; entityType?: string; entityLabel?: string;
  beforeValue?: any; afterValue?: any; changeReason?: string;
  ipAddress?: string; userAgent?: string; riskLevel?: number;
}) {
  try {
    await prisma.auditLog.create({ data: { ...data as any, occurredAt: new Date() } });
  } catch (_) { /* non-blocking */ }
}

export async function adminAuditLogRoutes(app: FastifyInstance) {

  // ─── GET /admin/audit-logs/dashboard ─────────────────────
  app.get("/admin/audit-logs/dashboard", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const dayAgo   = new Date(now.getTime() - 24 * 3600 * 1000);
      const weekAgo  = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      const monthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

      const [total, financial, approvals, suspicious, failedLogins, byModule, hourlyActivity, topUsers, recentSuspicious] = await Promise.all([
        prisma.auditLog.count({ where: { schoolId } }),
        prisma.auditLog.count({ where: { schoolId, module: { in: ["PAYROLL","SALARY","VENDOR","EXPENSE","LOAN","REIMBURSEMENT"] } } }),
        prisma.auditLog.count({ where: { schoolId, actionType: { in: ["APPROVE","REJECT","PAY","GENERATE"] } } }),
        prisma.auditLog.count({ where: { schoolId, isSuspicious: true } }),
        prisma.loginHistory.count({ where: { schoolId, isSuccess: false, loginAt: { gte: weekAgo } } }),
        prisma.auditLog.groupBy({ by: ["module"], where: { schoolId, occurredAt: { gte: monthAgo } }, _count: true }),
        // 24-hour activity (hourly buckets)
        prisma.$queryRaw<{ hour: number; count: bigint }[]>`
          SELECT EXTRACT(HOUR FROM "occurredAt") AS hour, COUNT(*) AS count
          FROM audit_logs
          WHERE "schoolId" = ${schoolId} AND "occurredAt" >= ${dayAgo}
          GROUP BY hour ORDER BY hour
        `.catch(() => []),
        prisma.auditLog.groupBy({ by: ["userId"], where: { schoolId, occurredAt: { gte: weekAgo } }, _count: true, orderBy: { _count: { userId: "desc" } }, take: 5 }),
        prisma.auditLog.findMany({ where: { schoolId, isSuspicious: true }, orderBy: { occurredAt: "desc" }, take: 5, include: { user: { select: { name: true } } } }),
      ]);

      // Resolve top users' names
      const topUserIds = topUsers.map(u => u.userId);
      const userNames = await prisma.user.findMany({ where: { id: { in: topUserIds } }, select: { id: true, name: true } });
      const nameMap: Record<number, string> = {};
      userNames.forEach(u => { nameMap[u.id] = u.name; });

      return reply.send({ success: true, data: {
        kpi: { total, financial, approvals, suspicious, failedLogins },
        byModule: byModule.map(b => ({ module: b.module, count: b._count })).sort((a,b) => b.count - a.count),
        hourlyActivity: Array.isArray(hourlyActivity) ? hourlyActivity.map((h: any) => ({ hour: Number(h.hour), count: Number(h.count) })) : [],
        topUsers: topUsers.map(u => ({ userId: u.userId, name: nameMap[u.userId] ?? "Unknown", actions: u._count })),
        recentSuspicious,
      }});
    }
  );

  // ─── GET /admin/audit-logs ────────────────────────────────
  app.get("/admin/audit-logs", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; module?: string; actionType?: string; userId?: string; riskLevel?: string; suspicious?: string; search?: string; from?: string; to?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 30;
      const where: any = { schoolId };
      if (q.module)     where.module     = q.module;
      if (q.actionType) where.actionType = q.actionType;
      if (q.userId)     where.userId     = parseInt(q.userId);
      if (q.riskLevel)  where.riskLevel  = parseInt(q.riskLevel);
      if (q.suspicious === "true") where.isSuspicious = true;
      if (q.from || q.to) { where.occurredAt = {}; if (q.from) where.occurredAt.gte = new Date(q.from); if (q.to) where.occurredAt.lte = new Date(q.to); }
      if (q.search) where.OR = [
        { action:      { contains: q.search, mode: "insensitive" } },
        { entityLabel: { contains: q.search, mode: "insensitive" } },
        { user: { name: { contains: q.search, mode: "insensitive" } } },
      ];
      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { occurredAt: "desc" }, include: { user: { select: { name: true, email: true } } } }),
        prisma.auditLog.count({ where }),
      ]);
      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── GET /admin/audit-logs/approval-logs ─────────────────
  app.get("/admin/audit-logs/approval-logs", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { module?: string; page?: string; from?: string; to?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      const where: any = { schoolId, actionType: { in: ["APPROVE","REJECT","PAY","GENERATE"] } };
      if (q.module) where.module = q.module;
      if (q.from || q.to) { where.occurredAt = {}; if (q.from) where.occurredAt.gte = new Date(q.from); if (q.to) where.occurredAt.lte = new Date(q.to); }
      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { occurredAt: "desc" }, include: { user: { select: { name: true } } } }),
        prisma.auditLog.count({ where }),
      ]);
      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── GET /admin/audit-logs/financial-changes ─────────────
  app.get("/admin/audit-logs/financial-changes", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; from?: string; to?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      const where: any = { schoolId, actionType: "UPDATE", module: { in: ["PAYROLL","SALARY","VENDOR","EXPENSE","LOAN","REIMBURSEMENT"] }, beforeValue: { not: null } };
      if (q.from || q.to) { where.occurredAt = {}; if (q.from) where.occurredAt.gte = new Date(q.from); if (q.to) where.occurredAt.lte = new Date(q.to); }
      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { occurredAt: "desc" }, include: { user: { select: { name: true } } } }),
        prisma.auditLog.count({ where }),
      ]);
      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── GET /admin/audit-logs/security ──────────────────────
  app.get("/admin/audit-logs/security", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; from?: string; to?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      const where: any = { schoolId, actionType: { in: ["LOGIN","LOGOUT","PASSWORD_CHANGE","PERMISSION_CHANGE"] } };
      if (q.from || q.to) { where.occurredAt = {}; if (q.from) where.occurredAt.gte = new Date(q.from); if (q.to) where.occurredAt.lte = new Date(q.to); }
      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { occurredAt: "desc" }, include: { user: { select: { name: true } } } }),
        prisma.auditLog.count({ where }),
      ]);
      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── GET /admin/audit-logs/login-history ─────────────────
  app.get("/admin/audit-logs/login-history", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; userId?: string; success?: string; from?: string; to?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 30;
      const where: any = { schoolId };
      if (q.userId)  where.userId    = parseInt(q.userId);
      if (q.success !== undefined) where.isSuccess = q.success === "true";
      if (q.from || q.to) { where.loginAt = {}; if (q.from) where.loginAt.gte = new Date(q.from); if (q.to) where.loginAt.lte = new Date(q.to); }
      const [logs, total] = await Promise.all([
        prisma.loginHistory.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { loginAt: "desc" }, include: { user: { select: { name: true } } } }),
        prisma.loginHistory.count({ where }),
      ]);
      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── GET /admin/audit-logs/investigate ───────────────────
  // Investigation: show full timeline for a user
  app.get("/admin/audit-logs/investigate", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { userId: string; from?: string; to?: string };
      if (!q.userId) return reply.status(400).send({ success: false, message: "userId required." });
      const where: any = { schoolId, userId: parseInt(q.userId) };
      if (q.from || q.to) { where.occurredAt = {}; if (q.from) where.occurredAt.gte = new Date(q.from); if (q.to) where.occurredAt.lte = new Date(q.to); }
      const [user, timeline, summary, loginHistory] = await Promise.all([
        prisma.user.findFirst({ where: { id: parseInt(q.userId) }, select: { name: true, email: true } }),
        prisma.auditLog.findMany({ where, orderBy: { occurredAt: "asc" }, take: 200, include: { user: { select: { name: true } } } }),
        prisma.auditLog.groupBy({ by: ["module","actionType"], where, _count: true }),
        prisma.loginHistory.findMany({ where: { schoolId, userId: parseInt(q.userId) }, orderBy: { loginAt: "desc" }, take: 20 }),
      ]);
      return reply.send({ success: true, data: { user, timeline, summary, loginHistory } });
    }
  );

  // ─── POST /admin/audit-logs ───────────────────────────────
  // Manual log creation (called from other modules)
  app.post("/admin/audit-logs", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { module: string; actionType: string; action: string; entityId?: number; entityType?: string; entityLabel?: string; beforeValue?: any; afterValue?: any; changeReason?: string; riskLevel?: number };
      await createAuditLog({ schoolId, userId, ...body, ipAddress: req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? undefined });
      return reply.send({ success: true });
    }
  );

  // ─── PATCH /admin/audit-logs/:id/flag ────────────────────
  app.patch("/admin/audit-logs/:id/flag", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };
      await prisma.auditLog.updateMany({ where: { id: parseInt(id), schoolId }, data: { isSuspicious: true, flagReason: reason, riskLevel: 2 } });
      return reply.send({ success: true });
    }
  );

  // ─── GET /admin/audit-logs/reports ───────────────────────
  app.get("/admin/audit-logs/reports", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string };
      const where: any = { schoolId };
      if (q.from || q.to) { where.occurredAt = {}; if (q.from) where.occurredAt.gte = new Date(q.from); if (q.to) where.occurredAt.lte = new Date(q.to); }
      const [byModule, byAction, byUser, byRisk, timeline] = await Promise.all([
        prisma.auditLog.groupBy({ by: ["module"],     where, _count: true }),
        prisma.auditLog.groupBy({ by: ["actionType"], where, _count: true }),
        prisma.auditLog.groupBy({ by: ["userId"],     where, _count: true, orderBy: { _count: { userId: "desc" } }, take: 10 }),
        prisma.auditLog.groupBy({ by: ["riskLevel"],  where, _count: true }),
        // daily counts for chart
        prisma.$queryRaw<{day: string; count: bigint}[]>`
          SELECT DATE("occurredAt") AS day, COUNT(*) AS count
          FROM audit_logs WHERE "schoolId" = ${schoolId}
          ${q.from ? prisma.$raw`AND "occurredAt" >= ${new Date(q.from)}` : prisma.$raw``}
          ${q.to ? prisma.$raw`AND "occurredAt" <= ${new Date(q.to)}` : prisma.$raw``}
          GROUP BY DATE("occurredAt") ORDER BY day DESC LIMIT 30
        `.catch(() => []),
      ]);
      const userIds = byUser.map(u => u.userId);
      const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
      const nameMap: Record<number,string> = {}; users.forEach(u => { nameMap[u.id] = u.name; });
      return reply.send({ success: true, data: {
        byModule: byModule.map(b => ({ module: b.module, count: b._count })).sort((a,b) => b.count-a.count),
        byAction: byAction.map(b => ({ action: b.actionType, count: b._count })).sort((a,b) => b.count-a.count),
        byUser:   byUser.map(b => ({ userId: b.userId, name: nameMap[b.userId]??"Unknown", count: b._count })),
        byRisk:   byRisk.map(b => ({ risk: b.riskLevel, count: b._count })),
        timeline: Array.isArray(timeline) ? timeline.map((t: any) => ({ day: t.day, count: Number(t.count) })) : [],
      }});
    }
  );

  // ─── POST /admin/audit-logs/login ────────────────────────
  // Called from auth module
  app.post("/admin/audit-logs/login", { preHandler: [authenticate, requireCapability('accounts.advanced')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { isSuccess, failReason, device, browser } = req.body as { isSuccess?: boolean; failReason?: string; device?: string; browser?: string };
      await prisma.loginHistory.create({ data: { schoolId, userId, isSuccess: isSuccess ?? true, failReason: failReason ?? null, device: device ?? null, browser: browser ?? null, ipAddress: req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? null, userAgent: req.headers["user-agent"] ?? null } });
      return reply.send({ success: true });
    }
  );
}
