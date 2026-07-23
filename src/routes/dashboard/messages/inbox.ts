// apps/api/src/routes/dashboard/messages/inbox.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { canMessage, getAllowedContacts } from "./permissions.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[messages/inbox] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function messagesInboxRoutes(app: FastifyInstance) {

  // ── GET /messages/inbox?section=all|direct|groups|announcements|starred|archive ──
  app.get("/messages/inbox",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = req as any;
      const { section = "all" } = req.query as { section?: string };

      const participations = await safe("participant list", () =>
        prisma.commConversationParticipant.findMany({
          where: { userId },
          select: {
            conversationId: true, lastReadAt: true, isMuted: true,
            conversation: {
              select: {
                id: true, type: true, title: true, isArchived: true, isPinned: true,
                lastMessage: true, lastMessageAt: true,
                group: { select: { name: true, avatarUrl: true, type: true } },
                participants: {
                  where: { userId: { not: userId } }, take: 1,
                  select: { user: { select: { id: true, name: true, avatarUrl: true, role: true } } },
                },
              },
            },
          },
        }), [] as any[]);

      let items = await Promise.all(participations.map(async (p: any) => {
        const conv = p.conversation;
        const unreadCount = await safe("unread count", () =>
          prisma.commMessage.count({
            where: {
              conversationId: conv.id, isDeleted: false, senderId: { not: userId },
              sentAt: p.lastReadAt ? { gt: p.lastReadAt } : undefined,
            },
          }), 0);

        const other = conv.participants[0]?.user;
        const name = conv.type === "GROUP"
          ? (conv.group?.name ?? conv.title ?? "Group")
          : conv.type === "ANNOUNCEMENT"
          ? (conv.title ?? "Announcement")
          : (other?.name ?? "Unknown");

        return {
          conversationId: conv.id, type: conv.type, name,
          otherRole: other?.role, lastMessage: conv.lastMessage, lastMessageAt: conv.lastMessageAt,
          unreadCount, isMuted: p.isMuted, isPinned: conv.isPinned, isArchived: conv.isArchived,
        };
      }));

      if (section === "starred") {
        // "Starred" here means the conversation contains starred messages
        const starredConvIds = await safe("starred conv ids", async () => {
          const msgs = await prisma.commMessage.findMany({
            where: { isStarred: true, conversation: { participants: { some: { userId } } } },
            select: { conversationId: true }, distinct: ["conversationId"],
          });
          return new Set(msgs.map((m) => m.conversationId));
        }, new Set<number>());
        items = items.filter((i) => starredConvIds.has(i.conversationId));
      } else if (section === "archive") {
        items = items.filter((i) => i.isArchived);
      } else if (section === "groups") {
        items = items.filter((i) => i.type === "GROUP" && !i.isArchived);
      } else if (section === "direct") {
        items = items.filter((i) => i.type === "DIRECT" && !i.isArchived);
      } else if (section === "announcements") {
        items = items.filter((i) => i.type === "ANNOUNCEMENT" && !i.isArchived);
      } else {
        items = items.filter((i) => !i.isArchived);
      }

      items.sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        return new Date(b.lastMessageAt ?? 0).getTime() - new Date(a.lastMessageAt ?? 0).getTime();
      });

      const totalUnread = items.reduce((s, i) => s + i.unreadCount, 0);
      return reply.send({ success: true, data: { conversations: items, totalUnread } });
    }
  );

  // ── GET /messages/contacts?q= — permission-scoped contact list ──
  app.get("/messages/contacts",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId, role } = req as any;
      const { q } = req.query as { q?: string };

      const contacts = await getAllowedContacts(userId, role, schoolId, q);
      return reply.send({ success: true, data: { contacts } });
    }
  );

  // ── GET /messages/search?q= ───────────────────────────────────
  app.get("/messages/search",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = req as any;
      const { q } = req.query as { q: string };

      if (!q || q.trim().length < 2) {
        return reply.send({ success: true, data: { conversations: [], messages: [] } });
      }

      const participations = await safe("search: my conversations", () =>
        prisma.commConversationParticipant.findMany({
          where: {
            userId,
            conversation: {
              OR: [
                { title: { contains: q, mode: "insensitive" } },
                { group: { name: { contains: q, mode: "insensitive" } } },
                { participants: { some: { userId: { not: userId }, user: { name: { contains: q, mode: "insensitive" } } } } },
              ],
            },
          },
          select: {
            conversationId: true,
            conversation: {
              select: {
                type: true, title: true, lastMessage: true, lastMessageAt: true,
                group: { select: { name: true } },
                participants: {
                  where: { userId: { not: userId } }, take: 1,
                  select: { user: { select: { name: true } } },
                },
              },
            },
          },
          take: 20,
        }), [] as any[]);

      const conversations = participations.map((p: any) => ({
        conversationId: p.conversationId,
        name: p.conversation.type === "GROUP" ? p.conversation.group?.name
          : p.conversation.type === "ANNOUNCEMENT" ? p.conversation.title
          : p.conversation.participants[0]?.user?.name ?? "Unknown",
        lastMessage: p.conversation.lastMessage,
        lastMessageAt: p.conversation.lastMessageAt,
      }));

      const messages = await safe("search: messages", () =>
        prisma.commMessage.findMany({
          where: {
            body: { contains: q, mode: "insensitive" }, isDeleted: false,
            conversation: { participants: { some: { userId } } },
          },
          take: 15, orderBy: { sentAt: "desc" },
          select: {
            id: true, body: true, conversationId: true,
            sender: { select: { name: true } },
          },
        }), [] as any[]);

      return reply.send({
        success: true,
        data: {
          conversations,
          messages: messages.map((m: any) => ({ id: m.id, body: m.body, conversationId: m.conversationId, senderName: m.sender.name })),
        },
      });
    }
  );

  // ── POST /messages/direct — start/get a direct conversation ───
  app.post("/messages/direct",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId, role } = req as any;
      const { otherUserId } = req.body as { otherUserId: number };

      if (!otherUserId) return reply.status(400).send({ success: false, error: "OTHER_USER_ID_REQUIRED" });

      const otherUser = await safe("other user lookup", () =>
        prisma.user.findFirst({ where: { id: otherUserId, schoolId }, select: { role: true } }), null);
      if (!otherUser) return reply.status(404).send({ success: false, error: "USER_NOT_FOUND" });

      const allowed = await canMessage({
        senderId: userId, senderRole: role, schoolId,
        receiverId: otherUserId, receiverRole: otherUser.role,
      });
      if (!allowed) {
        return reply.status(403).send({
          success: false, error: "NOT_ALLOWED",
          message: "You don't have permission to message this person.",
        });
      }

      const existing = await safe("existing direct conv", () =>
        prisma.commConversationParticipant.findFirst({
          where: {
            userId,
            conversation: { type: "DIRECT", participants: { some: { userId: otherUserId } } },
          },
          select: { conversationId: true },
        }), null);

      if (existing) return reply.send({ success: true, data: { conversationId: existing.conversationId } });

      const conv = await prisma.commConversation.create({
        data: {
          schoolId, type: "DIRECT",
          participants: { create: [{ userId }, { userId: otherUserId }] },
        },
      });

      return reply.status(201).send({ success: true, data: { conversationId: conv.id, isNew: true } });
    }
  );
}