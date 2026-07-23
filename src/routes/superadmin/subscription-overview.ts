import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authenticateSuperAdmin } from "../../middleware/authenticate.js";
import { prisma } from "../../lib/prisma.js";

export async function superAdminSubscriptionOverviewRoutes(app: FastifyInstance) {

  // ── GET /superadmin/subscriptions/overview ──────────────
  // Company-wide subscription health: tier distribution, trial/expired
  // counts, estimated MRR, and schools needing attention.
  app.get(
    "/superadmin/subscriptions/overview",
    { preHandler: [authenticateSuperAdmin] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const [
        byTier,
        byStatus,
        trialCount,
        noSubscriptionCount,
        totalSchools,
        allActiveSubs,
      ] = await Promise.all([
        prisma.subscriptionPlan.findMany({
          select: { tier: true, name: true, monthlyPrice: true, perStudentPrice: true, _count: { select: { schoolSubscriptions: true } } },
        }),
        prisma.schoolSubscription.groupBy({ by: ["status"], _count: { status: true } }),
        prisma.schoolSubscription.count({ where: { isTrial: true, status: "ACTIVE" } }),
        prisma.school.count({ where: { schoolSubscription: null } }),
        prisma.school.count(),
        // Pull active, non-trial subscriptions with plan pricing to estimate MRR.
        prisma.schoolSubscription.findMany({
          where: { status: "ACTIVE", isTrial: false },
          select: {
            plan: { select: { monthlyPrice: true, perStudentPrice: true } },
            school: { select: { totalStudents: true } },
          },
        }),
      ]);

      // Rough MRR estimate: flat monthlyPrice plans add directly; per-student
      // plans multiply by the school's current student count.
      let estimatedMrr = 0;
      for (const sub of allActiveSubs) {
        if (sub.plan.perStudentPrice) {
          estimatedMrr += Number(sub.plan.perStudentPrice) * (sub.school.totalStudents ?? 0);
        } else {
          estimatedMrr += Number(sub.plan.monthlyPrice);
        }
      }

      return reply.send({
        success: true,
        data: {
          totalSchools,
          noSubscriptionCount,
          trialCount,
          estimatedMrr: Math.round(estimatedMrr),
          byTier: byTier.map(p => ({
            tier: p.tier, name: p.name,
            monthlyPrice: p.monthlyPrice, perStudentPrice: p.perStudentPrice,
            schoolCount: p._count.schoolSubscriptions,
          })),
          byStatus: byStatus.map(s => ({ status: s.status, count: s._count.status })),
        },
      });
    }
  );

  // ── GET /superadmin/subscriptions/renewals-upcoming ─────
  // Active, non-trial subscriptions renewing in the next 30 days.
  app.get(
    "/superadmin/subscriptions/renewals-upcoming",
    { preHandler: [authenticateSuperAdmin] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now = new Date();
      const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const renewals = await prisma.schoolSubscription.findMany({
        where: {
          status: "ACTIVE",
          isTrial: false,
          billingCycleEnd: { gte: now, lte: in30Days },
        },
        orderBy: { billingCycleEnd: "asc" },
        include: {
          school: { select: { id: true, name: true, adminEmail: true } },
          plan: { select: { tier: true, name: true, monthlyPrice: true, perStudentPrice: true } },
        },
      });

      return reply.send({ success: true, data: { renewals } });
    }
  );

  // ── GET /superadmin/subscriptions/at-risk ───────────────
  // Schools in GRACE (payment/renewal issue) or newly EXPIRED, needing
  // superadmin follow-up.
  app.get(
    "/superadmin/subscriptions/at-risk",
    { preHandler: [authenticateSuperAdmin] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const atRisk = await prisma.schoolSubscription.findMany({
        where: { status: { in: ["GRACE", "EXPIRED"] } },
        orderBy: { billingCycleEnd: "desc" },
        include: {
          school: { select: { id: true, name: true, adminEmail: true, adminPhone: true } },
          plan: { select: { tier: true, name: true } },
        },
      });

      return reply.send({ success: true, data: { schools: atRisk } });
    }
  );

  // ── GET /superadmin/subscriptions/transactions ──────────
  // Cross-school subscription event/payment log (from SubscriptionHistory),
  // paginated, most recent first.
  app.get(
    "/superadmin/subscriptions/transactions",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { page?: string; limit?: string; event?: string; schoolId?: string };
      const page = parseInt(query.page ?? "1");
      const limit = parseInt(query.limit ?? "20");
      const skip = (page - 1) * limit;

      const where: any = {};
      if (query.event) where.event = query.event;
      if (query.schoolId) where.schoolId = parseInt(query.schoolId);

      const [transactions, total] = await Promise.all([
        prisma.subscriptionHistory.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
        }),
        prisma.subscriptionHistory.count({ where }),
      ]);

      // Attach school names (kept as a simple lookup since SubscriptionHistory
      // stores schoolId as a plain int, not a Prisma relation to School).
      const schoolIds = [...new Set(transactions.map(t => t.schoolId))];
      const schools = await prisma.school.findMany({
        where: { id: { in: schoolIds } },
        select: { id: true, name: true },
      });
      const schoolMap = new Map(schools.map(s => [s.id, s.name]));

      return reply.send({
        success: true,
        data: {
          transactions: transactions.map(t => ({ ...t, schoolName: schoolMap.get(t.schoolId) ?? "Unknown" })),
          pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        },
      });
    }
  );
}
