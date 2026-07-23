import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { authenticateSuperAdmin } from "../../middleware/authenticate.js";

const rejectSchema = z.object({
  reason: z.string().min(3).max(300),
});

export async function superAdminAgentCommissionRoutes(app: FastifyInstance) {
  // ── GET /superadmin/commissions ──────────────────────────
  app.get(
    "/superadmin/commissions",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        page?: string;
        limit?: string;
        agentId?: string;
        status?: string;
      };

      const page = parseInt(query.page ?? "1");
      const limit = parseInt(query.limit ?? "20");
      const skip = (page - 1) * limit;

      const where: any = {};
      if (query.agentId) where.agentId = parseInt(query.agentId);
      if (query.status && query.status !== "ALL") where.status = query.status;

      const [transactions, total] = await Promise.all([
        prisma.commissionTransaction.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            agent: { select: { id: true, name: true, level: true } },
            school: { select: { id: true, name: true } },
          },
        }),
        prisma.commissionTransaction.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: { transactions, total, page, limit, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  // ── PATCH /superadmin/commissions/:id/approve ────────────
  app.patch(
    "/superadmin/commissions/:id/approve",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const payload = request.user as any;

      const txn = await prisma.commissionTransaction.findUnique({ where: { id: parseInt(id) } });
      if (!txn) {
        return reply.status(404).send({ success: false, error: "NOT_FOUND", message: "Commission not found." });
      }
      if (txn.status !== "PENDING") {
        return reply.status(409).send({
          success: false,
          error: "INVALID_STATE",
          message: `Only PENDING commissions can be approved (current: ${txn.status}).`,
        });
      }

      const updated = await prisma.commissionTransaction.update({
        where: { id: txn.id },
        data: { status: "APPROVED", approvedByAdminId: payload.superAdminId, approvedAt: new Date() },
      });

      return reply.send({ success: true, message: "Commission approved.", data: { transaction: updated } });
    }
  );

  // ── PATCH /superadmin/commissions/:id/reject ─────────────
  app.patch(
    "/superadmin/commissions/:id/reject",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = rejectSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "VALIDATION_ERROR",
          message: parsed.error.errors[0]?.message ?? "Reason is required.",
        });
      }

      const txn = await prisma.commissionTransaction.findUnique({ where: { id: parseInt(id) } });
      if (!txn) {
        return reply.status(404).send({ success: false, error: "NOT_FOUND", message: "Commission not found." });
      }
      if (txn.status !== "PENDING") {
        return reply.status(409).send({
          success: false,
          error: "INVALID_STATE",
          message: `Only PENDING commissions can be rejected (current: ${txn.status}).`,
        });
      }

      const updated = await prisma.commissionTransaction.update({
        where: { id: txn.id },
        data: { status: "REJECTED", rejectionReason: parsed.data.reason },
      });

      return reply.send({ success: true, message: "Commission rejected.", data: { transaction: updated } });
    }
  );
}
