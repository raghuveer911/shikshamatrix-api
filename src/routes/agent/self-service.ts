import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticateAgent } from "../../middleware/authenticate.js";
import { commissionPercentForLevel } from "../../utils/agentLevel.js";

// All routes here scope strictly to request.user.agentId (from the JWT) —
// never to a param — so an agent can only ever see their own data.
export async function agentSelfServiceRoutes(app: FastifyInstance) {
  // ── GET /agent/dashboard ─────────────────────────────────
  app.get(
    "/agent/dashboard",
    { preHandler: [authenticateAgent] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { agentId } = request.user as any;

      const agent = await prisma.agent.findUnique({ where: { id: agentId } });
      if (!agent) {
        return reply.status(404).send({ success: false, error: "NOT_FOUND", message: "Agent not found." });
      }

      const [pendingAgg, approvedAgg, paidAgg, activeSchools] = await Promise.all([
        prisma.commissionTransaction.aggregate({ where: { agentId, status: "PENDING" }, _sum: { commissionAmount: true }, _count: true }),
        prisma.commissionTransaction.aggregate({ where: { agentId, status: "APPROVED" }, _sum: { commissionAmount: true }, _count: true }),
        prisma.commissionTransaction.aggregate({ where: { agentId, status: "PAID" }, _sum: { commissionAmount: true }, _count: true }),
        prisma.agentSchoolMapping.count({ where: { agentId, status: "ACTIVE" } }),
      ]);

      return reply.send({
        success: true,
        data: {
          agent: {
            id: agent.id,
            name: agent.name,
            email: agent.email,
            phone: agent.phone,
            referralCode: agent.referralCode,
            level: agent.level,
            commissionPercent: commissionPercentForLevel(agent.level),
            schoolCount: activeSchools,
          },
          commissionSummary: {
            pending: { amount: pendingAgg._sum.commissionAmount ?? 0, count: pendingAgg._count },
            approved: { amount: approvedAgg._sum.commissionAmount ?? 0, count: approvedAgg._count },
            paid: { amount: paidAgg._sum.commissionAmount ?? 0, count: paidAgg._count },
          },
        },
      });
    }
  );

  // ── GET /agent/schools ───────────────────────────────────
  app.get(
    "/agent/schools",
    { preHandler: [authenticateAgent] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { agentId } = request.user as any;
      const mappings = await prisma.agentSchoolMapping.findMany({
        where: { agentId, status: "ACTIVE" },
        include: {
          school: {
            select: {
              id: true, name: true, city: true, status: true,
              schoolSubscription: { select: { status: true, plan: { select: { tier: true, name: true } } } },
            },
          },
        },
        orderBy: { assignedAt: "desc" },
      });
      return reply.send({ success: true, data: { schools: mappings.map((m) => ({ ...m.school, mappedSince: m.assignedAt })) } });
    }
  );

  // ── GET /agent/commissions ───────────────────────────────
  app.get(
    "/agent/commissions",
    { preHandler: [authenticateAgent] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { agentId } = request.user as any;
      const query = request.query as { page?: string; limit?: string; status?: string };
      const page = parseInt(query.page ?? "1");
      const limit = parseInt(query.limit ?? "20");
      const skip = (page - 1) * limit;

      const where: any = { agentId };
      if (query.status && query.status !== "ALL") where.status = query.status;

      const [transactions, total] = await Promise.all([
        prisma.commissionTransaction.findMany({
          where, skip, take: limit, orderBy: { createdAt: "desc" },
          include: { school: { select: { id: true, name: true } } },
        }),
        prisma.commissionTransaction.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: { transactions, total, page, limit, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  // ── GET /agent/payouts ───────────────────────────────────
  app.get(
    "/agent/payouts",
    { preHandler: [authenticateAgent] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { agentId } = request.user as any;
      const payouts = await prisma.agentPayout.findMany({
        where: { agentId },
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { commissions: true } } },
      });
      return reply.send({ success: true, data: { payouts } });
    }
  );
}
