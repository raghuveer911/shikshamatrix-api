// apps/api/src/routes/student/academics-summary.ts
//
// NEW — lightweight summary endpoint for the Academics Hub's top
// quick-stats strip. Only uses already-confirmed models (StudyAssignment,
// ExamConfig, LibIssue, CertIssued) — no new schema.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/academics-summary] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function studentAcademicsSummaryRoutes(app: FastifyInstance) {

  app.get("/student/academics/summary",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const student = await safe("student lookup", () =>
        prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true, classId: true } }), null);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const today = new Date(); today.setHours(0, 0, 0, 0);

      const [pendingHomework, activeExams, issuedBooks, certificatesCount] = await Promise.all([
        safe("pending homework count", () =>
          prisma.studyAssignment.count({
            where: { schoolId, classId: student.classId, isActive: true, dueDate: { gte: today } },
          }), 0),

        safe("active exams count", () =>
          (prisma as any).examConfig.count({
            where: { schoolId, status: "ACTIVE", classes: { some: { classId: student.classId } } },
          }), 0),

        safe("issued books count", () =>
          prisma.libIssue.count({ where: { studentId: student.id, status: "ACTIVE" } }), 0),

        safe("certificates count", () =>
          prisma.certIssued.count({ where: { studentId: student.id } }), 0),
      ]);

      return reply.send({
        success: true,
        data: { pendingHomework, activeExams, issuedBooks, certificatesCount },
      });
    }
  );
}