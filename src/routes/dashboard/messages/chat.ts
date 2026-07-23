// apps/api/src/routes/dashboard/messages/chat.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { z } from "zod";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[messages/chat] "${label}" failed:`, err?.message ?? err); return fallback; }
}

const sendSchema = z.object({
  body: z.string().optional(),
  type: z.enum(["TEXT","IMAGE","FILE","SYSTEM"]).default("TEXT"),
  attachment: z.object({
    url: z.string(), name: z.string(), type: z.string(), sizeKb: z.number().optional(),
    thumbnailUrl: z.string().optional(),
  }).optional(),
  replyToId: z.number().optional(),
});

export async function messagesChatRoutes(app: FastifyInstance) {

  // ── GET /messages/conversations/:id ────────────────────────────
  app.get("/messages/conversations/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = req as any;
      const { id } = req.params as { id: string };
      const { before, limit = "30" } = req.query as Record<string, string>;
      const conversationId = parseInt(id);

      const participation = await prisma.commConversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!participation) return reply.status(403).send({ success: false, error: "NOT_PARTICIPANT" });

      const conv = await prisma.commConversation.findUnique({
        where: { id: conversationId },
        select: {
          id: true, type: true, title: true, isPinned: true, isArchived: true,
          group: { select: { name: true, avatarUrl: true, type: true, description: true } },
          participants: {
            select: {
              isAdmin: true, isMuted: true,
              user: { select: { id: true, name: true, role: true, avatarUrl: true } },
            },
          },
        },
      });
      if (!conv) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      const messages = await prisma.commMessage.findMany({
        where: {
          conversationId, isDeleted: false,
          ...(before ? { sentAt: { lt: new Date(before) } } : {}),
        },
        orderBy: { sentAt: "desc" }, take: parseInt(limit),
        select: {
          id: true, senderId: true, body: true, type: true, attachment: true,
          sentAt: true, editedAt: true, isStarred: true, replyToId: true,
          sender: { select: { id: true, name: true, role: true } },
          replyTo: { select: { id: true, body: true, sender: { select: { name: true } } } },
          readBy: { select: { userId: true, readAt: true } },
        },
      });

      // Mark as read for this participant
      await safe("mark read", () =>
        prisma.commConversationParticipant.update({
          where: { conversationId_userId: { conversationId, userId } },
          data: { lastReadAt: new Date() },
        }), null);

      const unreadMsgIds = messages
        .filter((m) => m.senderId !== userId && !m.readBy.some((r) => r.userId === userId))
        .map((m) => m.id);
      if (unreadMsgIds.length > 0) {
        await safe("create read receipts", () =>
          prisma.commMessageRead.createMany({
            data: unreadMsgIds.map((mid) => ({ messageId: mid, userId })),
            skipDuplicates: true,
          }), null);
      }

      const others = conv.participants.filter((p) => p.user.id !== userId);
      const title = conv.type === "GROUP" ? (conv.group?.name ?? conv.title ?? "Group")
        : conv.type === "ANNOUNCEMENT" ? (conv.title ?? "Announcement")
        : (others[0]?.user.name ?? "Unknown");

      return reply.send({
        success: true,
        data: {
          conversation: {
            id: conv.id, type: conv.type, title,
            isPinned: conv.isPinned, isArchived: conv.isArchived,
            participants: conv.participants.map((p) => ({
              userId: p.user.id, name: p.user.name, role: p.user.role, isAdmin: p.isAdmin, isMuted: p.isMuted,
            })),
          },
          messages: messages.reverse().map((m) => ({
            id: m.id, senderId: m.senderId, senderName: m.sender.name,
            body: m.body, type: m.type, attachment: m.attachment,
            sentAt: m.sentAt, editedAt: m.editedAt, isStarred: m.isStarred,
            replyTo: m.replyTo ? { id: m.replyTo.id, body: m.replyTo.body, senderName: m.replyTo.sender.name } : null,
            readByOthers: m.readBy.some((r) => r.userId !== m.senderId),
          })),
          hasMore: messages.length === parseInt(limit),
        },
      });
    }
  );

  // ── POST /messages/conversations/:id/send ──────────────────────
  app.post("/messages/conversations/:id/send",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = req as any;
      const { id } = req.params as { id: string };
      const conversationId = parseInt(id);

      const parsed = sendSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });

      const { body, type, attachment, replyToId } = parsed.data;
      if (!body && !attachment) return reply.status(400).send({ success: false, error: "EMPTY_MESSAGE" });

      const participant = await prisma.commConversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!participant) return reply.status(403).send({ success: false, error: "NOT_PARTICIPANT" });

      // Announcements are one-way — only conversation admins can post
      const conv = await prisma.commConversation.findUnique({
        where: { id: conversationId }, select: { type: true },
      });
      if (conv?.type === "ANNOUNCEMENT" && !participant.isAdmin) {
        return reply.status(403).send({ success: false, error: "READ_ONLY", message: "This is a read-only announcement." });
      }

      const preview = body ? body.slice(0, 100) : attachment ? `📎 ${attachment.name}` : "";

      const msg = await prisma.commMessage.create({
        data: {
          conversationId, senderId: userId,
          body: body ?? null, type: type as any,
          attachment: attachment ?? undefined,
          replyToId: replyToId ?? null,
        },
        select: {
          id: true, senderId: true, body: true, type: true, attachment: true,
          sentAt: true, isStarred: true, replyToId: true,
          sender: { select: { name: true } },
          replyTo: { select: { id: true, body: true, sender: { select: { name: true } } } },
        },
      });

      await prisma.commConversation.update({
        where: { id: conversationId },
        data: { lastMessage: preview, lastMessageAt: new Date() },
      });

      return reply.status(201).send({
        success: true,
        data: {
          message: {
            id: msg.id, senderId: msg.senderId, senderName: msg.sender.name,
            body: msg.body, type: msg.type, attachment: msg.attachment,
            sentAt: msg.sentAt, isStarred: msg.isStarred,
            replyTo: msg.replyTo ? { id: msg.replyTo.id, body: msg.replyTo.body, senderName: msg.replyTo.sender.name } : null,
            readByOthers: false,
          },
        },
      });
    }
  );

  // ── PATCH /messages/conversations/:id/pin ──────────────────────
  app.patch("/messages/conversations/:id/pin",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = req as any;
      const { id } = req.params as { id: string };
      const conversationId = parseInt(id);

      const participant = await prisma.commConversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!participant) return reply.status(403).send({ success: false, error: "NOT_PARTICIPANT" });

      const conv = await prisma.commConversation.findUnique({ where: { id: conversationId } });
      if (!conv) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      await prisma.commConversation.update({ where: { id: conversationId }, data: { isPinned: !conv.isPinned } });
      return reply.send({ success: true, data: { isPinned: !conv.isPinned } });
    }
  );

  // ── PATCH /messages/conversations/:id/archive ──────────────────
  app.patch("/messages/conversations/:id/archive",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = req as any;
      const { id } = req.params as { id: string };
      const conversationId = parseInt(id);

      const participant = await prisma.commConversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!participant) return reply.status(403).send({ success: false, error: "NOT_PARTICIPANT" });

      const conv = await prisma.commConversation.findUnique({ where: { id: conversationId } });
      if (!conv) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      await prisma.commConversation.update({ where: { id: conversationId }, data: { isArchived: !conv.isArchived } });
      return reply.send({ success: true });
    }
  );
}