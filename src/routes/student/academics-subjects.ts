// apps/api/src/routes/student/academics-subjects.ts
//
// Subjects list + Study Center (subject detail hub with
// chapters/topics/syllabus-progress).
//
// Subject is grade-level (classNumber+name), not tied to one
// section — the student's teacher for a subject comes from
// SubjectAssignment (subject+class+teacher), looked up for their
// specific section. Study Center content (StudyChapter/StudyMaterial/
// StudyLessonPlan) is keyed by classNumber+subjectName, matching the
// Study Center migration.
//
// Note: syllabus progress shown here is CLASS-LEVEL coverage
// (aggregated across StudySyllabusTracker rows for that class+topic,
// regardless of which teacher marked it) — there's no per-student
// syllabus tracking model, only per-teacher/class.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/academics-subjects] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function getStudentContext(userId: number, schoolId: number) {
  return safe("student lookup", () =>
    prisma.student.findFirst({
      where: { userId, schoolId, isActive: true },
      select: { id: true, classId: true, class: { select: { classNumber: true, academicYear: true } } },
    }), null);
}

export async function studentAcademicsSubjectsRoutes(app: FastifyInstance) {

  // ── GET /student/academics/subjects — list with teacher + coverage ──
  app.get("/student/academics/subjects",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const student = await getStudentContext(userId, schoolId);
      if (!student || !student.class) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });
      const classNumber = student.class.classNumber;

      const [subjects, assignments] = await Promise.all([
        safe("subject.findMany", () =>
          prisma.subject.findMany({
            where: { schoolId, classNumber, isActive: true },
            orderBy: { name: "asc" },
            select: { id: true, name: true, code: true },
          }), [] as any[]),
        safe("assignments for teacher lookup", () =>
          prisma.subjectAssignment.findMany({
            where: { schoolId, classId: student.classId, isActive: true },
            select: { subjectId: true, teacher: { select: { user: { select: { name: true } } } } },
          }), [] as any[]),
      ]);
      const teacherBySubjectId = new Map(assignments.map((a: any) => [a.subjectId, a.teacher?.user?.name]));

      // Curriculum + chapter coverage per subject (class-level, not per-student)
      const curriculum = await safe("curriculum lookup", () =>
        prisma.studyCurriculum.findFirst({
          where: { schoolId, academicYear: student.class?.academicYear, isActive: true },
          orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
        }), null);

      const enriched = await Promise.all(subjects.map(async (s: any) => {
        if (!curriculum) return { ...s, chaptersCovered: 0, totalChapters: 0, coveragePct: 0 };

        const chapters = await safe("chapters for subject", () =>
          prisma.studyChapter.findMany({
            where: { schoolId, curriculumId: curriculum.id, classNumber, subjectName: s.name, isActive: true },
            select: { id: true, topics: { where: { isActive: true }, select: { id: true } } },
          }), [] as any[]);

        const topicIds = chapters.flatMap((c: any) => c.topics.map((t: any) => t.id));
        if (topicIds.length === 0) return { ...s, chaptersCovered: 0, totalChapters: chapters.length, coveragePct: 0 };

        const trackers = await safe("trackers for coverage", () =>
          prisma.studySyllabusTracker.findMany({
            where: { topicId: { in: topicIds }, classId: student.classId },
            select: { topicId: true, status: true },
          }), [] as any[]);

        const completedTopics = trackers.filter((t: any) => t.status === "COMPLETED").length;
        const coveragePct = topicIds.length > 0 ? Math.round((completedTopics / topicIds.length) * 100) : 0;

        return { ...s, chaptersCovered: chapters.length, totalChapters: chapters.length, coveragePct };
      }));

      return reply.send({
        success: true,
        data: {
          subjects: enriched.map((s: any) => ({
            id: s.id, name: s.name, code: s.code,
            teacherName: teacherBySubjectId.get(s.id) ?? "Not assigned",
            coveragePct: s.coveragePct,
          })),
        },
      });
    }
  );

  // ── GET /student/academics/subjects/:subjectId — Study Center detail ──
  app.get("/student/academics/subjects/:subjectId",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { subjectId } = req.params as { subjectId: string };
      const sid = parseInt(subjectId);

      const student = await getStudentContext(userId, schoolId);
      if (!student || !student.class) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });
      const classNumber = student.class.classNumber;

      const subject = await safe("subject detail", () =>
        prisma.subject.findFirst({
          where: { id: sid, schoolId, classNumber },
          select: { id: true, name: true, code: true },
        }), null);
      if (!subject) return reply.status(404).send({ success: false, error: "SUBJECT_NOT_FOUND" });

      const assignment = await safe("teacher lookup", () =>
        prisma.subjectAssignment.findFirst({
          where: { schoolId, subjectId: sid, classId: student.classId, isActive: true },
          select: { teacher: { select: { user: { select: { name: true, phone: true } } } } },
        }), null);

      const curriculum = await safe("curriculum lookup", () =>
        prisma.studyCurriculum.findFirst({
          where: { schoolId, academicYear: student.class?.academicYear, isActive: true },
          orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
        }), null);

      let chapters: any[] = [];
      if (curriculum) {
        const rawChapters = await safe("chapters", () =>
          prisma.studyChapter.findMany({
            where: { schoolId, curriculumId: curriculum.id, classNumber, subjectName: subject.name, isActive: true },
            orderBy: [{ sortOrder: "asc" }, { chapterNumber: "asc" }],
            include: { topics: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { topicNumber: "asc" }] } },
          }), [] as any[]);

        const allTopicIds = rawChapters.flatMap((c: any) => c.topics.map((t: any) => t.id));
        const trackers = await safe("trackers", () =>
          prisma.studySyllabusTracker.findMany({
            where: { topicId: { in: allTopicIds }, classId: student.classId },
            select: { topicId: true, status: true },
          }), [] as any[]);
        const statusMap = new Map(trackers.map((t: any) => [t.topicId, t.status]));

        chapters = rawChapters.map((c: any) => {
          const topics = c.topics.map((t: any) => ({ id: t.id, name: t.name, status: statusMap.get(t.id) ?? "NOT_STARTED" }));
          const completed = topics.filter((t: any) => t.status === "COMPLETED").length;
          return {
            id: c.id, name: c.name, chapterNumber: c.chapterNumber,
            topics, completedTopics: completed, totalTopics: topics.length,
            coveragePct: topics.length > 0 ? Math.round((completed / topics.length) * 100) : 0,
          };
        });
      }

      const [materialsCount, notesCount, lessonPlansCount] = await Promise.all([
        safe("materials count", () => prisma.studyMaterial.count({ where: { schoolId, classId: student.classId, classNumber, subjectName: subject.name, isArchived: false } }), 0),
        safe("notes count", () => prisma.studyMaterial.count({ where: { schoolId, classId: student.classId, classNumber, subjectName: subject.name, isArchived: false, type: "NOTES" } }), 0),
        safe("lesson plans count", () => prisma.studyLessonPlan.count({ where: { schoolId, classId: student.classId, classNumber, subjectName: subject.name, approvalStatus: "APPROVED" } }), 0),
      ]);

      return reply.send({
        success: true,
        data: {
          subject: { id: subject.id, name: subject.name, code: subject.code, teacherName: assignment?.teacher?.user?.name ?? "Not assigned" },
          chapters,
          quickLinks: { materialsCount, notesCount, lessonPlansCount },
        },
      });
    }
  );
}
