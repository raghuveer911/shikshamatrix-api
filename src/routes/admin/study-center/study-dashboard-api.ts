// apps/api/src/routes/admin/study-center/study-dashboard-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminStudyDashboardRoutes(app: FastifyInstance) {
  const P = "/admin/study";

  // ─── MAIN DASHBOARD ───────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const academicYear = q.academicYear as string | undefined;

      const [
        totalSubjects, totalChapters, totalTopics,
        curriculums,
      ] = await Promise.all([
        prisma.subject.count({ where: { schoolId, isActive: true } }),
        prisma.studyChapter.count({ where: { schoolId, isActive: true } }),
        prisma.studyTopic.count({ where: { schoolId, isActive: true } }),
        prisma.studyCurriculum.count({ where: { schoolId, isActive: true } }),
      ]);

      // Syllabus completion across all trackers
      const allTrackers = await prisma.studySyllabusTracker.findMany({
        where: {
          schoolId,
          ...(academicYear ? { academicYear } : {}),
        },
        select: { status: true },
      });
      const totalTracked = allTrackers.length;
      const completed = allTrackers.filter(t => t.status === "COMPLETED" || t.status === "REVISION").length;
      const syllabusCompletionPct = totalTracked > 0 ? Math.round((completed / totalTracked) * 100) : 0;
      const pendingTopics = totalTracked - completed;

      // Per-class syllabus progress
      const classes = await prisma.class.findMany({
        where: { schoolId, isActive: true },
        select: { id: true, name: true, classNumber: true },
        orderBy: { classNumber: "asc" },
      });
      const classSyllabusProgress = await Promise.all(
        classes.slice(0, 10).map(async (cls) => {
          const trackers = await prisma.studySyllabusTracker.findMany({
            where: { schoolId, classId: cls.id, ...(academicYear ? { academicYear } : {}) },
            select: { status: true },
          });
          const total = trackers.length;
          const done  = trackers.filter(t => t.status === "COMPLETED" || t.status === "REVISION").length;
          return { classId: cls.id, className: cls.name, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
        })
      );

      // Per-subject progress (top 8 grade+subject combos with curriculum defined)
      const chapterCombos = await prisma.studyChapter.findMany({
        where: { schoolId, isActive: true },
        distinct: ["classNumber", "subjectName"],
        select: { classNumber: true, subjectName: true },
        take: 8,
      });
      const subjectProgress = await Promise.all(
        chapterCombos.map(async (combo) => {
          const trackers = await prisma.studySyllabusTracker.findMany({
            where: {
              schoolId,
              ...(academicYear ? { academicYear } : {}),
              topic: { chapter: { classNumber: combo.classNumber, subjectName: combo.subjectName } },
            },
            select: { status: true },
          });
          const total = trackers.length;
          const done  = trackers.filter(t => t.status === "COMPLETED" || t.status === "REVISION").length;
          const chapters = await prisma.studyChapter.count({ where: { schoolId, classNumber: combo.classNumber, subjectName: combo.subjectName, isActive: true } });
          return { classNumber: combo.classNumber, name: combo.subjectName, pct: total > 0 ? Math.round((done / total) * 100) : 0, chapters };
        })
      );

      // Status breakdown
      const statusBreakdown = await prisma.studySyllabusTracker.groupBy({
        by: ["status"],
        where: { schoolId, ...(academicYear ? { academicYear } : {}) },
        _count: { id: true },
      });

      // Recent tracker updates
      const recentUpdates = await prisma.studySyllabusTracker.findMany({
        where: { schoolId, status: { not: "NOT_STARTED" } },
        orderBy: { updatedAt: "desc" },
        take: 8,
        include: {
          topic: { select: { name: true, chapter: { select: { name: true, subjectName: true } } } },
          staff: { include: { user: { select: { name: true } } } },
        },
      });

      return rep.send({
        kpis: { totalSubjects, totalChapters, totalTopics, curriculums, syllabusCompletionPct, pendingTopics },
        classSyllabusProgress, subjectProgress, statusBreakdown, recentUpdates,
      });
    }
  );

  // ─── QUICK STATS (lightweight) ────────────────────────────
  app.get(`${P}/quick-stats`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [subjects, chapters, topics, pending] = await Promise.all([
        prisma.subject.count({ where: { schoolId, isActive: true } }),
        prisma.studyChapter.count({ where: { schoolId, isActive: true } }),
        prisma.studyTopic.count({ where: { schoolId, isActive: true } }),
        prisma.studySyllabusTracker.count({ where: { schoolId, status: "NOT_STARTED" } }),
      ]);
      return rep.send({ subjects, chapters, topics, pending });
    }
  );
}
