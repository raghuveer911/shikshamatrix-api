// apps/api/src/routes/student/academics-curriculum.ts
//
// Curriculum — structural overview (board, academic year, name) +
// per-subject chapter COUNTS (not completion-tracking, that's
// Syllabus's job). Confirmed StudyCurriculum + StudyChapter models.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/curriculum] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function studentCurriculumRoutes(app: FastifyInstance) {

  app.get("/student/academics/curriculum",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const student = await safe("student lookup", () =>
        prisma.student.findFirst({
          where: { userId, schoolId, isActive: true },
          select: { classId: true, class: { select: { classNumber: true, academicYear: true } } },
        }), null);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const curriculum = await safe("curriculum", () =>
        prisma.studyCurriculum.findFirst({
          where: { schoolId, academicYear: student.class?.academicYear, isActive: true },
          orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
        }), null);

      if (!curriculum) {
        return reply.send({ success: true, data: { curriculum: null, subjects: [] } });
      }

      const subjects = await safe("subjects", () =>
        prisma.subject.findMany({
          where: { classNumber: student.class?.classNumber, isActive: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        }), [] as any[]);

      const subjectsWithCounts = await Promise.all(subjects.map(async (s: any) => {
        const chapterCount = await safe(`chapter count ${s.id}`, () =>
          prisma.studyChapter.count({ where: { schoolId, curriculumId: curriculum.id, subjectId: s.id, isActive: true } }), 0);
        const topicCount = await safe(`topic count ${s.id}`, () =>
          prisma.studyTopic.count({
            where: { isActive: true, chapter: { schoolId, curriculumId: curriculum.id, subjectId: s.id, isActive: true } },
          }), 0);
        return { id: s.id, name: s.name, chapterCount, topicCount };
      }));

      return reply.send({
        success: true,
        data: {
          curriculum: {
            id: curriculum.id, name: curriculum.name, board: curriculum.board,
            academicYear: curriculum.academicYear, description: curriculum.description,
          },
          subjects: subjectsWithCounts,
        },
      });
    }
  );
}