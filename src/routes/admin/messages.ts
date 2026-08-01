import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { assertStorageLimitNotExceeded, StorageLimitError } from "../../services/storage.service.js";
import path from "path";
import fs from "fs";

export async function adminMessageRoutes(app: FastifyInstance) {

  // ── GET /admin/messages/conversations ─────────────────────
  app.get("/admin/messages/conversations",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const query = request.query as { type?: string; search?: string };

      const where: any = {
        schoolId,
        participants: { some: { userId } },
        isArchived: false,
      };
      if (query.type) where.type = query.type;

      const conversations = await prisma.conversation.findMany({
        where,
        orderBy: [{ isPinned: "desc" }, { lastMessageAt: "desc" }],
        include: {
          participants: {
            include: {
              user: { select: { id: true, name: true, avatarUrl: true, role: true } },
            },
          },
          messages: {
            where: { isDeleted: false },
            orderBy: { createdAt: "desc" },
            take: 1,
            include: { sender: { select: { id: true, name: true } } },
          },
          _count: { select: { messages: true } },
        },
      });

      // Add unread count per conversation
      const convsWithUnread = await Promise.all(conversations.map(async conv => {
        const participant = conv.participants.find(p => p.userId === userId);
        const unreadCount = await prisma.message.count({
          where: {
            conversationId: conv.id,
            isDeleted: false,
            createdAt: participant?.lastReadAt ? { gt: participant.lastReadAt } : undefined,
            senderId: { not: userId },
          },
        });
        return { ...conv, unreadCount };
      }));

      // Filter by search
      const filtered = query.search
        ? convsWithUnread.filter(c =>
            c.title?.toLowerCase().includes(query.search!.toLowerCase()) ||
            c.participants.some(p => p.user.name.toLowerCase().includes(query.search!.toLowerCase()))
          )
        : convsWithUnread;

      return reply.send({ success: true, data: { conversations: filtered } });
    }
  );

  // ── POST /admin/messages/conversations ────────────────────
  app.post("/admin/messages/conversations",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        type: "DIRECT" | "GROUP" | "BROADCAST";
        title?: string;
        description?: string;
        participantIds: number[];
        // For broadcast
        targetType?: "CLASS" | "GRADE";
        targetId?: number;
        gradeNumber?: string;
      };

      if (!body.participantIds?.length) {
        return reply.status(400).send({ success: false, message: "Add at least one participant." });
      }

      // For DIRECT: check existing conversation
      if (body.type === "DIRECT") {
        const otherId = body.participantIds[0];
        const existing = await prisma.conversation.findFirst({
          where: {
            schoolId, type: "DIRECT",
            AND: [
              { participants: { some: { userId } } },
              { participants: { some: { userId: otherId } } },
            ],
          },
        });
        if (existing) return reply.send({ success: true, data: { conversation: existing } });
      }

      // For BROADCAST: get all users of class/grade
      let allParticipantIds = [...body.participantIds];
      if (body.type === "BROADCAST" && body.targetType) {
        if (body.targetType === "CLASS" && body.targetId) {
          const cls = await prisma.class.findFirst({
            where: { id: body.targetId, schoolId },
            include: {
              students: { include: { user: { select: { id: true } } } },
              classTeacher: { include: { user: { select: { id: true } } } },
            },
          });
          if (cls) {
            const studentUserIds = cls.students.map((s: any) => s.user.id);
            if (cls.classTeacher) allParticipantIds.push(cls.classTeacher.user.id);
            allParticipantIds = [...new Set([...allParticipantIds, ...studentUserIds])];
          }
        } else if (body.targetType === "GRADE" && body.gradeNumber) {
          const classes = await prisma.class.findMany({
            where: { schoolId, classNumber: body.gradeNumber },
            include: {
              students: { include: { user: { select: { id: true } } } },
              classTeacher: { include: { user: { select: { id: true } } } },
            },
          });
          classes.forEach((cls: any) => {
            cls.students.forEach((s: any) => allParticipantIds.push(s.user.id));
            if (cls.classTeacher) allParticipantIds.push(cls.classTeacher.user.id);
          });
          allParticipantIds = [...new Set(allParticipantIds)];
        }
      }

      const conversation = await prisma.conversation.create({
        data: {
          schoolId,
          type: body.type,
          title: body.title ?? null,
          description: body.description ?? null,
          createdById: userId,
          participants: {
            create: [
              { userId, isAdmin: true },
              ...allParticipantIds
                .filter(id => id !== userId)
                .map(id => ({ userId: id, isAdmin: false })),
            ],
          },
        },
        include: {
          participants: {
            include: { user: { select: { id: true, name: true, avatarUrl: true, role: true } } },
          },
        },
      });

      return reply.status(201).send({ success: true, data: { conversation } });
    }
  );

  // ── GET /admin/messages/conversations/:id/messages ────────
  app.get("/admin/messages/conversations/:id/messages",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const { id } = request.params as { id: string };
      const query = request.query as { before?: string; limit?: string };

      const conv = await prisma.conversation.findFirst({
        where: { id: parseInt(id), schoolId, participants: { some: { userId } } },
      });
      if (!conv) return reply.status(404).send({ success: false, message: "Conversation not found." });

      const limit = parseInt(query.limit ?? "30");
      const messages = await prisma.message.findMany({
        where: {
          conversationId: parseInt(id),
          isDeleted: false,
          ...(query.before && { createdAt: { lt: new Date(query.before) } }),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: {
          sender: { select: { id: true, name: true, avatarUrl: true, role: true } },
          replyTo: {
            include: { sender: { select: { id: true, name: true } } },
          },
          reads: { select: { userId: true, readAt: true } },
        },
      });

      // Mark messages as read
      await prisma.conversationParticipant.updateMany({
        where: { conversationId: parseInt(id), userId },
        data: { lastReadAt: new Date() },
      });

      return reply.send({
        success: true,
        data: { messages: messages.reverse(), hasMore: messages.length === limit },
      });
    }
  );

  // ── POST /admin/messages/conversations/:id/messages ───────
  app.post("/admin/messages/conversations/:id/messages",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as {
        content: string;
        type?: "TEXT" | "IMAGE" | "FILE";
        fileUrl?: string;
        fileName?: string;
        fileSize?: number;
        replyToId?: number;
      };

      if (!body.content?.trim() && !body.fileUrl) {
        return reply.status(400).send({ success: false, message: "Message cannot be empty." });
      }

      const conv = await prisma.conversation.findFirst({
        where: { id: parseInt(id), schoolId, participants: { some: { userId } } },
      });
      if (!conv) return reply.status(404).send({ success: false, message: "Conversation not found." });

      if (body.fileSize && body.fileSize > 0) {
        try {
          await assertStorageLimitNotExceeded(schoolId, body.fileSize);
        } catch (err) {
          if (err instanceof StorageLimitError) return reply.status(507).send({ success: false, message: err.message });
          throw err;
        }
      }

      const message = await prisma.message.create({
        data: {
          conversationId: parseInt(id),
          senderId: userId,
          content: body.content?.trim() ?? "",
          type: body.type ?? "TEXT",
          fileUrl: body.fileUrl ?? null,
          fileName: body.fileName ?? null,
          fileSize: body.fileSize ?? null,
          replyToId: body.replyToId ?? null,
        },
        include: {
          sender: { select: { id: true, name: true, avatarUrl: true, role: true } },
          replyTo: {
            include: { sender: { select: { id: true, name: true } } },
          },
          reads: { select: { userId: true, readAt: true } },
        },
      });

      // Update conversation preview
      await prisma.conversation.update({
        where: { id: parseInt(id) },
        data: {
          lastMessageAt: new Date(),
          lastMessagePreview: body.content.trim().slice(0, 100),
        },
      });

      return reply.status(201).send({ success: true, data: { message } });
    }
  );

  // ── DELETE /admin/messages/:messageId ─────────────────────
  app.delete("/admin/messages/:messageId",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.user as any;
      const { messageId } = request.params as { messageId: string };

      await prisma.message.updateMany({
        where: { id: parseInt(messageId), senderId: userId },
        data: { isDeleted: true, content: "This message was deleted" },
      });

      return reply.send({ success: true, message: "Message deleted." });
    }
  );

  // ── PATCH /admin/messages/conversations/:id ───────────────
  app.patch("/admin/messages/conversations/:id",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as {
        isPinned?: boolean;
        isArchived?: boolean;
        isMuted?: boolean;
        title?: string;
      };

      if (body.isMuted !== undefined) {
        await prisma.conversationParticipant.updateMany({
          where: { conversationId: parseInt(id), userId },
          data: { isMuted: body.isMuted },
        });
      }

      const updated = await prisma.conversation.update({
        where: { id: parseInt(id) },
        data: {
          ...(body.isPinned !== undefined && { isPinned: body.isPinned }),
          ...(body.isArchived !== undefined && { isArchived: body.isArchived }),
          ...(body.title && { title: body.title }),
        },
      });

      return reply.send({ success: true, data: { conversation: updated } });
    }
  );

  // ── GET /admin/messages/staff ─────────────────────────────
  // Get all staff for new conversation
  app.get("/admin/messages/staff",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;

      const staff = await prisma.staff.findMany({
        where: { schoolId, isActive: true },
        include: {
          user: { select: { id: true, name: true, avatarUrl: true, isActive: true } },
        },
        orderBy: { user: { name: "asc" } },
      });

      return reply.send({ success: true, data: { staff } });
    }
  );

  // ── GET /admin/messages/unread-count ─────────────────────
  app.get("/admin/messages/unread-count",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;

      const participants = await prisma.conversationParticipant.findMany({
        where: {
          userId,
          conversation: { schoolId },
        },
        select: { conversationId: true, lastReadAt: true },
      });

      let total = 0;
      for (const p of participants) {
        const count = await prisma.message.count({
          where: {
            conversationId: p.conversationId,
            isDeleted: false,
            senderId: { not: userId },
            ...(p.lastReadAt && { createdAt: { gt: p.lastReadAt } }),
          },
        });
        total += count;
      }

      return reply.send({ success: true, data: { unreadCount: total } });
    }
  );
}