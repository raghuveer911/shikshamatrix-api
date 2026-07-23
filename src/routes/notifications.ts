import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";

// Priority sort order — URGENT always floats to the top regardless of
// recency, matching how emergency notices should get more attention.
const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

export async function notificationRoutes(app: FastifyInstance) {
  const P = "/notifications";

  // ── GET /notifications ──────────────────────────────────
  // Lists the logged-in user's own notifications, urgent-first then most
  // recent, optionally filtered by category and read status.
  app.get(P, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const q = req.query as any;
      const page = Number(q.page ?? 1);
      const limit = Number(q.limit ?? 30);

      const where: any = { userId: Number(userId) };
      if (q.category) where.category = q.category;
      if (q.unreadOnly === "true") where.isRead = false;

      const [notifications, total, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: [{ createdAt: "desc" }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.notification.count({ where }),
        prisma.notification.count({ where: { userId: Number(userId), isRead: false } }),
      ]);

      // Priority sort happens in-app after the DB query (Prisma can't
      // order by an arbitrary enum-to-rank mapping in one query) — fine
      // at inbox-page volumes (one page at a time, not the whole table).
      notifications.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.createdAt.getTime() - a.createdAt.getTime());

      // Category counts for the filter tabs on the frontend.
      const byCategory = await prisma.notification.groupBy({
        by: ["category"],
        where: { userId: Number(userId) },
        _count: { id: true },
      });

      return rep.send({
        notifications,
        total,
        page,
        pages: Math.ceil(total / limit),
        unreadCount,
        byCategory: byCategory.map((c) => ({ category: c.category, count: c._count.id })),
      });
    }
  );

  // ── GET /notifications/unread-count ─────────────────────
  // Lightweight endpoint for a badge count — polled more often than the
  // full list, so kept cheap (one count query, no notification rows).
  app.get(`${P}/unread-count`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const unreadCount = await prisma.notification.count({ where: { userId: Number(userId), isRead: false } });
      return rep.send({ unreadCount });
    }
  );

  // ── POST /notifications/:id/read ────────────────────────
  app.post(`${P}/:id/read`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const id = Number((req.params as any).id);

      const notification = await prisma.notification.findFirst({ where: { id, userId: Number(userId) } });
      if (!notification) return rep.status(404).send({ success: false, message: "Notification not found." });

      if (!notification.isRead) {
        await prisma.notification.update({ where: { id }, data: { isRead: true, readAt: new Date() } });
      }
      return rep.send({ success: true });
    }
  );

  // ── POST /notifications/read-all ────────────────────────
  app.post(`${P}/read-all`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const q = req.body as any;
      const where: any = { userId: Number(userId), isRead: false };
      if (q?.category) where.category = q.category;

      const result = await prisma.notification.updateMany({ where, data: { isRead: true, readAt: new Date() } });
      return rep.send({ success: true, markedCount: result.count });
    }
  );

  // ── DELETE /notifications/:id ────────────────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const id = Number((req.params as any).id);
      const notification = await prisma.notification.findFirst({ where: { id, userId: Number(userId) } });
      if (!notification) return rep.status(404).send({ success: false, message: "Notification not found." });
      await prisma.notification.delete({ where: { id } });
      return rep.send({ success: true });
    }
  );
}
