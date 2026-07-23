// apps/api/src/routes/admin/study-center/study-curriculum-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminStudyCurriculumRoutes(app: FastifyInstance) {
  const P = "/admin/study/curriculum";

  // ─────────────────────────────────────────────────────────
  // CURRICULUM LIBRARY
  // ─────────────────────────────────────────────────────────

  app.get(`${P}/list`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const curriculums = await prisma.studyCurriculum.findMany({
        where: {
          schoolId,
          ...(q.board ? { board: q.board as any } : {}),
          ...(q.academicYear ? { academicYear: q.academicYear } : {}),
          ...(q.active !== "false" ? { isActive: true } : {}),
        },
        include: { _count: { select: { chapters: true } } },
        orderBy: [{ isDefault: "desc" }, { academicYear: "desc" }, { name: "asc" }],
      });
      return rep.send({ curriculums });
    }
  );

  app.post(`${P}/create`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      if (b.isDefault) {
        await prisma.studyCurriculum.updateMany({
          where: { schoolId, academicYear: b.academicYear },
          data: { isDefault: false },
        });
      }

      const curriculum = await prisma.studyCurriculum.create({
        data: {
          schoolId,
          name: b.name,
          board: b.board as any ?? "CBSE",
          academicYear: b.academicYear,
          description: b.description ?? null,
          isDefault: b.isDefault ?? false,
          createdById: Number(userId),
        },
      });
      return rep.code(201).send({ curriculum });
    }
  );

  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      if (b.isDefault) {
        const cur = await prisma.studyCurriculum.findFirst({ where: { id, schoolId } });
        if (cur) {
          await prisma.studyCurriculum.updateMany({
            where: { schoolId, academicYear: cur.academicYear },
            data: { isDefault: false },
          });
        }
      }

      const curriculum = await prisma.studyCurriculum.update({
        where: { id, schoolId },
        data: { name: b.name, description: b.description, isDefault: b.isDefault, isActive: b.isActive },
      });
      return rep.send({ curriculum });
    }
  );

  // Clone curriculum to next year
  app.post(`${P}/:id/clone`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const source = await prisma.studyCurriculum.findFirst({
        where: { id, schoolId },
        include: {
          chapters: {
            include: {
              topics: { include: { subTopics: true } },
            },
          },
        },
      });
      if (!source) return rep.code(404).send({ error: "Curriculum not found" });

      const newCurriculum = await prisma.studyCurriculum.create({
        data: {
          schoolId,
          name: b.name ?? `${source.name} (Clone)`,
          board: source.board,
          academicYear: b.academicYear ?? source.academicYear,
          description: source.description,
          clonedFromId: source.id,
          isDefault: false,
          createdById: Number(userId),
        },
      });

      // Clone chapters + topics + sub-topics
      for (const chapter of source.chapters) {
        const newChapter = await prisma.studyChapter.create({
          data: {
            schoolId,
            curriculumId: newCurriculum.id,
            subjectId: chapter.subjectId,
            name: chapter.name,
            chapterNumber: chapter.chapterNumber,
            description: chapter.description,
            estimatedHours: chapter.estimatedHours,
            importance: chapter.importance,
            sortOrder: chapter.sortOrder,
          },
        });

        for (const topic of chapter.topics) {
          const newTopic = await prisma.studyTopic.create({
            data: {
              schoolId,
              chapterId: newChapter.id,
              name: topic.name,
              topicNumber: topic.topicNumber,
              description: topic.description,
              estimatedMins: topic.estimatedMins,
              sortOrder: topic.sortOrder,
            },
          });

          for (const st of topic.subTopics) {
            await prisma.studySubTopic.create({
              data: {
                schoolId,
                topicId: newTopic.id,
                name: st.name,
                sortOrder: st.sortOrder,
              },
            });
          }
        }
      }

      return rep.code(201).send({ curriculum: newCurriculum, clonedChapters: source.chapters.length });
    }
  );

  // ─────────────────────────────────────────────────────────
  // CHAPTER MANAGEMENT
  // ─────────────────────────────────────────────────────────

  app.get(`${P}/chapters`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const chapters = await prisma.studyChapter.findMany({
        where: {
          schoolId,
          ...(q.curriculumId ? { curriculumId: Number(q.curriculumId) } : {}),
          ...(q.subjectId ? { subjectId: Number(q.subjectId) } : {}),
          ...(q.importance ? { importance: q.importance as any } : {}),
          isActive: true,
        },
        include: {
          subject: { select: { name: true, code: true, class: { select: { name: true } } } },
          _count: { select: { topics: true } },
        },
        orderBy: [{ subjectId: "asc" }, { chapterNumber: "asc" }],
      });
      return rep.send({ chapters });
    }
  );

  app.post(`${P}/chapters`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const chapter = await prisma.studyChapter.create({
        data: {
          schoolId,
          curriculumId: Number(b.curriculumId),
          subjectId: Number(b.subjectId),
          name: b.name,
          chapterNumber: Number(b.chapterNumber ?? 1),
          description: b.description ?? null,
          estimatedHours: Number(b.estimatedHours ?? 0),
          importance: b.importance as any ?? "MEDIUM",
          sortOrder: Number(b.sortOrder ?? 0),
        },
      });
      return rep.code(201).send({ chapter });
    }
  );

  app.put(`${P}/chapters/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const chapter = await prisma.studyChapter.update({
        where: { id, schoolId },
        data: {
          name: b.name,
          chapterNumber: b.chapterNumber ? Number(b.chapterNumber) : undefined,
          description: b.description,
          estimatedHours: b.estimatedHours ? Number(b.estimatedHours) : undefined,
          importance: b.importance as any,
          sortOrder: b.sortOrder ? Number(b.sortOrder) : undefined,
          isActive: b.isActive,
        },
      });
      return rep.send({ chapter });
    }
  );

  app.delete(`${P}/chapters/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.studyChapter.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─────────────────────────────────────────────────────────
  // TOPIC MANAGEMENT
  // ─────────────────────────────────────────────────────────

  app.get(`${P}/topics`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const topics = await prisma.studyTopic.findMany({
        where: {
          schoolId,
          ...(q.chapterId ? { chapterId: Number(q.chapterId) } : {}),
          isActive: true,
        },
        include: {
          _count: { select: { subTopics: true, trackers: true } },
        },
        orderBy: [{ chapterId: "asc" }, { topicNumber: "asc" }],
      });
      return rep.send({ topics });
    }
  );

  app.post(`${P}/topics`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const topic = await prisma.studyTopic.create({
        data: {
          schoolId,
          chapterId: Number(b.chapterId),
          name: b.name,
          topicNumber: Number(b.topicNumber ?? 1),
          description: b.description ?? null,
          estimatedMins: Number(b.estimatedMins ?? 45),
          sortOrder: Number(b.sortOrder ?? 0),
        },
      });
      return rep.code(201).send({ topic });
    }
  );

  app.put(`${P}/topics/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const topic = await prisma.studyTopic.update({
        where: { id, schoolId },
        data: {
          name: b.name, description: b.description,
          topicNumber: b.topicNumber ? Number(b.topicNumber) : undefined,
          estimatedMins: b.estimatedMins ? Number(b.estimatedMins) : undefined,
          sortOrder: b.sortOrder ? Number(b.sortOrder) : undefined,
          isActive: b.isActive,
        },
      });
      return rep.send({ topic });
    }
  );

  app.delete(`${P}/topics/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.studyTopic.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // Sub-topics
  app.post(`${P}/subtopics`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const st = await prisma.studySubTopic.create({
        data: { schoolId, topicId: Number(b.topicId), name: b.name, sortOrder: Number(b.sortOrder ?? 0) },
      });
      return rep.code(201).send({ subTopic: st });
    }
  );

  app.delete(`${P}/subtopics/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.studySubTopic.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─────────────────────────────────────────────────────────
  // SYLLABUS TRACKING
  // ─────────────────────────────────────────────────────────

  // Get tracker grid for subject × class × academicYear
  app.get(`${P}/tracking`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const where: any = { schoolId };
      if (q.subjectId)    where.subjectId    = Number(q.subjectId);
      if (q.classId)      where.classId      = Number(q.classId);
      if (q.staffId)      where.staffId      = Number(q.staffId);
      if (q.academicYear) where.academicYear = q.academicYear;
      if (q.status)       where.status       = q.status;

      const trackers = await prisma.studySyllabusTracker.findMany({
        where,
        include: {
          topic: {
            include: {
              chapter: { select: { name: true, chapterNumber: true, importance: true } },
            },
          },
          subject: { select: { name: true, code: true } },
          staff: { include: { user: { select: { name: true, avatarUrl: true } } } },
        },
        orderBy: [{ subjectId: "asc" }, { topic: { chapter: { chapterNumber: "asc" } } }, { topic: { topicNumber: "asc" } }],
      });
      return rep.send({ trackers });
    }
  );

  // Upsert tracker (teacher updates progress)
  app.post(`${P}/tracking/update`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;

      const tracker = await prisma.studySyllabusTracker.upsert({
        where: {
          topicId_staffId_classId_academicYear: {
            topicId:      Number(b.topicId),
            staffId:      Number(b.staffId),
            classId:      Number(b.classId),
            academicYear: b.academicYear,
          },
        },
        create: {
          schoolId,
          subjectId:    Number(b.subjectId),
          topicId:      Number(b.topicId),
          staffId:      Number(b.staffId),
          classId:      Number(b.classId),
          academicYear: b.academicYear,
          status:       b.status as any,
          progressPct:  Number(b.progressPct ?? 0),
          notes:        b.notes ?? null,
          startedAt:    b.status !== "NOT_STARTED" ? new Date() : null,
          completedAt:  (b.status === "COMPLETED" || b.status === "REVISION") ? new Date() : null,
        },
        update: {
          status:      b.status as any,
          progressPct: b.progressPct ? Number(b.progressPct) : undefined,
          notes:       b.notes ?? undefined,
          startedAt:   b.status !== "NOT_STARTED" ? (new Date()) : undefined,
          completedAt: (b.status === "COMPLETED" || b.status === "REVISION") ? new Date() : undefined,
        },
      });
      return rep.send({ tracker });
    }
  );

  // Bulk update (mark multiple topics at once)
  app.post(`${P}/tracking/bulk-update`, { preHandler: [authenticate, requireCapability('studyCenter.advanced')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { updates } = req.body as any;

      const results = [];
      for (const b of updates) {
        const tracker = await prisma.studySyllabusTracker.upsert({
          where: {
            topicId_staffId_classId_academicYear: {
              topicId:      Number(b.topicId),
              staffId:      Number(b.staffId),
              classId:      Number(b.classId),
              academicYear: b.academicYear,
            },
          },
          create: {
            schoolId,
            subjectId: Number(b.subjectId),
            topicId:   Number(b.topicId),
            staffId:   Number(b.staffId),
            classId:   Number(b.classId),
            academicYear: b.academicYear,
            status: b.status as any,
            progressPct: 0,
            startedAt: b.status !== "NOT_STARTED" ? new Date() : null,
            completedAt: (b.status === "COMPLETED" || b.status === "REVISION") ? new Date() : null,
          },
          update: {
            status: b.status as any,
            startedAt:  b.status !== "NOT_STARTED" ? new Date() : undefined,
            completedAt: (b.status === "COMPLETED" || b.status === "REVISION") ? new Date() : undefined,
          },
        });
        results.push(tracker);
      }
      return rep.send({ updated: results.length });
    }
  );

  // ─────────────────────────────────────────────────────────
  // REPORTS
  // ─────────────────────────────────────────────────────────

  // Completion report per class
  app.get(`${P}/reports/completion`, { preHandler: [authenticate, requireCapability('studyCenter.advanced')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const classes = await prisma.class.findMany({
        where: { schoolId, isActive: true },
        select: { id: true, name: true, classNumber: true, section: true },
        orderBy: { classNumber: "asc" },
      });

      const report = await Promise.all(classes.map(async cls => {
        const trackers = await prisma.studySyllabusTracker.findMany({
          where: { schoolId, classId: cls.id, ...(q.academicYear ? { academicYear: q.academicYear } : {}) },
          select: { status: true },
        });
        const total = trackers.length;
        const done  = trackers.filter(t => t.status === "COMPLETED" || t.status === "REVISION").length;
        const inProg = trackers.filter(t => t.status === "IN_PROGRESS" || t.status === "STARTED").length;
        return { classId: cls.id, className: cls.name, classNumber: cls.classNumber, section: cls.section, total, done, inProgress: inProg, notStarted: total - done - inProg, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
      }));

      return rep.send({ report });
    }
  );

  // Teacher progress report
  app.get(`${P}/reports/teacher`, { preHandler: [authenticate, requireCapability('studyCenter.advanced')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const byTeacher = await prisma.studySyllabusTracker.groupBy({
        by: ["staffId", "status"],
        where: { schoolId, ...(q.academicYear ? { academicYear: q.academicYear } : {}) },
        _count: { id: true },
      });

      const staffIds = [...new Set(byTeacher.map(t => t.staffId))];
      const staffDetails = await prisma.staff.findMany({
        where: { id: { in: staffIds } },
        include: { user: { select: { name: true, avatarUrl: true } }, departmentRef: { select: { name: true } } },
      });

      const teacherReport = staffIds.map(sid => {
        const rows  = byTeacher.filter(t => t.staffId === sid);
        const total = rows.reduce((s, r) => s + r._count.id, 0);
        const done  = rows.filter(r => r.status === "COMPLETED" || r.status === "REVISION").reduce((s, r) => s + r._count.id, 0);
        const inProg = rows.filter(r => r.status === "IN_PROGRESS" || r.status === "STARTED").reduce((s, r) => s + r._count.id, 0);
        const staff = staffDetails.find(s => s.id === sid);
        return { staffId: sid, name: staff?.user?.name ?? "—", dept: (staff as any)?.departmentRef?.name ?? "—", total, done, inProgress: inProg, notStarted: total - done - inProg, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
      }).sort((a, b) => b.pct - a.pct);

      return rep.send({ teacherReport });
    }
  );
}
