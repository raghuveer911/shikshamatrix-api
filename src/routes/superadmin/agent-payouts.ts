import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { authenticateSuperAdmin } from "../../middleware/authenticate.js";

const createPayoutSchema = z.object({
  agentId: z.number().int().positive(),
  commissionIds: z.array(z.number().int().positive()).min(1),
  periodStart: z.string(), // ISO date
  periodEnd: z.string(),
});

const markPaidSchema = z.object({
  referenceId: z.string().min(1).max(100), // bank transfer UTR / txn ref
});

export async function superAdminAgentPayoutRoutes(app: FastifyInstance) {
  // ── GET /superadmin/payouts ───────────────────────────────
  app.get(
    "/superadmin/payouts",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { page?: string; limit?: string; agentId?: string; status?: string };
      const page = parseInt(query.page ?? "1");
      const limit = parseInt(query.limit ?? "20");
      const skip = (page - 1) * limit;

      const where: any = {};
      if (query.agentId) where.agentId = parseInt(query.agentId);
      if (query.status && query.status !== "ALL") where.status = query.status;

      const [payouts, total] = await Promise.all([
        prisma.agentPayout.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            agent: { select: { id: true, name: true } },
            _count: { select: { commissions: true } },
          },
        }),
        prisma.agentPayout.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: { payouts, total, page, limit, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  // ── POST /superadmin/payouts ───────────────────────────────
  // Batches a set of already-APPROVED commissions for one agent into a
  // single payout. Doesn't move any money itself — bank transfer stays
  // manual; this just groups what's owed and tracks it.
  app.post(
    "/superadmin/payouts",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createPayoutSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "VALIDATION_ERROR",
          message: parsed.error.errors[0]?.message ?? "Invalid input",
        });
      }

      const { agentId, commissionIds, periodStart, periodEnd } = parsed.data;
      const payload = request.user as any;

      const commissions = await prisma.commissionTransaction.findMany({
        where: { id: { in: commissionIds }, agentId, status: "APPROVED", payoutId: null },
      });

      if (commissions.length !== commissionIds.length) {
        return reply.status(409).send({
          success: false,
          error: "INVALID_SELECTION",
          message: "Some selected commissions are not APPROVED, belong to a different agent, or are already in a payout.",
        });
      }

      const totalAmount = commissions.reduce((sum, c) => sum + Number(c.commissionAmount), 0);

      const payout = await prisma.$transaction(async (tx) => {
        const created = await tx.agentPayout.create({
          data: {
            agentId,
            totalAmount,
            periodStart: new Date(periodStart),
            periodEnd: new Date(periodEnd),
            createdByAdminId: payload.superAdminId,
          },
        });
        await tx.commissionTransaction.updateMany({
          where: { id: { in: commissionIds } },
          data: { payoutId: created.id },
        });
        return created;
      });

      return reply.status(201).send({ success: true, message: "Payout batch created.", data: { payout } });
    }
  );

  // ── PATCH /superadmin/payouts/:id/mark-paid ────────────────
  app.patch(
    "/superadmin/payouts/:id/mark-paid",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = markPaidSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "VALIDATION_ERROR",
          message: parsed.error.errors[0]?.message ?? "Reference is required.",
        });
      }

      const payout = await prisma.agentPayout.findUnique({ where: { id: parseInt(id) } });
      if (!payout) {
        return reply.status(404).send({ success: false, error: "NOT_FOUND", message: "Payout not found." });
      }
      if (payout.status === "PAID") {
        return reply.status(409).send({ success: false, error: "ALREADY_PAID", message: "Payout is already marked paid." });
      }

      const updated = await prisma.$transaction(async (tx) => {
        const p = await tx.agentPayout.update({
          where: { id: payout.id },
          data: { status: "PAID", referenceId: parsed.data.referenceId, paidAt: new Date() },
        });
        await tx.commissionTransaction.updateMany({
          where: { payoutId: payout.id },
          data: { status: "PAID" },
        });
        return p;
      });

      return reply.send({ success: true, message: "Payout marked as paid.", data: { payout: updated } });
    }
  );
}
