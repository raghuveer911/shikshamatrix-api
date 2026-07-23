// apps/api/src/routes/admin/study-center/study-lesson-plans-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminStudyLessonPlansRoutes(app: FastifyInstance) {
  const P = "/admin/study/lesson-plans";

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const academicYear = q.academicYear as string | undefined;

      const where: any = { schoolId, ...(academicYear ? { academicYear } : {}) };

      const [total, approved, pendingApproval, byStatus, byMethod] = await Promise.all([
        prisma.studyLessonPlan.count({ where }),
        prisma.studyLessonPlan.count({ where: { ...where, approvalStatus: "APPROVED" } }),
        prisma.studyLessonPlan.count({ where: { ...where, approvalStatus: "PENDING_APPROVAL" } }),
        prisma.studyLessonPlan.groupBy({ by: ["status"],         where, _count: { id: true } }),
        prisma.studyLessonPlan.groupBy({ by: ["teachingMethod"], where, _count: { id: true }, orderBy: { _count: { id: "desc" } } }),
      ]);

      const completedCount = byStatus.find(s => s.status === "COMPLETED")?._count.id ?? 0;
      const completionRate = total > 0 ? Math.round((completedCount / total) * 100) : 0;

      const recent = await prisma.studyLessonPlan.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: 6,
        include: {
          subject: { select: { name: true } },
          chapter: { select: { name: true } },
          staff:   { include: { user: { select: { name: true } } } },
        },
      });

      return rep.send({ total, approved, pendingApproval, completionRate, byStatus, byMethod, recent });
    }
  );

  // ─── LIST LESSON PLANS ────────────────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId };
      if (q.staffId)       where.staffId       = Number(q.staffId);
      if (q.classId)       where.classId       = Number(q.classId);
      if (q.subjectId)     where.subjectId     = Number(q.subjectId);
      if (q.chapterId)     where.chapterId     = Number(q.chapterId);
      if (q.status)        where.status        = q.status;
      if (q.approvalStatus) where.approvalStatus = q.approvalStatus;
      if (q.academicYear)  where.academicYear  = q.academicYear;
      if (q.weekNumber)    where.weekNumber    = Number(q.weekNumber);
      if (q.monthNumber)   where.monthNumber   = Number(q.monthNumber);
      if (q.search)        where.title         = { contains: q.search, mode: "insensitive" };

      const [plans, total] = await Promise.all([
        prisma.studyLessonPlan.findMany({
          where,
          include: {
            subject: { select: { name: true, code: true } },
            chapter: { select: { name: true, chapterNumber: true } },
            topic:   { select: { name: true } },
            class:   { select: { name: true } },
            staff:   { include: { user: { select: { name: true, avatarUrl: true } } } },
            _count:  { select: { materials: true } },
          },
          orderBy: [{ plannedDate: "asc" }, { createdAt: "desc" }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.studyLessonPlan.count({ where }),
      ]);

      return rep.send({ plans, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── GET ONE ──────────────────────────────────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);

      const plan = await prisma.studyLessonPlan.findFirst({
        where: { id, schoolId },
        include: {
          subject: { select: { name: true } },
          chapter: { select: { name: true } },
          topic:   { select: { name: true } },
          class:   { select: { name: true } },
          staff:   { include: { user: { select: { name: true } } } },
          approvedBy: { include: { user: { select: { name: true } } } },
          materials: {
            include: { material: { select: { id: true, title: true, type: true, fileUrl: true, thumbnailUrl: true } } },
            orderBy: { sortOrder: "asc" },
          },
        },
      });
      if (!plan) return rep.code(404).send({ error: "Not found" });
      return rep.send({ plan });
    }
  );

  // ─── CREATE ───────────────────────────────────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId } });
      if (!staff) return rep.code(403).send({ error: "Staff profile not found" });

      const plan = await prisma.studyLessonPlan.create({
        data: {
          schoolId,
          staffId:    b.staffId    ? Number(b.staffId)    : staff.id,
          classId:    b.classId    ? Number(b.classId)    : null,
          subjectId:  b.subjectId  ? Number(b.subjectId)  : null,
          chapterId:  b.chapterId  ? Number(b.chapterId)  : null,
          topicId:    b.topicId    ? Number(b.topicId)    : null,
          title:          b.title,
          objectives:     b.objectives ?? [],
          teachingMethod: b.teachingMethod as any ?? "LECTURE",
          durationMins:   Number(b.durationMins ?? 45),
          outcomes:       b.outcomes ?? [],
          notes:          b.notes ?? null,
          academicYear:   b.academicYear,
          weekNumber:     b.weekNumber  ? Number(b.weekNumber)  : null,
          monthNumber:    b.monthNumber ? Number(b.monthNumber) : null,
          plannedDate:    b.plannedDate ? new Date(b.plannedDate) : null,
          status:         "NOT_STARTED",
          approvalStatus: b.submitForApproval ? "PENDING_APPROVAL" : "DRAFT",
        },
      });

      if (b.materialIds?.length) {
        await prisma.studyLessonPlanMaterial.createMany({
          data: (b.materialIds as number[]).map((mid: number, idx: number) => ({
            lessonPlanId: plan.id, materialId: Number(mid), sortOrder: idx,
          })),
          skipDuplicates: true,
        });
      }

      return rep.code(201).send({ plan });
    }
  );

  // ─── UPDATE ───────────────────────────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const plan = await prisma.studyLessonPlan.update({
        where: { id, schoolId },
        data: {
          title:          b.title,
          objectives:     b.objectives,
          teachingMethod: b.teachingMethod as any,
          durationMins:   b.durationMins   ? Number(b.durationMins)   : undefined,
          outcomes:       b.outcomes,
          notes:          b.notes,
          plannedDate:    b.plannedDate    ? new Date(b.plannedDate)  : undefined,
          weekNumber:     b.weekNumber     ? Number(b.weekNumber)     : undefined,
          monthNumber:    b.monthNumber    ? Number(b.monthNumber)    : undefined,
          status:         b.status as any,
          approvalStatus: b.submitForApproval ? "PENDING_APPROVAL" : (b.approvalStatus as any ?? undefined),
          completedAt:    b.status === "COMPLETED" ? new Date() : undefined,
        },
      });

      if (b.materialIds) {
        await prisma.studyLessonPlanMaterial.deleteMany({ where: { lessonPlanId: id } });
        if (b.materialIds.length) {
          await prisma.studyLessonPlanMaterial.createMany({
            data: (b.materialIds as number[]).map((mid: number, idx: number) => ({
              lessonPlanId: id, materialId: Number(mid), sortOrder: idx,
            })),
          });
        }
      }

      return rep.send({ plan });
    }
  );

  // ─── SOFT DELETE ──────────────────────────────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.studyLessonPlan.update({ where: { id, schoolId }, data: { approvalStatus: "DRAFT" } });
      return rep.send({ ok: true });
    }
  );

  // ─── APPROVE ──────────────────────────────────────────────
  app.post(`${P}/:id/approve`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId } });

      const plan = await prisma.studyLessonPlan.update({
        where: { id, schoolId },
        data: { approvalStatus: "APPROVED", approvedById: staff?.id ?? null, approvedAt: new Date() },
      });
      return rep.send({ plan });
    }
  );

  // ─── REJECT ───────────────────────────────────────────────
  app.post(`${P}/:id/reject`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const plan = await prisma.studyLessonPlan.update({
        where: { id, schoolId },
        data: { approvalStatus: "REJECTED" },
      });
      return rep.send({ plan });
    }
  );

  // ─── CLONE ────────────────────────────────────────────────
  app.post(`${P}/:id/clone`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const src = await prisma.studyLessonPlan.findFirst({
        where: { id, schoolId }, include: { materials: true },
      });
      if (!src) return rep.code(404).send({ error: "Not found" });

      const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId } });
      const clone = await prisma.studyLessonPlan.create({
        data: {
          schoolId,
          staffId:        b.staffId ? Number(b.staffId) : src.staffId,
          classId:        b.classId ? Number(b.classId) : src.classId,
          subjectId:      src.subjectId,
          chapterId:      src.chapterId,
          topicId:        src.topicId,
          title:          b.title ?? `${src.title} (Clone)`,
          objectives:     src.objectives,
          teachingMethod: src.teachingMethod,
          durationMins:   src.durationMins,
          outcomes:       src.outcomes,
          notes:          src.notes,
          academicYear:   b.academicYear ?? src.academicYear,
          weekNumber:     b.weekNumber  ? Number(b.weekNumber)  : null,
          monthNumber:    b.monthNumber ? Number(b.monthNumber) : null,
          plannedDate:    b.plannedDate ? new Date(b.plannedDate) : null,
          status:         "NOT_STARTED",
          approvalStatus: "DRAFT",
          clonedFromId:   src.id,
        },
      });

      if (src.materials.length) {
        await prisma.studyLessonPlanMaterial.createMany({
          data: src.materials.map(m => ({ lessonPlanId: clone.id, materialId: m.materialId, sortOrder: m.sortOrder })),
        });
      }

      return rep.code(201).send({ plan: clone });
    }
  );

  // ─── WEEKLY VIEW ──────────────────────────────────────────
  app.get(`${P}/calendar/weekly`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const weekNumber   = Number(q.weekNumber ?? 1);
      const academicYear = q.academicYear as string;

      const plans = await prisma.studyLessonPlan.findMany({
        where: { schoolId, weekNumber, academicYear },
        include: {
          subject: { select: { name: true } },
          chapter: { select: { name: true } },
          class:   { select: { name: true } },
          staff:   { include: { user: { select: { name: true } } } },
        },
        orderBy: { plannedDate: "asc" },
      });

      // Group by day
      const byDay: Record<string, any[]> = {};
      plans.forEach(p => {
        const key = p.plannedDate ? new Date(p.plannedDate).toISOString().split("T")[0] : "unscheduled";
        if (!byDay[key]) byDay[key] = [];
        byDay[key].push(p);
      });

      return rep.send({ weekNumber, academicYear, total: plans.length, byDay });
    }
  );

  // ─── MONTHLY VIEW ─────────────────────────────────────────
  app.get(`${P}/calendar/monthly`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const monthNumber  = Number(q.monthNumber ?? 1);
      const academicYear = q.academicYear as string;

      const plans = await prisma.studyLessonPlan.findMany({
        where: { schoolId, monthNumber, academicYear },
        include: {
          subject: { select: { name: true } },
          chapter: { select: { name: true } },
          class:   { select: { name: true } },
          staff:   { include: { user: { select: { name: true } } } },
        },
        orderBy: { plannedDate: "asc" },
      });

      // Summary per week
      const weeklySummary: Record<number, { total: number; completed: number }> = {};
      plans.forEach(p => {
        const w = p.weekNumber ?? 0;
        if (!weeklySummary[w]) weeklySummary[w] = { total: 0, completed: 0 };
        weeklySummary[w].total++;
        if (p.status === "COMPLETED") weeklySummary[w].completed++;
      });

      return rep.send({ monthNumber, academicYear, total: plans.length, plans, weeklySummary });
    }
  );

  // ─── REPORTS ──────────────────────────────────────────────
  app.get(`${P}/reports/teacher`, { preHandler: [authenticate, requireCapability('studyCenter.advanced')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const where: any = { schoolId, ...(q.academicYear ? { academicYear: q.academicYear } : {}) };

      const grouped = await prisma.studyLessonPlan.groupBy({
        by: ["staffId", "status"],
        where,
        _count: { id: true },
      });

      const staffIds = [...new Set(grouped.map(g => g.staffId))];
      const staffDetails = await prisma.staff.findMany({
        where: { id: { in: staffIds } },
        include: { user: { select: { name: true } } },
      });

      const report = staffIds.map(sid => {
        const rows      = grouped.filter(g => g.staffId === sid);
        const total     = rows.reduce((s, r) => s + r._count.id, 0);
        const completed = rows.filter(r => r.status === "COMPLETED").reduce((s, r) => s + r._count.id, 0);
        const staff     = staffDetails.find(s => s.id === sid);
        return { staffId: sid, name: staff?.user?.name ?? "—", total, completed, pct: total > 0 ? Math.round((completed / total) * 100) : 0 };
      }).sort((a, b) => b.pct - a.pct);

      return rep.send({ report });
    }
  );
}
