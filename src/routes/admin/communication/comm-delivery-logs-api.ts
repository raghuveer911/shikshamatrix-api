// apps/api/src/routes/admin/communication/comm-delivery-logs-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

export async function adminCommDeliveryLogsRoutes(app: FastifyInstance) {
  const P = "/admin/comm/delivery";

  // ─── DASHBOARD KPIs ───────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      const where = { broadcast: { schoolId }, createdAt: { gte: from, lte: to } };

      const [total, delivered, read, failed, retryPending] = await Promise.all([
        prisma.commDelivery.count({ where }),
        prisma.commDelivery.count({ where: { ...where, status: "DELIVERED" } }),
        prisma.commDelivery.count({ where: { ...where, status: "READ" } }),
        prisma.commDelivery.count({ where: { ...where, status: "FAILED" } }),
        prisma.commDelivery.count({ where: { ...where, status: "FAILED", retryCount: { lt: 3 } } }),
      ]);

      const successRate = total > 0 ? (((delivered + read) / total) * 100).toFixed(1) : "0.0";

      // Status breakdown
      const statusBreakdown = await prisma.commDelivery.groupBy({
        by: ["status"],
        where,
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      });

      // Channel breakdown with success rate
      const channelBreakdown = await prisma.commDelivery.groupBy({
        by: ["channel", "status"],
        where,
        _count: { id: true },
      });

      const CHANNELS = ["APP_NOTIFICATION","SMS","EMAIL","WHATSAPP"];
      const channelSummary = CHANNELS.map(ch => {
        const rows = channelBreakdown.filter(r => r.channel === ch);
        const sent = rows.reduce((s, r) => s + r._count.id, 0);
        const ok   = rows.filter(r => r.status === "DELIVERED" || r.status === "READ").reduce((s, r) => s + r._count.id, 0);
        return { channel: ch, sent, delivered: ok, rate: sent > 0 ? Math.round((ok / sent) * 100) : 0 };
      });

      // Top failure reasons
      const failureReasons = await prisma.commDelivery.groupBy({
        by: ["failureReason"],
        where: { ...where, status: "FAILED", failureReason: { not: null } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 5,
      });

      // Recent deliveries
      const recent = await prisma.commDelivery.findMany({
        where,
        include: { broadcast: { select: { title: true, audienceType: true } } },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true, channel: true, status: true, sentAt: true,
          deliveredAt: true, readAt: true, failedAt: true,
          failureReason: true, retryCount: true,
          broadcast: { select: { title: true } },
        },
      });

      return rep.send({
        kpis: { total, delivered, read, failed, retryPending, successRate },
        statusBreakdown, channelSummary, failureReasons, recent, from, to,
      });
    }
  );

  // ─── ALL DELIVERIES (paginated, full filter) ──────────────
  app.get(`${P}/all`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { broadcast: { schoolId } };
      if (q.status)      where.status  = q.status;
      if (q.channel)     where.channel = q.channel;
      if (q.broadcastId) where.broadcastId = Number(q.broadcastId);
      if (q.from || q.to) {
        where.createdAt = {};
        if (q.from) where.createdAt.gte = new Date(q.from);
        if (q.to)   where.createdAt.lte = new Date(q.to);
      }

      const [deliveries, total] = await Promise.all([
        prisma.commDelivery.findMany({
          where,
          include: { broadcast: { select: { title: true, campaignName: true } } },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.commDelivery.count({ where }),
      ]);

      return rep.send({ deliveries, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── FAILED DELIVERIES ────────────────────────────────────
  app.get(`${P}/failed`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { broadcast: { schoolId }, status: "FAILED" };
      if (q.channel) where.channel = q.channel;
      if (q.retryable === "true") where.retryCount = { lt: 3 };
      if (q.reason)  where.failureReason = { contains: q.reason, mode: "insensitive" };

      const [deliveries, total] = await Promise.all([
        prisma.commDelivery.findMany({
          where,
          include: { broadcast: { select: { title: true, audienceType: true } } },
          orderBy: { failedAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.commDelivery.count({ where }),
      ]);

      return rep.send({ deliveries, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── DELIVERY TIMELINE for a single delivery ──────────────
  app.get(`${P}/:id/timeline`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const id = Number((req.params as any).id);
      const delivery = await prisma.commDelivery.findFirst({
        where: { id },
        include: { broadcast: { select: { title: true, audienceType: true, sentAt: true } } },
      });
      if (!delivery) return rep.code(404).send({ error: "Not found" });

      // Build timeline events
      const timeline: { time: Date; event: string; detail?: string }[] = [];
      if (delivery.broadcast?.sentAt) timeline.push({ time: delivery.broadcast.sentAt, event: "Broadcast Created" });
      if (delivery.sentAt)     timeline.push({ time: delivery.sentAt,     event: "Message Sent",      detail: `via ${delivery.channel}` });
      if (delivery.deliveredAt) timeline.push({ time: delivery.deliveredAt, event: "Delivered",       detail: `Provider: ${delivery.providerMsgId ?? "—"}` });
      if (delivery.readAt)     timeline.push({ time: delivery.readAt,     event: "Read by Recipient" });
      if (delivery.failedAt)   timeline.push({ time: delivery.failedAt,   event: "Delivery Failed",   detail: delivery.failureReason ?? "Unknown reason" });
      if (delivery.retryCount > 0) timeline.push({ time: delivery.updatedAt, event: `Retried ${delivery.retryCount} time(s)` });

      timeline.sort((a, b) => a.time.getTime() - b.time.getTime());

      return rep.send({ delivery, timeline });
    }
  );

  // ─── RETRY SINGLE ─────────────────────────────────────────
  app.post(`${P}/:id/retry`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const id = Number((req.params as any).id);
      const delivery = await prisma.commDelivery.update({
        where: { id },
        data: {
          status: "PENDING",
          retryCount: { increment: 1 },
          failedAt: null, failureReason: null,
        },
      });
      return rep.send({ delivery, message: "Retry queued" });
    }
  );

  // ─── BULK RETRY (all failed in a broadcast, or selected IDs) ─
  app.post(`${P}/retry/bulk`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;

      const where: any = { broadcast: { schoolId }, status: "FAILED" };
      if (b.ids?.length)       where.id = { in: b.ids.map(Number) };
      if (b.broadcastId)       where.broadcastId = Number(b.broadcastId);
      if (b.maxRetries !== undefined) where.retryCount = { lt: Number(b.maxRetries ?? 3) };

      const result = await prisma.commDelivery.updateMany({
        where,
        data: { status: "PENDING", retryCount: { increment: 1 }, failedAt: null, failureReason: null },
      });

      return rep.send({ retried: result.count, message: `${result.count} deliveries queued for retry` });
    }
  );

  // ─── CHANNEL LOGS ─────────────────────────────────────────
  app.get(`${P}/channel/:channel`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const channel = (req.params as any).channel;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86400000);

      const where: any = { broadcast: { schoolId }, channel, createdAt: { gte: from } };
      if (q.status) where.status = q.status;

      const [deliveries, total, stats] = await Promise.all([
        prisma.commDelivery.findMany({
          where, orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit, take: limit,
          include: { broadcast: { select: { title: true } } },
        }),
        prisma.commDelivery.count({ where }),
        prisma.commDelivery.groupBy({
          by: ["status"],
          where: { broadcast: { schoolId }, channel, createdAt: { gte: from } },
          _count: { id: true },
        }),
      ]);

      return rep.send({ deliveries, total, page, stats, channel });
    }
  );

  // ─── RECIPIENT LOGS ───────────────────────────────────────
  app.get(`${P}/recipient`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      if (!q.userId && !q.email && !q.phone) {
        return rep.code(400).send({ error: "Provide userId, email, or phone" });
      }

      const where: any = { broadcast: { schoolId } };
      if (q.userId) where.userId = Number(q.userId);
      if (q.email)  where.email  = q.email;
      if (q.phone)  where.phone  = q.phone;

      const deliveries = await prisma.commDelivery.findMany({
        where,
        include: { broadcast: { select: { title: true, audienceType: true, sentAt: true } } },
        orderBy: { createdAt: "desc" },
        take: Number(q.limit ?? 50),
      });

      return rep.send({ deliveries, total: deliveries.length });
    }
  );

  // ─── AUDIT TRAIL ──────────────────────────────────────────
  app.get(`${P}/audit`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86400000);

      // Broadcast audit (who created/sent what when)
      const broadcasts = await prisma.commBroadcast.findMany({
        where: { schoolId, createdAt: { gte: from } },
        include: { createdBy: { select: { name: true, role: true } } },
        orderBy: { createdAt: "desc" },
        take: Number(q.limit ?? 100),
        select: {
          id: true, title: true, status: true,
          totalRecipients: true, sentAt: true, createdAt: true,
          sourceModule: true, campaignName: true,
          createdBy: { select: { name: true, role: true } },
        },
      });

      return rep.send({ broadcasts, from });
    }
  );

  // ─── DELIVERY REPORT ─────────────────────────────────────
  app.get(`${P}/reports/summary`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      const [totalSent, totalDelivered, totalRead, totalFailed, byChannel] = await Promise.all([
        prisma.commDelivery.count({ where: { broadcast: { schoolId }, createdAt: { gte: from, lte: to } } }),
        prisma.commDelivery.count({ where: { broadcast: { schoolId }, status: "DELIVERED", createdAt: { gte: from, lte: to } } }),
        prisma.commDelivery.count({ where: { broadcast: { schoolId }, status: "READ", createdAt: { gte: from, lte: to } } }),
        prisma.commDelivery.count({ where: { broadcast: { schoolId }, status: "FAILED", createdAt: { gte: from, lte: to } } }),
        prisma.commDelivery.groupBy({
          by: ["channel"],
          where: { broadcast: { schoolId }, createdAt: { gte: from, lte: to } },
          _count: { id: true },
        }),
      ]);

      const deliveryRate = totalSent > 0 ? Math.round(((totalDelivered + totalRead) / totalSent) * 100) : 0;
      const readRate     = totalSent > 0 ? Math.round((totalRead / totalSent) * 100) : 0;
      const failureRate  = totalSent > 0 ? Math.round((totalFailed / totalSent) * 100) : 0;

      return rep.send({ totalSent, totalDelivered, totalRead, totalFailed, deliveryRate, readRate, failureRate, byChannel, from, to });
    }
  );
}
