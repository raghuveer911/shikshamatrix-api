// apps/api/src/routes/admin/communication/comm-dashboard-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

export async function adminCommDashboardRoutes(app: FastifyInstance) {
  const P = "/admin/comm";

  // ─── MAIN DASHBOARD ───────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now   = new Date();
      const mFrom = new Date(now.getFullYear(), now.getMonth(), 1);

      const [
        totalNotices, activeNotices, totalBroadcasts,
        scheduledMessages, pendingApproval,
      ] = await Promise.all([
        prisma.commNotice.count({ where: { schoolId } }),
        prisma.commNotice.count({ where: { schoolId, status: "PUBLISHED", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
        prisma.commBroadcast.count({ where: { schoolId } }),
        prisma.commScheduledMessage.count({ where: { schoolId, isActive: true, scheduledAt: { gt: now } } }),
        prisma.commNotice.count({ where: { schoolId, status: "PENDING_APPROVAL" } }),
      ]);

      // Delivery stats
      const deliveryStats = await prisma.commDelivery.groupBy({
        by: ["status"],
        where: { broadcast: { schoolId } },
        _count: { id: true },
      });

      const sentTotal      = deliveryStats.reduce((s, d) => s + d._count.id, 0);
      const deliveredCount = deliveryStats.find(d => d.status === "DELIVERED")?._count.id ?? 0;
      const readCount      = deliveryStats.find(d => d.status === "READ")?._count.id ?? 0;
      const failedCount    = deliveryStats.find(d => d.status === "FAILED")?._count.id ?? 0;
      const successRate    = sentTotal > 0 ? ((deliveredCount + readCount) / sentTotal * 100).toFixed(1) : "0.0";

      // Channel distribution
      const channelStats = await prisma.commDelivery.groupBy({
        by: ["channel"],
        where: { broadcast: { schoolId } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      });

      // This month's broadcasts
      const monthBroadcasts = await prisma.commBroadcast.count({
        where: { schoolId, createdAt: { gte: mFrom } },
      });

      // Recent notices (last 5 published)
      const recentNotices = await prisma.commNotice.findMany({
        where: { schoolId, status: "PUBLISHED" },
        orderBy: { publishAt: "desc" },
        take: 5,
        select: { id: true, title: true, category: true, priority: true, publishAt: true, viewCount: true },
      });

      // Recent broadcasts (last 5 sent)
      const recentBroadcasts = await prisma.commBroadcast.findMany({
        where: { schoolId, status: { in: ["SENT", "SENDING"] } },
        orderBy: { sentAt: "desc" },
        take: 5,
        select: { id: true, title: true, audienceType: true, totalRecipients: true, deliveredCount: true, sentAt: true, channels: true },
      });

      // Upcoming scheduled
      const upcomingScheduled = await prisma.commScheduledMessage.findMany({
        where: { schoolId, isActive: true, scheduledAt: { gt: now } },
        orderBy: { scheduledAt: "asc" },
        take: 5,
        select: { id: true, title: true, scheduledAt: true, audienceType: true, channels: true },
      });

      // Notice category breakdown
      const categoryBreakdown = await prisma.commNotice.groupBy({
        by: ["category"],
        where: { schoolId, status: "PUBLISHED" },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      });

      return rep.send({
        kpis: { totalNotices, activeNotices, totalBroadcasts, scheduledMessages, pendingApproval, monthBroadcasts },
        deliveryStats: { sentTotal, deliveredCount, readCount, failedCount, successRate },
        channelStats, categoryBreakdown,
        recentNotices, recentBroadcasts, upcomingScheduled,
      });
    }
  );

  // ─── QUICK STATS (lightweight) ────────────────────────────
  app.get(`${P}/quick-stats`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const [activeNotices, pendingApproval, scheduledMessages] = await Promise.all([
        prisma.commNotice.count({ where: { schoolId, status: "PUBLISHED", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
        prisma.commNotice.count({ where: { schoolId, status: "PENDING_APPROVAL" } }),
        prisma.commScheduledMessage.count({ where: { schoolId, isActive: true, scheduledAt: { gt: now } } }),
      ]);
      return rep.send({ activeNotices, pendingApproval, scheduledMessages });
    }
  );

  // ─── DELIVERY LOGS ────────────────────────────────────────
  app.get(`${P}/delivery-logs`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { broadcast: { schoolId } };
      if (q.broadcastId) where.broadcastId = Number(q.broadcastId);
      if (q.status)      where.status      = q.status;
      if (q.channel)     where.channel     = q.channel;

      const [logs, total] = await Promise.all([
        prisma.commDelivery.findMany({
          where,
          include: { broadcast: { select: { title: true, audienceType: true } } },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.commDelivery.count({ where }),
      ]);

      return rep.send({ logs, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── AUDIENCE SEGMENTS CRUD ───────────────────────────────
  app.get(`${P}/segments`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const segments = await prisma.commAudienceSegment.findMany({
        where: { schoolId, isActive: true },
        orderBy: { usageCount: "desc" },
      });
      return rep.send({ segments });
    }
  );

  app.post(`${P}/segments`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const segment = await prisma.commAudienceSegment.create({
        data: {
          schoolId,
          name:         b.name,
          description:  b.description ?? null,
          audienceType: b.audienceType as any,
          filters:      b.filters ?? {},
          createdById:  Number(userId),
        },
      });
      return rep.code(201).send({ segment });
    }
  );

  app.delete(`${P}/segments/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.commAudienceSegment.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─── SCHEDULED MESSAGES CRUD ──────────────────────────────
  app.get(`${P}/scheduled`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const scheduled = await prisma.commScheduledMessage.findMany({
        where: { schoolId, isActive: true, scheduledAt: { gt: now } },
        orderBy: { scheduledAt: "asc" },
      });
      return rep.send({ scheduled });
    }
  );

  app.post(`${P}/scheduled`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const msg = await prisma.commScheduledMessage.create({
        data: {
          schoolId,
          title:         b.title,
          audienceType:  b.audienceType as any,
          targetClassIds: b.targetClassIds ?? [],
          channels:      b.channels as any[] ?? [],
          content:       b.content ?? {},
          scheduledAt:   new Date(b.scheduledAt),
          recurrence:    b.recurrence ?? "ONCE",
          nextRunAt:     new Date(b.scheduledAt),
          createdById:   Number(userId),
        },
      });
      return rep.code(201).send({ scheduled: msg });
    }
  );

  app.delete(`${P}/scheduled/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.commScheduledMessage.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─── ANALYTICS ────────────────────────────────────────────
  app.get(`${P}/analytics`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const months = Number(q.months ?? 6);

      // Monthly broadcast trend
      const now = new Date();
      const monthlyTrend: { month: string; broadcasts: number; notices: number }[] = [];
      for (let i = months - 1; i >= 0; i--) {
        const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const to   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
        const [bc, nc] = await Promise.all([
          prisma.commBroadcast.count({ where: { schoolId, createdAt: { gte: from, lte: to } } }),
          prisma.commNotice.count({ where: { schoolId, publishAt: { gte: from, lte: to } } }),
        ]);
        monthlyTrend.push({ month: from.toLocaleString("default", { month: "short", year: "2-digit" }), broadcasts: bc, notices: nc });
      }

      // Channel performance
      const channelPerf = await prisma.commDelivery.groupBy({
        by: ["channel", "status"],
        where: { broadcast: { schoolId } },
        _count: { id: true },
      });

      // Top audiences
      const audienceBreakdown = await prisma.commBroadcast.groupBy({
        by: ["audienceType"],
        where: { schoolId },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      });

      return rep.send({ monthlyTrend, channelPerf, audienceBreakdown });
    }
  );
}
