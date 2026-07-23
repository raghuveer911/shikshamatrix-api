// apps/api/src/routes/admin/study-center/study-subject-management-api.ts
// Pure TypeScript — NO JSX, NO className
// Note: Subject master is OWNED by Academics. This module READS and ENRICHES it.

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminStudySubjectMgmtRoutes(app: FastifyInstance) {
  const P = "/admin/study/subjects";

  // ─── SUBJECT LIBRARY (read from Academics, enriched) ─────
  app.get(P, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const subjects = await prisma.subject.findMany({
        where: {
          schoolId,
          isActive: true,
          ...(q.classId ? { classId: Number(q.classId) } : {}),
          ...(q.teacherId ? { teacherId: Number(q.teacherId) } : {}),
          ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}),
        },
        include: {
          class: { select: { id: true, name: true, classNumber: true, section: true } },
          teacher: { include: { user: { select: { name: true, avatarUrl: true } } } },
          _count: { select: { studyChapters: true } },
        },
        orderBy: [{ class: { classNumber: "asc" } }, { name: "asc" }],
      });

      return rep.send({ subjects });
    }
  );

  // ─── SUBJECT DETAIL — full enriched view ─────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const q = req.query as any;

      const subject = await prisma.subject.findFirst({
        where: { id, schoolId },
        include: {
          class: { select: { name: true, classNumber: true, section: true } },
          teacher: { include: { user: { select: { name: true, avatarUrl: true, email: true } } } },
        },
      });
      if (!subject) return rep.code(404).send({ error: "Subject not found" });

      // Chapters for this subject
      const chapters = await prisma.studyChapter.findMany({
        where: { schoolId, subjectId: id, isActive: true },
        include: {
          _count: { select: { topics: true } },
        },
        orderBy: { chapterNumber: "asc" },
      });

      // Syllabus completion
      const trackers = await prisma.studySyllabusTracker.findMany({
        where: {
          schoolId, subjectId: id,
          ...(q.academicYear ? { academicYear: q.academicYear } : {}),
        },
        select: { status: true },
      });
      const totalTopics = trackers.length;
      const completedTopics = trackers.filter(t => t.status === "COMPLETED" || t.status === "REVISION").length;
      const completionPct = totalTopics > 0 ? Math.round((completedTopics / totalTopics) * 100) : 0;

      // Subject health score: completion (40%) + chapters exist (30%) + topics exist (30%)
      const chapterScore  = Math.min(chapters.length * 10, 30);
      const topicScore    = chapters.reduce((s, c) => s + Math.min(c._count.topics * 2, 10), 0);
      const healthScore   = Math.min(Math.round(completionPct * 0.4 + chapterScore + topicScore), 100);

      return rep.send({ subject, chapters, totalTopics, completedTopics, completionPct, healthScore });
    }
  );

  // ─── SUBJECT ANALYTICS ────────────────────────────────────
  app.get(`${P}/:id/analytics`, { preHandler: [authenticate, requireCapability('studyCenter.advanced')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const q = req.query as any;

      // Chapter-wise completion
      const chapters = await prisma.studyChapter.findMany({
        where: { schoolId, subjectId: id, isActive: true },
        include: {
          topics: {
            include: {
              trackers: {
                where: {
                  schoolId,
                  ...(q.academicYear ? { academicYear: q.academicYear } : {}),
                },
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
          chapterId:     ch.id,
          chapterName:   ch.name,
          chapterNumber: ch.chapterNumber,
          totalTopics:   ch.topics.length,
          completedTopics: done,
          pct: total > 0 ? Math.round((done / total) * 100) : 0,
          importance: ch.importance,
          estimatedHours: ch.estimatedHours,
        };
      });

      // Teacher-wise progress
      const teacherTrackers = await prisma.studySyllabusTracker.groupBy({
        by: ["staffId", "status"],
        where: { schoolId, subjectId: id, ...(q.academicYear ? { academicYear: q.academicYear } : {}) },
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

  // ─── ALL SUBJECTS SUMMARY (for overview grid) ─────────────
  app.get(`${P}/summary/all`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const subjects = await prisma.subject.findMany({
        where: { schoolId, isActive: true },
        include: {
          class: { select: { name: true, classNumber: true } },
          teacher: { include: { user: { select: { name: true } } } },
          _count: { select: { studyChapters: true } },
        },
        orderBy: [{ class: { classNumber: "asc" } }, { name: "asc" }],
      });

      const enriched = await Promise.all(subjects.map(async sub => {
        const trackers = await prisma.studySyllabusTracker.findMany({
          where: { schoolId, subjectId: sub.id, ...(q.academicYear ? { academicYear: q.academicYear } : {}) },
          select: { status: true },
        });
        const total = trackers.length;
        const done  = trackers.filter(t => t.status === "COMPLETED" || t.status === "REVISION").length;
        const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
        const chapterScore = Math.min(sub._count.studyChapters * 10, 30);
        const healthScore  = Math.min(Math.round(pct * 0.4 + chapterScore), 100);
        return { ...sub, completionPct: pct, healthScore, totalTracked: total };
      }));

      return rep.send({ subjects: enriched });
    }
  );
}
