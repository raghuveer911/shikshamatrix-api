// apps/api/src/routes/student/academics-syllabus.ts
//
// Consolidated Syllabus — ALL subjects' chapter/topic completion in
// one view (Study Center shows this per-subject; this is the
// all-subjects rollup). Confirmed models only: Subject,
// StudyCurriculum, StudyChapter, StudyTopic, StudySyllabusTracker.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/syllabus] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function studentSyllabusRoutes(app: FastifyInstance) {

  app.get("/student/academics/syllabus",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const student = await safe("student lookup", () =>
        prisma.student.findFirst({
          where: { userId, schoolId, isActive: true },
          select: { classId: true, class: { select: { academicYear: true } } },
        }), null);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const subjects = await safe("subjects", () =>
        prisma.subject.findMany({
          where: { classId: student.classId, isActive: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        }), [] as any[]);

      const curriculum = await safe("curriculum", () =>
        prisma.studyCurriculum.findFirst({
          where: { schoolId, academicYear: student.class?.academicYear, isActive: true },
          orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
        }), null);

      if (!curriculum) {
        return reply.send({ success: true, data: { subjects: subjects.map((s: any) => ({ ...s, chapters: [], coveragePct: 0 })), overallPct: 0 } });
      }

      const subjectsWithChapters = await Promise.all(subjects.map(async (s: any) => {
        const chapters = await safe(`chapters for ${s.id}`, () =>
          prisma.studyChapter.findMany({
            where: { schoolId, curriculumId: curriculum.id, subjectId: s.id, isActive: true },
            orderBy: [{ sortOrder: "asc" }, { chapterNumber: "asc" }],
            include: { topics: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { topicNumber: "asc" }] } },
          }), [] as any[]);

        const allTopicIds = chapters.flatMap((c: any) => c.topics.map((t: any) => t.id));
        const trackers = allTopicIds.length > 0 ? await safe(`trackers for ${s.id}`, () =>
          prisma.studySyllabusTracker.findMany({
            where: { topicId: { in: allTopicIds }, classId: student.classId },
            select: { topicId: true, status: true },
          }), [] as any[]) : [];
        const statusMap = new Map(trackers.map((t: any) => [t.topicId, t.status]));

        const chaptersOut = chapters.map((c: any) => {
          const topics = c.topics.map((t: any) => ({ id: t.id, name: t.name, status: statusMap.get(t.id) ?? "NOT_STARTED" }));
          const completed = topics.filter((t: any) => t.status === "COMPLETED").length;
          return {
            id: c.id, name: c.name, chapterNumber: c.chapterNumber, topics,
            completedTopics: completed, totalTopics: topics.length,
            coveragePct: topics.length > 0 ? Math.round((completed / topics.length) * 100) : 0,
          };
        });

        const subjTotalTopics = chaptersOut.reduce((s2: number, c: any) => s2 + c.totalTopics, 0);
        const subjCompleted = chaptersOut.reduce((s2: number, c: any) => s2 + c.completedTopics, 0);

        return {
          id: s.id, name: s.name, chapters: chaptersOut,
          coveragePct: subjTotalTopics > 0 ? Math.round((subjCompleted / subjTotalTopics) * 100) : 0,
        };
      }));

      const totalPct = subjectsWithChapters.reduce((s: number, sub: any) => s + sub.coveragePct, 0);
      const overallPct = subjectsWithChapters.length > 0 ? Math.round(totalPct / subjectsWithChapters.length) : 0;

      return reply.send({ success: true, data: { subjects: subjectsWithChapters, overallPct } });
    }
  );
}