// apps/api/src/routes/student/academics-exams-offline.ts
//
// Offline Exams — fully ready now (ExamConfig + ExamSubject +
// MarksEntry, all confirmed). List of exams (past/upcoming) for the
// student's class + per-exam subject-wise marks if published.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/exams-offline] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function studentOfflineExamsRoutes(app: FastifyInstance) {

  // ── GET /student/academics/exams/offline ─────────────────────
  app.get("/student/academics/exams/offline",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const student = await safe("student lookup", () =>
        prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true, classId: true } }), null);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const exams = await safe("examConfig.findMany", () =>
        (prisma as any).examConfig.findMany({
          where: { schoolId, classes: { some: { classId: student.classId } } },
          orderBy: { startDate: "desc" }, take: 20,
          select: {
            id: true, name: true, category: true, startDate: true, endDate: true,
            resultPublishDate: true, status: true, parentVisible: true,
          },
        }), [] as any[]);

      const now = new Date();
      return reply.send({
        success: true,
        data: {
          exams: exams.map((e: any) => ({
            id: e.id, name: e.name, category: e.category, startDate: e.startDate, endDate: e.endDate,
            status: e.status, isUpcoming: new Date(e.startDate) > now,
            daysLeft: Math.ceil((new Date(e.startDate).getTime() - now.getTime()) / 86400000),
          })),
        },
      });
    }
  );

  // ── GET /student/academics/exams/offline/:id ─────────────────
  app.get("/student/academics/exams/offline/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { id } = req.params as { id: string };
      const eid = parseInt(id);

      const student = await safe("student lookup", () =>
        prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true } }), null);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const exam = await safe("examConfig detail", () =>
        (prisma as any).examConfig.findFirst({
          where: { id: eid, schoolId },
          select: { id: true, name: true, category: true, startDate: true, endDate: true, status: true },
        }), null);
      if (!exam) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      const marksRaw = await safe("marksEntry for exam", () =>
        prisma.marksEntry.findMany({
          where: { studentId: student.id, examConfigId: eid },
          select: { obtainedMarks: true, maxMarks: true, examSubjectId: true, grade: true },
        }), [] as any[]);

      const examSubjectIds = marksRaw.map((m: any) => m.examSubjectId).filter(Boolean);
      const examSubjects = await safe("examSubject names", () =>
        (prisma as any).examSubject.findMany({
          where: { id: { in: examSubjectIds } },
          select: { id: true, subject: { select: { name: true } } },
        }), [] as any[]);
      const subjectNameMap = new Map(examSubjects.map((es: any) => [es.id, es.subject?.name ?? "—"]));

      const marks = marksRaw.map((m: any) => ({
        subject: subjectNameMap.get(m.examSubjectId) ?? "—",
        obtained: m.obtainedMarks, total: m.maxMarks, grade: m.grade,
        pct: m.maxMarks > 0 ? Math.round((Number(m.obtainedMarks) / Number(m.maxMarks)) * 100) : 0,
      }));

      const totalObtained = marks.reduce((s: number, m: any) => s + Number(m.obtained ?? 0), 0);
      const totalMax = marks.reduce((s: number, m: any) => s + Number(m.total ?? 0), 0);

      return reply.send({
        success: true,
        data: {
          exam, marks,
          summary: { totalObtained, totalMax, pct: totalMax > 0 ? Math.round((totalObtained / totalMax) * 100) : 0 },
        },
      });
    }
  );
}