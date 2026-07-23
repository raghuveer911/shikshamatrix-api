// apps/api/src/routes/student/academics-lessonplans.ts
//
// Lesson Plans — student-facing READ-ONLY view. Only shows plans
// with approvalStatus: "APPROVED" (confirmed enum value) — drafts
// and pending-approval plans are teacher-internal, not shown to
// students.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/academics-lessonplans] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function studentAcademicsLessonPlansRoutes(app: FastifyInstance) {

  app.get("/student/academics/lesson-plans",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { subjectId } = req.query as { subjectId?: string };

      const student = await safe("student lookup", () =>
        prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { classId: true } }), null);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const plans = await safe("lesson plans", () =>
        prisma.studyLessonPlan.findMany({
          where: {
            schoolId, classId: student.classId, approvalStatus: "APPROVED",
            ...(subjectId ? { subjectId: parseInt(subjectId) } : {}),
          },
          orderBy: [{ plannedDate: "asc" }, { createdAt: "desc" }],
          select: {
            id: true, title: true, objectives: true, teachingMethod: true,
            durationMins: true, outcomes: true, plannedDate: true, status: true,
            subject: { select: { id: true, name: true } },
            chapter: { select: { name: true, chapterNumber: true } },
            topic: { select: { name: true } },
            staff: { select: { user: { select: { name: true } } } },
          },
        }), [] as any[]);

      return reply.send({ success: true, data: { plans } });
    }
  );
}