// apps/api/src/routes/admin/hr/performance-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminPerformanceRoutes(app: FastifyInstance) {
  const P = "/admin/hr/performance";

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [kpis, pendingReviews, activeGoals, pendingAppraisals] = await Promise.all([
        prisma.hrKpi.count({ where: { schoolId, isActive: true } }),
        prisma.hrPerformanceReview.count({ where: { schoolId, status: "SUBMITTED" } }),
        prisma.hrGoal.count({ where: { schoolId, status: "ACTIVE" } }),
        prisma.hrAppraisal.count({ where: { schoolId, status: "PENDING" } }),
      ]);
      const avgScore = await prisma.hrPerformanceReview.aggregate({
        where: { schoolId, status: "PUBLISHED" },
        _avg: { percentage: true },
      });
      const topPerformers = await prisma.hrPerformanceReview.findMany({
        where: { schoolId, status: "PUBLISHED", percentage: { gte: 80 } },
        orderBy: { percentage: "desc" },
        take: 5,
        include: { staff: { include: { user: { select: { name: true, avatarUrl: true } } } } },
      });
      const recentReviews = await prisma.hrPerformanceReview.findMany({
        where: { schoolId },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { staff: { include: { user: { select: { name: true } } } } },
      });
      return rep.send({ kpis, pendingReviews, activeGoals, pendingAppraisals, avgScore: avgScore._avg.percentage, topPerformers, recentReviews });
    }
  );

  // ─── KPIs ─────────────────────────────────────────────────
  app.get(`${P}/kpis`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const kpis = await prisma.hrKpi.findMany({
        where: {
          schoolId,
          ...(q.deptId ? { departmentId: Number(q.deptId) } : {}),
          ...(q.type ? { employeeType: q.type } : {}),
        },
        include: { department: { select: { name: true } } },
        orderBy: { name: "asc" },
      });
      return rep.send({ kpis });
    }
  );

  app.post(`${P}/kpis`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const kpi = await prisma.hrKpi.create({
        data: {
          schoolId,
          name: b.name,
          description: b.description ?? null,
          departmentId: b.departmentId ? Number(b.departmentId) : null,
          employeeType: b.employeeType ?? null,
          target: b.target ?? null,
          unit: b.unit ?? null,
          weightage: Number(b.weightage ?? 10),
        },
      });
      return rep.send({ kpi });
    }
  );

  app.put(`${P}/kpis/:id`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const kpi = await prisma.hrKpi.update({
        where: { id, schoolId },
        data: {
          name: b.name,
          description: b.description,
          departmentId: b.departmentId ? Number(b.departmentId) : null,
          employeeType: b.employeeType,
          target: b.target,
          unit: b.unit,
          weightage: b.weightage ? Number(b.weightage) : undefined,
          isActive: b.isActive !== undefined ? b.isActive : undefined,
        },
      });
      return rep.send({ kpi });
    }
  );

  app.delete(`${P}/kpis/:id`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.hrKpi.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─── REVIEWS ──────────────────────────────────────────────
  app.get(`${P}/reviews`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const reviews = await prisma.hrPerformanceReview.findMany({
        where: {
          schoolId,
          ...(q.status ? { status: q.status as any } : {}),
          ...(q.staffId ? { staffId: Number(q.staffId) } : {}),
          ...(q.period ? { period: q.period } : {}),
        },
        include: {
          staff: {
            include: {
              user: { select: { name: true, avatarUrl: true } },
              departmentRef: { select: { name: true } },
              designationRef: { select: { name: true } },
            },
          },
          scores: { include: { kpi: { select: { name: true } } } },
        },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ reviews });
    }
  );

  app.post(`${P}/reviews`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const review = await prisma.hrPerformanceReview.create({
        data: {
          schoolId,
          staffId: Number(b.staffId),
          cycle: b.cycle ?? "YEARLY",
          period: b.period,
          status: "DRAFT",
          remarks: b.remarks ?? null,
          reviewerId: b.reviewerId ? Number(b.reviewerId) : null,
        },
      });
      return rep.send({ review });
    }
  );

  app.put(`${P}/reviews/:id`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      // Upsert scores if provided
      if (b.scores && Array.isArray(b.scores)) {
        for (const s of b.scores) {
          await prisma.hrReviewScore.upsert({
            where: { reviewId_kpiId: { reviewId: id, kpiId: Number(s.kpiId) } },
            create: {
              reviewId: id, kpiId: Number(s.kpiId),
              staffId: Number(b.staffId), score: s.score, remarks: s.remarks ?? null,
            },
            update: { score: s.score, remarks: s.remarks ?? null },
          });
        }
      }

      // Calc percentage if scores exist
      let percentage: number | undefined;
      if (b.scores) {
        const allKpis = await prisma.hrKpi.findMany({ where: { schoolId } });
        const scores2 = await prisma.hrReviewScore.findMany({ where: { reviewId: id } });
        if (scores2.length > 0) {
          const totalWeightage = allKpis.reduce((s, k) => s + k.weightage, 0) || 100;
          const weighted = scores2.reduce((acc, sc) => {
            const kpi = allKpis.find(k => k.id === sc.kpiId);
            const w = kpi?.weightage ?? 10;
            const max = kpi?.target ? Number(kpi.target) : 5;
            return acc + (Number(sc.score) / max) * 100 * (w / totalWeightage);
          }, 0);
          percentage = Math.round(weighted);
        }
      }

      const review = await prisma.hrPerformanceReview.update({
        where: { id, schoolId },
        data: {
          remarks: b.remarks ?? undefined,
          status: b.status as any ?? undefined,
          percentage: percentage !== undefined ? percentage : undefined,
          reviewedAt: b.status === "SUBMITTED" ? new Date() : undefined,
          publishedAt: b.status === "PUBLISHED" ? new Date() : undefined,
        },
      });
      return rep.send({ review });
    }
  );

  // ─── GOALS ────────────────────────────────────────────────
  app.get(`${P}/goals`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const goals = await prisma.hrGoal.findMany({
        where: {
          schoolId,
          ...(q.staffId ? { staffId: Number(q.staffId) } : {}),
          ...(q.status ? { status: q.status as any } : {}),
        },
        include: {
          staff: { include: { user: { select: { name: true, avatarUrl: true } } } },
        },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ goals });
    }
  );

  app.post(`${P}/goals`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const goal = await prisma.hrGoal.create({
        data: {
          schoolId,
          staffId: Number(b.staffId),
          title: b.title,
          description: b.description ?? null,
          targetDate: b.targetDate ? new Date(b.targetDate) : null,
          progress: 0,
          status: "ACTIVE",
          assignedById: Number(userId),
        },
      });
      return rep.send({ goal });
    }
  );

  app.put(`${P}/goals/:id/progress`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const goal = await prisma.hrGoal.update({
        where: { id, schoolId },
        data: {
          progress: Number(b.progress),
          status: Number(b.progress) >= 100 ? "COMPLETED" : "ACTIVE",
        },
      });
      return rep.send({ goal });
    }
  );

  app.put(`${P}/goals/:id/status`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const goal = await prisma.hrGoal.update({
        where: { id, schoolId },
        data: { status: b.status as any },
      });
      return rep.send({ goal });
    }
  );

  app.delete(`${P}/goals/:id`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.hrGoal.update({ where: { id, schoolId }, data: { status: "CANCELLED" } });
      return rep.send({ ok: true });
    }
  );

  // ─── APPRAISALS ───────────────────────────────────────────
  app.get(`${P}/appraisals`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const appraisals = await prisma.hrAppraisal.findMany({
        where: {
          schoolId,
          ...(q.staffId ? { staffId: Number(q.staffId) } : {}),
          ...(q.status ? { status: q.status as any } : {}),
          ...(q.period ? { period: q.period } : {}),
        },
        include: {
          staff: {
            include: {
              user: { select: { name: true, avatarUrl: true } },
              departmentRef: { select: { name: true } },
              designationRef: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ appraisals });
    }
  );

  app.post(`${P}/appraisals`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      // Get current salary
      const staff = await prisma.staff.findFirst({ where: { id: Number(b.staffId), schoolId } });
      const appraisal = await prisma.hrAppraisal.create({
        data: {
          schoolId,
          staffId: Number(b.staffId),
          period: b.period,
          currentSalary: staff?.salary ?? 0,
          incrementAmount: b.incrementAmount ? Number(b.incrementAmount) : null,
          newSalary: b.incrementAmount ? Number(staff?.salary ?? 0) + Number(b.incrementAmount) : null,
          newDesigId: b.newDesigId ? Number(b.newDesigId) : null,
          recommendation: b.recommendation ?? null,
          status: "PENDING",
        },
      });
      return rep.send({ appraisal });
    }
  );

  app.post(`${P}/appraisals/:id/approve`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const appraisal = await prisma.hrAppraisal.update({
        where: { id, schoolId },
        data: { status: "APPROVED", approvedById: Number(userId), approvedAt: new Date() },
      });
      // Apply salary update
      if (appraisal.newSalary) {
        await prisma.staff.update({
          where: { id: appraisal.staffId },
          data: {
            salary: appraisal.newSalary,
            ...(appraisal.newDesigId ? { designationId: appraisal.newDesigId } : {}),
          },
        });
      }
      return rep.send({ ok: true });
    }
  );

  app.post(`${P}/appraisals/:id/reject`, { preHandler: [authenticate, requireCapability('hr.performanceManagement')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      await prisma.hrAppraisal.update({
        where: { id, schoolId },
        data: { status: "REJECTED", rejectionReason: b.reason ?? null },
      });
      return rep.send({ ok: true });
    }
  );
}
