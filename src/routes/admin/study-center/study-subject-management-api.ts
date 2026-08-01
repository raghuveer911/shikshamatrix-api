// apps/api/src/routes/admin/study-center/study-subject-management-api.ts
// Pure TypeScript — NO JSX, NO className
//
// IMPORTANT: Subject master (per class-SECTION) is owned by Academics —
// e.g. "Class 5-A Mathematics" and "Class 5-B Mathematics" are two
// separate Subject rows there (each section can have its own teacher).
// Study Center curriculum, however, is defined at the GRADE level
// (classNumber + subjectName) so it's shared across every section of
// that grade instead of needing to be duplicated per section. This
// module bridges the two: it reads the per-section Subject rows only
// to show "which sections/teachers teach this", while all curriculum
// data (chapters, materials, trackers) is queried by classNumber+name.

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminStudySubjectMgmtRoutes(app: FastifyInstance) {
  const P = "/admin/study/subjects";

  // ─── GRADE-LEVEL SUBJECT LIST (for dropdowns/filters) ─────
  // Returns one row per DISTINCT (classNumber, subjectName) combo,
  // not one row per class-section — this is the list curriculum,
  // materials, assignments and lesson-plans should all pick from.
  app.get(`${P}/summary/all`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const sectionSubjects = await prisma.subject.findMany({
        where: { schoolId, isActive: true },
        select: { name: true, class: { select: { classNumber: true, name: true } } },
      });
      const seen = new Map<string, { classNumber: string; subjectName: string; classNames: Set<string> }>();
      for (const s of sectionSubjects) {
        const key = `${s.class.classNumber}::${s.name}`;
        if (!seen.has(key)) seen.set(key, { classNumber: s.class.classNumber, subjectName: s.name, classNames: new Set() });
        seen.get(key)!.classNames.add(s.class.name);
      }
      const combos = [...seen.values()];

      const enriched = await Promise.all(combos.map(async c => {
        const chapterCount = await prisma.studyChapter.count({
          where: { schoolId, classNumber: c.classNumber, subjectName: c.subjectName, isActive: true },
        });
        const trackers = await prisma.studySyllabusTracker.findMany({
          where: {
            schoolId,
            ...(q.academicYear ? { academicYear: q.academicYear } : {}),
            topic: { chapter: { classNumber: c.classNumber, subjectName: c.subjectName } },
          },
          select: { status: true },
        });
        const total = trackers.length;
        const done  = trackers.filter(t => t.status === "COMPLETED" || t.status === "REVISION").length;
        const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
        const chapterScore = Math.min(chapterCount * 10, 30);
        const healthScore  = Math.min(Math.round(pct * 0.4 + chapterScore), 100);
        return {
          classNumber: c.classNumber,
          subjectName: c.subjectName,
          sections: [...c.classNames].sort(),
          chapterCount,
          completionPct: pct,
          healthScore,
          totalTracked: total,
        };
      }));

      enriched.sort((a, b) => Number(a.classNumber) - Number(b.classNumber) || a.subjectName.localeCompare(b.subjectName));
      return rep.send({ subjects: enriched });
    }
  );

  // ─── GRADE-LEVEL SUBJECT DETAIL ────────────────────────────
  app.get(`${P}/detail`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const classNumber = String(q.classNumber ?? "");
      const subjectName = String(q.subjectName ?? "");
      if (!classNumber || !subjectName) return rep.code(400).send({ error: "classNumber and subjectName are required" });

      const sections = await prisma.subject.findMany({
        where: { schoolId, name: subjectName, class: { classNumber }, isActive: true },
        include: {
          class: { select: { id: true, name: true, section: true } },
          teacher: { include: { user: { select: { name: true, avatarUrl: true, email: true } } } },
        },
      });

      const chapters = await prisma.studyChapter.findMany({
        where: { schoolId, classNumber, subjectName, isActive: true },
        include: { _count: { select: { topics: true } } },
        orderBy: { chapterNumber: "asc" },
      });

      const trackers = await prisma.studySyllabusTracker.findMany({
        where: {
          schoolId,
          ...(q.academicYear ? { academicYear: q.academicYear } : {}),
          topic: { chapter: { classNumber, subjectName } },
        },
        select: { status: true },
      });
      const totalTopics = trackers.length;
      const completedTopics = trackers.filter(t => t.status === "COMPLETED" || t.status === "REVISION").length;
      const completionPct = totalTopics > 0 ? Math.round((completedTopics / totalTopics) * 100) : 0;

      const chapterScore = Math.min(chapters.length * 10, 30);
      const topicScore   = chapters.reduce((s, c) => s + Math.min(c._count.topics * 2, 10), 0);
      const healthScore  = Math.min(Math.round(completionPct * 0.4 + chapterScore + topicScore), 100);

      return rep.send({ classNumber, subjectName, sections, chapters, totalTopics, completedTopics, completionPct, healthScore });
    }
  );

  // ─── GRADE-LEVEL SUBJECT ANALYTICS ────────────────────────
  app.get(`${P}/analytics`, { preHandler: [authenticate, requireCapability('studyCenter.advanced')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const classNumber = String(q.classNumber ?? "");
      const subjectName = String(q.subjectName ?? "");
      if (!classNumber || !subjectName) return rep.code(400).send({ error: "classNumber and subjectName are required" });

      const chapters = await prisma.studyChapter.findMany({
        where: { schoolId, classNumber, subjectName, isActive: true },
        include: {
          topics: {
            include: {
              trackers: {
                where: { schoolId, ...(q.academicYear ? { academicYear: q.academicYear } : {}) },
                select: { status: true },
              },
            },
          },
        },
        orderBy: { chapterNumber: "asc" },
      });

      const chapterAnalytics = chapters.map(ch => {
        const allTrackers = ch.topics.flatMap(t => t.trackers);
        const total = allTrackers.length;
        const done  = allTrackers.filter(t => t.status === "COMPLETED" || t.status === "REVISION").length;
        return {
          chapterId: ch.id, chapterName: ch.name, chapterNumber: ch.chapterNumber,
          totalTopics: ch.topics.length, completedTopics: done,
          pct: total > 0 ? Math.round((done / total) * 100) : 0,
          importance: ch.importance, estimatedHours: ch.estimatedHours,
        };
      });

      const teacherTrackers = await prisma.studySyllabusTracker.groupBy({
        by: ["staffId", "status"],
        where: {
          schoolId,
          ...(q.academicYear ? { academicYear: q.academicYear } : {}),
          topic: { chapter: { classNumber, subjectName } },
        },
        _count: { id: true },
      });

      const staffIds = [...new Set(teacherTrackers.map(t => t.staffId))];
      const staffDetails = await prisma.staff.findMany({
        where: { id: { in: staffIds } },
        include: { user: { select: { name: true, avatarUrl: true } } },
      });

      const teacherProgress = staffIds.map(sid => {
        const rows = teacherTrackers.filter(t => t.staffId === sid);
        const total = rows.reduce((s, r) => s + r._count.id, 0);
        const done  = rows.filter(r => r.status === "COMPLETED" || r.status === "REVISION").reduce((s, r) => s + r._count.id, 0);
        const staff = staffDetails.find(s => s.id === sid);
        return { staffId: sid, name: staff?.user?.name ?? "—", total, done, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
      });

      return rep.send({ chapterAnalytics, teacherProgress });
    }
  );
}
