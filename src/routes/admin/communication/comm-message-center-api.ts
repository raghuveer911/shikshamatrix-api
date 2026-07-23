// apps/api/src/routes/admin/communication/comm-message-center-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

export async function adminCommMessageCenterRoutes(app: FastifyInstance) {
  const P = "/admin/comm/messages";

  // ─── INBOX — conversations for this user ─────────────────
  app.get(`${P}/inbox`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId, schoolId } = req.user as any;
      const q = req.query as any;

      const where: any = {
        schoolId,
        participants: { some: { userId: Number(userId) } },
        isArchived: false,
      };
      if (q.type)   where.type = q.type;
      if (q.pinned === "true") where.isPinned = true;

      const conversations = await prisma.commConversation.findMany({
        where,
        include: {
          participants: {
            include: { user: { select: { id: true, name: true, avatarUrl: true, role: true } } },
          },
          messages: { orderBy: { sentAt: "desc" }, take: 1,
            include: { sender: { select: { name: true } } },
          },
        },
        orderBy: [{ isPinned: "desc" }, { lastMessageAt: "desc" }],
        take: Number(q.limit ?? 30),
        skip: Number(q.offset ?? 0),
      });

      // Enrich with unread count per conversation
      const enriched = await Promise.all(conversations.map(async conv => {
        const participant = conv.participants.find(p => p.userId === Number(userId));
        const lastReadAt  = participant?.lastReadAt;
        const unreadCount = lastReadAt
          ? await prisma.commMessage.count({ where: { conversationId: conv.id, sentAt: { gt: lastReadAt }, senderId: { not: Number(userId) } } })
          : await prisma.commMessage.count({ where: { conversationId: conv.id, senderId: { not: Number(userId) } } });
        return { ...conv, unreadCount };
      }));

      // Total unread across all conversations
      const totalUnread = enriched.reduce((s, c) => s + c.unreadCount, 0);

      return rep.send({ conversations: enriched, totalUnread });
    }
  );

  // ─── INBOX STATS ─────────────────────────────────────────
  app.get(`${P}/stats`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId, schoolId } = req.user as any;
      const today = new Date(); today.setHours(0, 0, 0, 0);

      const [totalConversations, totalMessages, messagesToday, groups] = await Promise.all([
        prisma.commConversation.count({ where: { schoolId, participants: { some: { userId: Number(userId) } }, isArchived: false } }),
        prisma.commMessage.count({ where: { senderId: Number(userId) } }),
        prisma.commMessage.count({ where: { senderId: Number(userId), sentAt: { gte: today } } }),
        prisma.commGroup.count({ where: { schoolId, isActive: true } }),
      ]);

      return rep.send({ totalConversations, totalMessages, messagesToday, groups });
    }
  );

  // ─── GET OR CREATE DIRECT CONVERSATION ───────────────────
  app.post(`${P}/conversation/start`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId, schoolId } = req.user as any;
      const { targetUserId } = req.body as any;

      // Check if direct conversation already exists
      const existing = await prisma.commConversation.findFirst({
        where: {
          schoolId,
          type: "DIRECT",
          participants: { every: { userId: { in: [Number(userId), Number(targetUserId)] } } },
        },
        include: {
          participants: { include: { user: { select: { id: true, name: true, avatarUrl: true, role: true } } } },
        },
      });
      if (existing) return rep.send({ conversation: existing, isNew: false });

      const conversation = await prisma.commConversation.create({
        data: {
          schoolId,
          type: "DIRECT",
          participants: {
            create: [
              { userId: Number(userId) },
              { userId: Number(targetUserId) },
            ],
          },
        },
        include: {
          participants: { include: { user: { select: { id: true, name: true, avatarUrl: true, role: true } } } },
        },
      });

      return rep.code(201).send({ conversation, isNew: true });
    }
  );

  // ─── GET MESSAGES IN A CONVERSATION ──────────────────────
  app.get(`${P}/conversation/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const convId = Number((req.params as any).id);
      const q = req.query as any;
      const limit  = Number(q.limit  ?? 50);
      const before = q.before ? new Date(q.before) : undefined;

      const messages = await prisma.commMessage.findMany({
        where: {
          conversationId: convId,
          isDeleted: false,
          ...(before ? { sentAt: { lt: before } } : {}),
        },
        include: {
          sender: { select: { id: true, name: true, avatarUrl: true, role: true } },
          replyTo: { select: { id: true, body: true, sender: { select: { name: true } } } },
          readBy:  { select: { userId: true, readAt: true } },
        },
        orderBy: { sentAt: "asc" },
        take: limit,
      });

      // Mark unread messages as read
      const unreadIds = messages
        .filter(m => m.senderId !== Number(userId) && !m.readBy.some(r => r.userId === Number(userId)))
        .map(m => m.id);

      if (unreadIds.length) {
        await prisma.commMessageRead.createMany({
          data: unreadIds.map(msgId => ({ messageId: msgId, userId: Number(userId) })),
          skipDuplicates: true,
        });
        // Update participant lastReadAt
        await prisma.commConversationParticipant.updateMany({
          where: { conversationId: convId, userId: Number(userId) },
          data: { lastReadAt: new Date() },
        });
      }

      return rep.send({ messages, hasMore: messages.length === limit });
    }
  );

  // ─── SEND MESSAGE ─────────────────────────────────────────
  app.post(`${P}/conversation/:id/send`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const convId = Number((req.params as any).id);
      const b = req.body as any;

      const message = await prisma.commMessage.create({
        data: {
          conversationId: convId,
          senderId:       Number(userId),
          type:           b.type as any ?? "TEXT",
          body:           b.body ?? null,
          attachment:     b.attachment ?? null,
          replyToId:      b.replyToId ? Number(b.replyToId) : null,
          status:         "SENT",
        },
        include: {
          sender: { select: { id: true, name: true, avatarUrl: true, role: true } },
          replyTo: { select: { id: true, body: true, sender: { select: { name: true } } } },
        },
      });

      // Update conversation last message preview
      await prisma.commConversation.update({
        where: { id: convId },
        data: {
          lastMessageAt: new Date(),
          lastMessage: b.type === "TEXT" ? (b.body ?? "").slice(0, 100) : `📎 ${b.type}`,
        },
      });

      return rep.code(201).send({ message });
    }
  );

  // ─── EDIT MESSAGE ─────────────────────────────────────────
  app.put(`${P}/message/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const id = Number((req.params as any).id);
      const { body } = req.body as any;
      const message = await prisma.commMessage.update({
        where: { id, senderId: Number(userId) },
        data: { body, editedAt: new Date() },
      });
      return rep.send({ message });
    }
  );

  // ─── DELETE MESSAGE (soft) ────────────────────────────────
  app.delete(`${P}/message/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.commMessage.update({
        where: { id, senderId: Number(userId) },
        data: { isDeleted: true, body: null, attachment: null },
      });
      return rep.send({ ok: true });
    }
  );

  // ─── STAR MESSAGE ─────────────────────────────────────────
  app.post(`${P}/message/:id/star`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const id = Number((req.params as any).id);
      const existing = await prisma.commMessage.findFirst({ where: { id }, select: { isStarred: true } });
      if (!existing) return rep.code(404).send({ error: "Not found" });
      const message = await prisma.commMessage.update({ where: { id }, data: { isStarred: !existing.isStarred } });
      return rep.send({ message, starred: message.isStarred });
    }
  );

  // ─── ARCHIVE / UNARCHIVE CONVERSATION ────────────────────
  app.post(`${P}/conversation/:id/archive`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const conv = await prisma.commConversation.findFirst({ where: { id, schoolId }, select: { isArchived: true } });
      if (!conv) return rep.code(404).send({ error: "Not found" });
      const updated = await prisma.commConversation.update({ where: { id }, data: { isArchived: !conv.isArchived } });
      return rep.send({ conversation: updated });
    }
  );

  // ─── PIN / UNPIN CONVERSATION ─────────────────────────────
  app.post(`${P}/conversation/:id/pin`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const conv = await prisma.commConversation.findFirst({ where: { id, schoolId }, select: { isPinned: true } });
      if (!conv) return rep.code(404).send({ error: "Not found" });
      const updated = await prisma.commConversation.update({ where: { id }, data: { isPinned: !conv.isPinned } });
      return rep.send({ conversation: updated });
    }
  );

  // ─── SEARCH MESSAGES ──────────────────────────────────────
  app.get(`${P}/search`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId, schoolId } = req.user as any;
      const q = req.query as any;
      if (!q.q) return rep.code(400).send({ error: "Query required" });

      const messages = await prisma.commMessage.findMany({
        where: {
          body: { contains: q.q, mode: "insensitive" },
          isDeleted: false,
          conversation: { schoolId, participants: { some: { userId: Number(userId) } } },
        },
        include: {
          conversation: { select: { id: true, type: true } },
          sender: { select: { name: true, avatarUrl: true } },
        },
        orderBy: { sentAt: "desc" },
        take: 20,
      });

      return rep.send({ messages, total: messages.length });
    }
  );

  // ─── STARRED MESSAGES ─────────────────────────────────────
  app.get(`${P}/starred`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const messages = await prisma.commMessage.findMany({
        where: { senderId: Number(userId), isStarred: true, isDeleted: false },
        include: {
          conversation: { select: { id: true, type: true, title: true } },
          sender: { select: { name: true, avatarUrl: true } },
        },
        orderBy: { sentAt: "desc" },
        take: 50,
      });
      return rep.send({ messages });
    }
  );

  // ─── GROUPS CRUD ──────────────────────────────────────────
  app.get(`${P}/groups`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const groups = await prisma.commGroup.findMany({
        where: { schoolId, isActive: true },
        include: { _count: { select: { members: true } } },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ groups });
    }
  );

  app.post(`${P}/groups`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      const group = await prisma.commGroup.create({
        data: {
          schoolId,
          name:        b.name,
          description: b.description ?? null,
          type:        b.type as any ?? "CUSTOM",
          filters:     b.filters ?? {},
          createdById: Number(userId),
          memberCount: b.memberUserIds?.length ?? 0,
        },
      });

      // Add initial members
      if (b.memberUserIds?.length) {
        await prisma.commGroupMember.createMany({
          data: (b.memberUserIds as number[]).map((uid: number) => ({
            groupId: group.id, userId: Number(uid), isAdmin: uid === Number(userId),
          })),
          skipDuplicates: true,
        });
      }

      // Create a conversation for this group
      const participants = (b.memberUserIds ?? []).map((uid: number) => ({ userId: Number(uid) }));
      await prisma.commConversation.create({
        data: {
          schoolId, type: "GROUP", title: b.name, groupId: group.id,
          participants: { create: participants },
        },
      });

      return rep.code(201).send({ group });
    }
  );

  app.post(`${P}/groups/:id/members`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const id = Number((req.params as any).id);
      const { userIds } = req.body as any;
      await prisma.commGroupMember.createMany({
        data: (userIds as number[]).map((uid: number) => ({ groupId: id, userId: Number(uid) })),
        skipDuplicates: true,
      });
      await prisma.commGroup.update({ where: { id }, data: { memberCount: { increment: userIds.length } } });
      return rep.send({ ok: true });
    }
  );

  app.delete(`${P}/groups/:id/members/:userId`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const groupId  = Number((req.params as any).id);
      const userId   = Number((req.params as any).userId);
      await prisma.commGroupMember.delete({ where: { groupId_userId: { groupId, userId } } });
      await prisma.commGroup.update({ where: { id: groupId }, data: { memberCount: { decrement: 1 } } });
      return rep.send({ ok: true });
    }
  );

  // ─── NEW CONVERSATION (group type) ───────────────────────
  app.post(`${P}/conversation/group`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const participantIds = [...new Set([Number(userId), ...(b.participantUserIds ?? []).map(Number)])];

      const conversation = await prisma.commConversation.create({
        data: {
          schoolId, type: "GROUP", title: b.title,
          participants: { create: participantIds.map((uid: number) => ({ userId: uid, isAdmin: uid === Number(userId) })) },
        },
        include: {
          participants: { include: { user: { select: { id: true, name: true, avatarUrl: true, role: true } } } },
        },
      });
      return rep.code(201).send({ conversation });
    }
  );

  // ─── USER SEARCH (for starting new conversation) ─────────
  app.get(`${P}/users/search`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      if (!q.q) return rep.code(400).send({ error: "Query required" });

      const users = await prisma.user.findMany({
        where: {
          schoolId,
          name: { contains: q.q, mode: "insensitive" },
          isActive: true,
        },
        select: { id: true, name: true, avatarUrl: true, role: true },
        take: 20,
      });
      return rep.send({ users });
    }
  );
}
