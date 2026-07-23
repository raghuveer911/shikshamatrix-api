// apps/api/src/routes/dashboard/messages/actions.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";

export async function messagesActionsRoutes(app: FastifyInstance) {

  // ── PATCH /messages/messages/:id/star ─────────────────────────
  app.patch("/messages/messages/:id/star",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = req as any;
      const { id } = req.params as { id: string };
      const messageId = parseInt(id);

      const msg = await prisma.commMessage.findUnique({
        where: { id: messageId },
        select: { id: true, isStarred: true, conversation: { select: { participants: { select: { userId: true } } } } },
      });
      if (!msg) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      const isParticipant = msg.conversation.participants.some((p) => p.userId === userId);
      if (!isParticipant) return reply.status(403).send({ success: false, error: "NOT_PARTICIPANT" });

      const updated = await prisma.commMessage.update({
        where: { id: messageId }, data: { isStarred: !msg.isStarred },
      });

      return reply.send({ success: true, data: { isStarred: updated.isStarred } });
    }
  );

  // ── DELETE /messages/messages/:id — soft delete for me ────────
  // NOTE: schema's isDeleted is a single shared flag (no per-user delete
  // list), so this currently deletes the message for ALL participants,
  // not just the caller. If you want true "delete for me only", a
  // separate CommMessageDeletion(userId, messageId) join table would be
  // needed — flagging this so you can decide if that's worth adding.
  app.delete("/messages/messages/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = req as any;
      const { id } = req.params as { id: string };
      const messageId = parseInt(id);

      const msg = await prisma.commMessage.findUnique({
        where: { id: messageId },
        select: { id: true, senderId: true, conversation: { select: { participants: { select: { userId: true } } } } },
      });
      if (!msg) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      const isParticipant = msg.conversation.participants.some((p) => p.userId === userId);
      if (!isParticipant) return reply.status(403).send({ success: false, error: "NOT_PARTICIPANT" });

      await prisma.commMessage.update({ where: { id: messageId }, data: { isDeleted: true } });
      return reply.send({ success: true, message: "Message deleted" });
    }
  );
}