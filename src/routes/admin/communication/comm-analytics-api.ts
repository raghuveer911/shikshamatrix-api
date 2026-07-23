// apps/api/src/routes/admin/communication/comm-analytics-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

export async function adminCommAnalyticsRoutes(app: FastifyInstance) {
  const P = "/admin/comm/analytics";

  // ─── MAIN ANALYTICS DASHBOARD ─────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [totalSent, totalDelivered, totalRead, totalFailed, totalNotices, totalBroadcasts] = await Promise.all([
        prisma.commDelivery.count({ where: { broadcast: { schoolId } } }),
        prisma.commDelivery.count({ where: { broadcast: { schoolId }, status: "DELIVERED" } }),
        prisma.commDelivery.count({ where: { broadcast: { schoolId }, status: "READ" } }),
        prisma.commDelivery.count({ where: { broadcast: { schoolId }, status: "FAILED" } }),
        prisma.commNotice.count({ where: { schoolId, status: "PUBLISHED" } }),
        prisma.commBroadcast.count({ where: { schoolId, status: "SENT" } }),
      ]);

      const openRate     = totalSent > 0 ? ((totalRead / totalSent) * 100).toFixed(1) : "0.0";
      const deliveryRate = totalSent > 0 ? (((totalDelivered + totalRead) / totalSent) * 100).toFixed(1) : "0.0";
      const failureRate  = totalSent > 0 ? ((totalFailed / totalSent) * 100).toFixed(1) : "0.0";

      // Notice engagement
      const noticeViews = await prisma.commNotice.aggregate({
        where: { schoolId },
        _sum: { viewCount: true, downloadCount: true },
      });

      // Message center activity
      const totalMessages     = await prisma.commMessage.count({ where: { conversation: { schoolId } } });
      const totalConversations = await prisma.commConversation.count({ where: { schoolId, isArchived: false } });

      return rep.send({
        kpis: { totalSent, totalDelivered, totalRead, totalFailed, totalNotices, totalBroadcasts, totalMessages, totalConversations },
        rates: { openRate, deliveryRate, failureRate },
        noticeEngagement: { views: noticeViews._sum.viewCount ?? 0, downloads: noticeViews._sum.downloadCount ?? 0 },
      });
    }
  );

  // ─── CHANNEL ANALYTICS ────────────────────────────────────
  app.get(`${P}/channels`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      // Per channel: sent, delivered, read, failed
      const channelStats = await prisma.commDelivery.groupBy({
        by: ["channel", "status"],
        where: { broadcast: { schoolId }, createdAt: { gte: from, lte: to } },
        _count: { id: true },
      });

      // Channel-level summary
      const CHANNELS = ["APP_NOTIFICATION", "SMS", "EMAIL", "WHATSAPP"];
      const channelSummary = CHANNELS.map(ch => {
        const rows      = channelStats.filter(r => r.channel === ch);
        const sent      = rows.reduce((s, r) => s + r._count.id, 0);
        const delivered = rows.find(r => r.status === "DELIVERED")?._count.id ?? 0;
        const read      = rows.find(r => r.status === "READ")?._count.id ?? 0;
        const failed    = rows.find(r => r.status === "FAILED")?._count.id ?? 0;
        const rate      = sent > 0 ? Math.round(((delivered + read) / sent) * 100) : 0;
        return { channel: ch, sent, delivered, read, failed, deliveryRate: rate };
      });

      // Broadcasts by channel (count of broadcasts using each channel)
      const broadcastsByChannel = await prisma.commBroadcast.findMany({
        where: { schoolId, createdAt: { gte: from, lte: to } },
        select: { channels: true },
      });
      const broadcastChannelCount: Record<string, number> = {};
      broadcastsByChannel.forEach(b => {
        (b.channels as string[]).forEach(ch => {
          broadcastChannelCount[ch] = (broadcastChannelCount[ch] ?? 0) + 1;
        });
      });

      return rep.send({ channelSummary, broadcastChannelCount, from, to });
    }
  );

  // ─── DELIVERY ANALYTICS ───────────────────────────────────
  app.get(`${P}/delivery`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      // Daily delivery trend
      const dailyTrend: { date: string; sent: number; failed: number }[] = [];
      const days = Math.min(Math.ceil((to.getTime() - from.getTime()) / 86400000), 31);
      for (let i = 0; i < days; i++) {
        const d    = new Date(from.getTime() + i * 86400000);
        const dEnd = new Date(d.getTime() + 86400000);
        const [sent, failed] = await Promise.all([
          prisma.commDelivery.count({ where: { broadcast: { schoolId }, createdAt: { gte: d, lt: dEnd } } }),
          prisma.commDelivery.count({ where: { broadcast: { schoolId }, createdAt: { gte: d, lt: dEnd }, status: "FAILED" } }),
        ]);
        dailyTrend.push({ date: d.toISOString().split("T")[0], sent, failed });
      }

      // Retry stats
      const retryStats = await prisma.commDelivery.aggregate({
        where: { broadcast: { schoolId }, retryCount: { gt: 0 } },
        _count: { id: true },
        _avg: { retryCount: true },
      });

      // Failure reasons
      const failureReasons = await prisma.commDelivery.groupBy({
        by: ["failureReason"],
        where: { broadcast: { schoolId }, status: "FAILED", failureReason: { not: null } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
      });

      return rep.send({ dailyTrend, retryStats, failureReasons });
    }
  );

  // ─── ENGAGEMENT ANALYTICS ────────────────────────────────
  app.get(`${P}/engagement`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      // Notice read rates
      const topNotices = await prisma.commNotice.findMany({
        where: { schoolId, status: "PUBLISHED" },
        orderBy: { viewCount: "desc" },
        take: 10,
        select: { id: true, title: true, category: true, viewCount: true, downloadCount: true, publishAt: true },
      });

      // Message activity by role
      const messagesByRole = await prisma.commMessage.groupBy({
        by: ["senderId"],
        where: { conversation: { schoolId }, isDeleted: false },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
      });

      const senderIds = messagesByRole.map(m => m.senderId);
      const senders   = await prisma.user.findMany({
        where: { id: { in: senderIds } },
        select: { id: true, name: true, role: true },
      });

      // Read rate for broadcasts
      const broadcastEngagement = await prisma.commBroadcast.findMany({
        where: { schoolId, status: "SENT", totalRecipients: { gt: 0 } },
        orderBy: { readCount: "desc" },
        take: 10,
        select: { id: true, title: true, totalRecipients: true, deliveredCount: true, readCount: true, sentAt: true, channels: true },
      });
      const enrichedBroadcasts = broadcastEngagement.map(b => ({
        ...b,
        openRate: b.totalRecipients > 0 ? Math.round((b.readCount / b.totalRecipients) * 100) : 0,
        deliveryRate: b.totalRecipients > 0 ? Math.round((b.deliveredCount / b.totalRecipients) * 100) : 0,
      }));

      return rep.send({
        topNotices,
        topSenders: messagesByRole.map(m => ({
          userId: m.senderId, messages: m._count.id,
          name: senders.find(s => s.id === m.senderId)?.name ?? "?",
          role: senders.find(s => s.id === m.senderId)?.role ?? "?",
        })),
        broadcastEngagement: enrichedBroadcasts,
      });
    }
  );

  // ─── USER ANALYTICS ───────────────────────────────────────
  app.get(`${P}/users`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      // Most active message senders
      const activeUsers = await prisma.commMessage.groupBy({
        by: ["senderId"],
        where: { conversation: { schoolId }, isDeleted: false },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
      });
      const activeUserIds = activeUsers.map(u => u.senderId);
      const activeUserDetails = await prisma.user.findMany({
        where: { id: { in: activeUserIds } },
        select: { id: true, name: true, role: true, avatarUrl: true },
      });

      // Notice engagement by user
      const noticeReaders = await prisma.commNoticeSeen.groupBy({
        by: ["userId"],
        where: { notice: { schoolId } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
      });
      const readerIds = noticeReaders.map(r => r.userId);
      const readerDetails = await prisma.user.findMany({
        where: { id: { in: readerIds } },
        select: { id: true, name: true, role: true },
      });

      // Role-wise participation
      const roleParticipation = await prisma.commMessage.groupBy({
        by: ["senderId"],
        where: { conversation: { schoolId } },
        _count: { id: true },
      });

      return rep.send({
        activeUsers: activeUsers.map(u => ({
          userId: u.senderId, messages: u._count.id,
          name: activeUserDetails.find(d => d.id === u.senderId)?.name ?? "?",
          role: activeUserDetails.find(d => d.id === u.senderId)?.role ?? "?",
        })),
        noticeReaders: noticeReaders.map(r => ({
          userId: r.userId, noticesRead: r._count.id,
          name: readerDetails.find(d => d.id === r.userId)?.name ?? "?",
        })),
      });
    }
  );

  // ─── CAMPAIGN ANALYTICS ───────────────────────────────────
  app.get(`${P}/campaigns`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const campaigns = await prisma.commBroadcast.findMany({
        where: { schoolId, campaignName: { not: null }, status: "SENT" },
        orderBy: { sentAt: "desc" },
        take: 20,
        select: {
          id: true, title: true, campaignName: true, audienceType: true,
          totalRecipients: true, sentCount: true, deliveredCount: true,
          readCount: true, failedCount: true, sentAt: true, channels: true,
        },
      });

      const enriched = campaigns.map(c => ({
        ...c,
        deliveryRate: c.totalRecipients > 0 ? Math.round((c.deliveredCount / c.totalRecipients) * 100) : 0,
        openRate:     c.totalRecipients > 0 ? Math.round((c.readCount / c.totalRecipients) * 100) : 0,
      }));

      // Group by campaign name
      const byCampaign: Record<string, typeof enriched> = {};
      enriched.forEach(b => {
        const key = b.campaignName ?? "Ungrouped";
        if (!byCampaign[key]) byCampaign[key] = [];
        byCampaign[key].push(b);
      });

      return rep.send({ campaigns: enriched, byCampaign });
    }
  );

  // ─── TREND ANALYSIS ───────────────────────────────────────
  app.get(`${P}/trends`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const months = Number((req.query as any).months ?? 6);
      const now = new Date();

      const trend: { month: string; broadcasts: number; notices: number; messages: number; deliveries: number }[] = [];

      for (let i = months - 1; i >= 0; i--) {
        const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const to   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
        const [bc, nc, mc, dc] = await Promise.all([
          prisma.commBroadcast.count({ where: { schoolId, createdAt: { gte: from, lte: to } } }),
          prisma.commNotice.count({ where: { schoolId, publishAt: { gte: from, lte: to } } }),
          prisma.commMessage.count({ where: { conversation: { schoolId }, sentAt: { gte: from, lte: to } } }),
          prisma.commDelivery.count({ where: { broadcast: { schoolId }, createdAt: { gte: from, lte: to } } }),
        ]);
        trend.push({
          month: from.toLocaleString("default", { month: "short", year: "2-digit" }),
          broadcasts: bc, notices: nc, messages: mc, deliveries: dc,
        });
      }

      return rep.send({ trend });
    }
  );

  // ─── TEMPLATE ANALYTICS ───────────────────────────────────
  app.get(`${P}/templates`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [topTemplates, typeBreakdown] = await Promise.all([
        prisma.commTemplate.findMany({
          where: { schoolId, isActive: true },
          orderBy: { usageCount: "desc" },
          take: 10,
          select: { id: true, name: true, type: true, usageCount: true, channels: true },
        }),
        prisma.commTemplate.groupBy({
          by: ["type"],
          where: { schoolId, isActive: true },
          _count: { id: true },
          _sum: { usageCount: true },
          orderBy: { _sum: { usageCount: "desc" } },
        }),
      ]);

      return rep.send({ topTemplates, typeBreakdown });
    }
  );

  // ─── SAVED REPORTS CRUD ───────────────────────────────────
  app.get(`${P}/saved-reports`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const reports = await prisma.commSavedReport.findMany({
        where: { schoolId },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ reports });
    }
  );

  app.post(`${P}/saved-reports`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const report = await prisma.commSavedReport.create({
        data: {
          schoolId, title: b.title,
          reportType: b.reportType, filters: b.filters ?? {},
          format: b.format ?? "PDF",
          createdById: Number(userId),
        },
      });
      return rep.code(201).send({ report });
    }
  );

  app.delete(`${P}/saved-reports/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.commSavedReport.delete({ where: { id, schoolId } });
      return rep.send({ ok: true });
    }
  );
}
