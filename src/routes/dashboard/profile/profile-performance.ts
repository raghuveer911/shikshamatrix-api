// apps/api/src/routes/staff/profile-performance.ts
//
// Goals, Performance Reviews (with KPI scores), Appraisal history.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[profile/performance] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function profilePerformanceRoutes(app: FastifyInstance) {

  app.get("/profile/performance",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const staff = await prisma.staff.findFirst({ where: { userId, schoolId }, select: { id: true } });
      if (!staff) return reply.status(404).send({ success: false, error: "STAFF_NOT_FOUND" });

      const [goals, reviews, appraisals] = await Promise.all([
        safe("hrGoal.findMany", () =>
          prisma.hrGoal.findMany({
            where: { staffId: staff.id },
            orderBy: { createdAt: "desc" },
            select: { id: true, title: true, description: true, targetDate: true,
              progress: true, status: true },
          }), [] as any[]),
        safe("hrPerformanceReview.findMany", () =>
          prisma.hrPerformanceReview.findMany({
            where: { staffId: staff.id, status: "PUBLISHED" },
            orderBy: { reviewedAt: "desc" }, take: 5,
            select: {
              id: true, cycle: true, period: true, percentage: true, remarks: true,
              reviewedAt: true, publishedAt: true,
              scores: {
                select: { score: true, remarks: true, kpi: { select: { name: true } } },
              },
            },
          }).catch(() => []), [] as any[]),
        safe("hrAppraisal.findMany", () =>
          prisma.hrAppraisal.findMany({
            where: { staffId: staff.id },
            orderBy: { createdAt: "desc" }, take: 5,
            select: {
              id: true, period: true, currentSalary: true, incrementAmount: true,
              newSalary: true, recommendation: true, status: true, approvedAt: true,
            },
          }), [] as any[]),
      ]);

      const activeGoals = goals.filter((g: any) => g.status === "ACTIVE");
      const avgGoalProgress = activeGoals.length > 0
        ? Math.round(activeGoals.reduce((s: number, g: any) => s + g.progress, 0) / activeGoals.length)
        : null;

      return reply.send({
        success: true,
        data: {
          goals, reviews, appraisals,
          summary: {
            activeGoalsCount: activeGoals.length,
            avgGoalProgress,
            latestReviewPct: reviews[0]?.percentage ?? null,
          },
        },
      });
    }
  );
}