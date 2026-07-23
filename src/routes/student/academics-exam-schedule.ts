// apps/api/src/routes/student/academics-exam-schedule.ts
//
// Exam Schedule — ExamSchedule + ExamSlot (both confirmed). Filters
// by studentVisible: true (the model's own explicit visibility gate)
// and slots for the student's class.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/exam-schedule] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function studentExamScheduleRoutes(app: FastifyInstance) {

  app.get("/student/academics/exams/schedule",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const student = await safe("student lookup", () =>
        prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true, classId: true } }), null);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const schedules = await safe("examSchedule.findMany", () =>
        prisma.examSchedule.findMany({
          where: {
            schoolId, studentVisible: true,
            slots: { some: { classId: student.classId } },
          },
          orderBy: { startDate: "asc" },
          include: {
            examConfig: { select: { name: true } },
            slots: {
              where: { classId: student.classId },
              orderBy: { examDate: "asc" },
              select: {
                id: true, examDate: true, startTime: true, endTime: true, duration: true,
                slotType: true, roomNumber: true, instructions: true,
                subject: { select: { name: true } },
                invigilator: { select: { user: { select: { name: true } } } },
              },
            },
          },
        }), [] as any[]);

      return reply.send({
        success: true,
        data: {
          schedules: schedules.map((s: any) => ({
            id: s.id, title: s.title, examName: s.examConfig?.name, status: s.status,
            startDate: s.startDate, endDate: s.endDate,
            slots: s.slots.map((sl: any) => ({
              id: sl.id, date: sl.examDate, startTime: sl.startTime, endTime: sl.endTime, duration: sl.duration,
              slotType: sl.slotType, subjectName: sl.subject?.name, roomNumber: sl.roomNumber,
              instructions: sl.instructions, invigilatorName: sl.invigilator?.user?.name,
            })),
          })),
        },
      });
    }
  );
}