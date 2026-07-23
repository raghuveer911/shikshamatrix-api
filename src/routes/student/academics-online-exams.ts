// apps/api/src/routes/student/academics-online-exams.ts
//
// Online Exams + Practice Tests — SAME OnlineExam/TestSchedule
// models, partitioned by OnlineExamCategory:
//   Online Exams   -> category != PRACTICE_TEST
//   Practice Tests -> category = PRACTICE_TEST
//
// ⚠️ SCOPE NOTE: this only builds the LIST + past-result view. The
// actual exam-TAKING interface (question rendering, timer, security
// enforcement) is a separate, dedicated future build — tapping an
// unattempted exam here shows "Coming Soon" for the attempt flow.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/online-exams] "${label}" failed:`, err?.message ?? err); return fallback; }
}

const VISIBLE_STATUSES = ["PUBLISHED", "LIVE", "PAUSED", "COMPLETED"];

export async function studentOnlineExamsRoutes(app: FastifyInstance) {

  // ── GET /student/academics/exams/online?category=exams|practice ──
  app.get("/student/academics/exams/online",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { category = "exams" } = req.query as { category?: string };

      const student = await safe("student lookup", () =>
        prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true, classId: true } }), null);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const schedules = await safe("testSchedule.findMany", () =>
        prisma.testSchedule.findMany({
          where: {
            schoolId, status: { in: VISIBLE_STATUSES as any },
            applicableClasses: { has: student.classId },
            exam: category === "practice" ? { category: "PRACTICE_TEST" } : { category: { not: "PRACTICE_TEST" } },
          },
          orderBy: { startTime: "asc" },
          include: {
            exam: { select: { id: true, name: true, examType: true, totalMarks: true, totalQuestions: true, duration: true, category: true } },
          },
        }), [] as any[]);

      const scheduleIds = schedules.map((s: any) => s.id);
      const attempts = await safe("attempt records", () =>
        prisma.testAttemptRecord.findMany({
          where: { scheduleId: { in: scheduleIds }, studentId: student.id },
          select: { scheduleId: true, status: true, obtainedMarks: true, totalMarks: true, percentage: true, resultVisible: true },
        }), [] as any[]);
      const attemptMap = new Map(attempts.map((a: any) => [a.scheduleId, a]));

      const now = new Date();
      const mapped = schedules.map((s: any) => {
        const attempt = attemptMap.get(s.id);
        return {
          scheduleId: s.id, examId: s.exam.id, name: s.exam.name, category: s.exam.category,
          totalMarks: s.exam.totalMarks, totalQuestions: s.exam.totalQuestions, duration: s.durationMins,
          startTime: s.startTime, endTime: s.endTime, status: s.status,
          isLive: now >= new Date(s.startTime) && now <= new Date(s.endTime),
          isUpcoming: now < new Date(s.startTime),
          isOver: now > new Date(s.endTime),
          attempt: attempt ? {
            status: attempt.status, obtainedMarks: attempt.obtainedMarks, totalMarks: attempt.totalMarks,
            percentage: attempt.percentage, resultVisible: attempt.resultVisible,
          } : null,
        };
      });

      return reply.send({ success: true, data: { items: mapped } });
    }
  );

  // ── GET /student/academics/exams/online/:scheduleId ──────────
  app.get("/student/academics/exams/online/:scheduleId",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { scheduleId } = req.params as { scheduleId: string };
      const sid = parseInt(scheduleId);

      const student = await safe("student lookup", () =>
        prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true } }), null);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const schedule = await safe("testSchedule detail", () =>
        prisma.testSchedule.findFirst({
          where: { id: sid, schoolId },
          include: {
            exam: { select: { name: true, description: true, instructions: true, examType: true, totalMarks: true, totalQuestions: true, hasNegMarking: true, category: true } },
          },
        }), null);
      if (!schedule) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      const attempt = await safe("own attempt", () =>
        prisma.testAttemptRecord.findFirst({
          where: { scheduleId: sid, studentId: student.id },
          select: {
            status: true, obtainedMarks: true, totalMarks: true, percentage: true, rank: true,
            isPassed: true, resultVisible: true, timeTakenSecs: true, submittedAt: true,
          },
        }), null);

      const now = new Date();
      return reply.send({
        success: true,
        data: {
          exam: {
            name: schedule.exam.name, description: schedule.exam.description, instructions: schedule.exam.instructions,
            examType: schedule.exam.examType, totalMarks: schedule.exam.totalMarks, totalQuestions: schedule.exam.totalQuestions,
            hasNegMarking: schedule.exam.hasNegMarking, category: schedule.exam.category,
          },
          schedule: {
            startTime: schedule.startTime, endTime: schedule.endTime, durationMins: schedule.durationMins,
            maxAttempts: schedule.maxAttempts, showRank: schedule.showRank,
            isLive: now >= new Date(schedule.startTime) && now <= new Date(schedule.endTime),
            isUpcoming: now < new Date(schedule.startTime), isOver: now > new Date(schedule.endTime),
          },
          attempt,
        },
      });
    }
  );
}