// apps/api/src/routes/admin/hr/hr-audit-logs-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminHrAuditLogsRoutes(app: FastifyInstance) {
  const P = "/admin/hr/audit";

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const week  = new Date(today.getTime() - 7 * 86400000);

      const [totalLogs, todayLogs, suspicious, weekChanges] = await Promise.all([
        prisma.hrActivityLog.count({ where: { schoolId } }),
        prisma.hrActivityLog.count({ where: { schoolId, occurredAt: { gte: today } } }),
        prisma.hrActivityLog.count({ where: { schoolId, isSuspicious: true } }),
        prisma.hrActivityLog.count({ where: { schoolId, occurredAt: { gte: week } } }),
      ]);

      // Module breakdown for last 30 days
      const last30 = new Date(today.getTime() - 30 * 86400000);
      const moduleBreakdown = await prisma.hrActivityLog.groupBy({
        by: ["module"],
        where: { schoolId, occurredAt: { gte: last30 } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      });

      // Action breakdown
      const actionBreakdown = await prisma.hrActivityLog.groupBy({
        by: ["action"],
        where: { schoolId, occurredAt: { gte: last30 } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 8,
      });

      // Most active users last 7 days
      const activeUsers = await prisma.hrActivityLog.groupBy({
        by: ["userId"],
        where: { schoolId, occurredAt: { gte: week }, userId: { not: null } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 5,
      });
      const userIds = activeUsers.map(u => u.userId).filter(Boolean) as number[];
      const userDetails = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, role: true },
      });

      return rep.send({
        totalLogs, todayLogs, suspicious, weekChanges,
        moduleBreakdown, actionBreakdown,
        activeUsers: activeUsers.map(u => ({
          userId: u.userId, actions: u._count.id,
          name: userDetails.find(d => d.id === u.userId)?.name ?? "System",
        })),
      });
    }
  );

  // ─── ACTIVITY LOGS LIST ───────────────────────────────────
  app.get(`${P}/logs`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId };
      if (q.module)   where.module = q.module;
      if (q.action)   where.action = q.action;
      if (q.userId)   where.userId = Number(q.userId);
      if (q.entityType) where.entityType = q.entityType;
      if (q.suspicious === "true") where.isSuspicious = true;
      if (q.from || q.to) {
        where.occurredAt = {};
        if (q.from) where.occurredAt.gte = new Date(q.from);
        if (q.to)   where.occurredAt.lte = new Date(q.to);
      }
      if (q.search) {
        where.OR = [
          { description: { contains: q.search, mode: "insensitive" } },
          { entityLabel: { contains: q.search, mode: "insensitive" } },
        ];
      }

      const [logs, total] = await Promise.all([
        prisma.hrActivityLog.findMany({
          where,
          include: {
            user: { select: { name: true, role: true } },
          },
          orderBy: { occurredAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.hrActivityLog.count({ where }),
      ]);

      return rep.send({ logs, total, page, limit, pages: Math.ceil(total / limit) });
    }
  );

  // ─── ATTENDANCE LOGS ──────────────────────────────────────
  app.get(`${P}/attendance-logs`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      // All attendance marking/editing activity
      const logs = await prisma.hrActivityLog.findMany({
        where: {
          schoolId,
          module: "ATTENDANCE",
          occurredAt: { gte: from, lte: to },
        },
        include: { user: { select: { name: true } } },
        orderBy: { occurredAt: "desc" },
        take: Number(q.limit ?? 100),
      });

      // Corrections summary
      const corrections = await prisma.attendanceCorrection.findMany({
        where: {
          schoolId,
          createdAt: { gte: from, lte: to },
        },
        include: {
          staff: { include: { user: { select: { name: true } } } },
          approvedBy: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });

      return rep.send({ logs, corrections });
    }
  );

  // ─── LEAVE LOGS ───────────────────────────────────────────
  app.get(`${P}/leave-logs`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 90 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      const [applications, logs] = await Promise.all([
        prisma.hrLeaveApplication.findMany({
          where: { schoolId, appliedAt: { gte: from, lte: to } },
          include: {
            staff: { include: { user: { select: { name: true, avatarUrl: true } } } },
            leaveType: { select: { name: true, color: true } },
          },
          orderBy: { appliedAt: "desc" },
          take: Number(q.limit ?? 100),
        }),
        prisma.hrActivityLog.findMany({
          where: { schoolId, module: "LEAVE", occurredAt: { gte: from, lte: to } },
          include: { user: { select: { name: true } } },
          orderBy: { occurredAt: "desc" },
          take: 50,
        }),
      ]);

      return rep.send({ applications, logs });
    }
  );

  // ─── RECRUITMENT LOGS ─────────────────────────────────────
  app.get(`${P}/recruitment-logs`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 90 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      const logs = await prisma.hrActivityLog.findMany({
        where: {
          schoolId, module: "RECRUITMENT",
          occurredAt: { gte: from, lte: to },
        },
        include: { user: { select: { name: true } } },
        orderBy: { occurredAt: "desc" },
        take: Number(q.limit ?? 100),
      });

      // Recent job/application changes
      const recentJobs = await prisma.hrJobOpening.findMany({
        where: { schoolId, updatedAt: { gte: from, lte: to } },
        include: { department: { select: { name: true } } },
        orderBy: { updatedAt: "desc" },
        take: 20,
      });

      return rep.send({ logs, recentJobs });
    }
  );

  // ─── PERFORMANCE LOGS ─────────────────────────────────────
  app.get(`${P}/performance-logs`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 90 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      const [logs, recentReviews, recentAppraisals] = await Promise.all([
        prisma.hrActivityLog.findMany({
          where: { schoolId, module: "PERFORMANCE", occurredAt: { gte: from, lte: to } },
          include: { user: { select: { name: true } } },
          orderBy: { occurredAt: "desc" },
          take: Number(q.limit ?? 100),
        }),
        prisma.hrPerformanceReview.findMany({
          where: { schoolId, createdAt: { gte: from, lte: to } },
          include: { staff: { include: { user: { select: { name: true } } } } },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
        prisma.hrAppraisal.findMany({
          where: { schoolId, createdAt: { gte: from, lte: to } },
          include: { staff: { include: { user: { select: { name: true } } } } },
          orderBy: { createdAt: "desc" },
          take: 10,
        }),
      ]);

      return rep.send({ logs, recentReviews, recentAppraisals });
    }
  );

  // ─── SECURITY LOGS ────────────────────────────────────────
  app.get(`${P}/security-logs`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const limit = Number(q.limit ?? 100);
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);

      const [loginHistory, securityLogs, suspiciousLogs] = await Promise.all([
        prisma.loginHistory.findMany({
          where: { schoolId, loginAt: { gte: from } },
          include: { user: { select: { name: true, role: true } } },
          orderBy: { loginAt: "desc" },
          take: limit,
        }),
        prisma.hrActivityLog.findMany({
          where: { schoolId, module: "SECURITY", occurredAt: { gte: from } },
          include: { user: { select: { name: true } } },
          orderBy: { occurredAt: "desc" },
          take: limit,
        }),
        prisma.hrActivityLog.findMany({
          where: { schoolId, isSuspicious: true, occurredAt: { gte: from } },
          include: { user: { select: { name: true } } },
          orderBy: { occurredAt: "desc" },
          take: 20,
        }),
      ]);

      return rep.send({ loginHistory, securityLogs, suspiciousLogs });
    }
  );

  // ─── INVESTIGATION CENTER ─────────────────────────────────
  app.get(`${P}/investigate`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      if (!q.userId && !q.entityType && !q.module) {
        return rep.code(400).send({ error: "Provide at least one filter: userId, entityType, or module" });
      }

      const where: any = { schoolId };
      if (q.userId)     where.userId = Number(q.userId);
      if (q.module)     where.module = q.module;
      if (q.entityType) where.entityType = q.entityType;
      if (q.entityId)   where.entityId = Number(q.entityId);
      if (q.from)       where.occurredAt = { ...(where.occurredAt ?? {}), gte: new Date(q.from) };
      if (q.to)         where.occurredAt = { ...(where.occurredAt ?? {}), lte: new Date(q.to) };

      const logs = await prisma.hrActivityLog.findMany({
        where,
        include: { user: { select: { name: true, role: true } } },
        orderBy: { occurredAt: "desc" },
        take: Number(q.limit ?? 200),
      });

      // Group by day for timeline
      const timeline: Record<string, any[]> = {};
      logs.forEach(l => {
        const day = l.occurredAt.toISOString().split("T")[0];
        if (!timeline[day]) timeline[day] = [];
        timeline[day].push(l);
      });

      return rep.send({ logs, timeline, total: logs.length });
    }
  );

  // ─── LOG ENTRY (write) — used by other HR modules internally ──
  app.post(`${P}/log`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const log = await prisma.hrActivityLog.create({
        data: {
          schoolId,
          userId: Number(userId),
          staffId: b.staffId ? Number(b.staffId) : null,
          module: b.module as any,
          action: b.action as any,
          entityType: b.entityType,
          entityId: b.entityId ? Number(b.entityId) : null,
          entityLabel: b.entityLabel ?? null,
          description: b.description,
          beforeValue: b.beforeValue ?? null,
          afterValue: b.afterValue ?? null,
          ipAddress: req.ip ?? null,
          isSuspicious: b.isSuspicious ?? false,
          riskScore: b.riskScore ?? 0,
        },
      });
      return rep.code(201).send({ log });
    }
  );
}
