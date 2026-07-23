// apps/api/src/routes/dashboard/academics/syllabus.ts
//
// NEW MODULE — Syllabus Tracker.
// Hierarchy: StudyCurriculum → StudyChapter → StudyTopic → (StudySyllabusTracker)
//
// Key design decisions based on the confirmed schema:
//   - Subject is already class-specific (Class.subjects relation),
//     so StudyChapter.subjectId already implies which class it's for
//     — no separate classId needed on Curriculum/Chapter.
//   - The right curriculum is resolved via the CLASS's own
//     academicYear (Class.academicYear) matched against
//     StudyCurriculum.academicYear, preferring isDefault=true.
//   - Progress is tracked per (topic, teacher, class, academicYear) —
//     matches the unique constraint on StudySyllabusTracker exactly.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { z } from "zod";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[academics/syllabus] "${label}" failed:`, err?.message ?? err); return fallback; }
}

const updateSchema = z.object({
  classId:   z.number(),
  subjectId: z.number(),
  status:    z.enum(["NOT_STARTED", "STARTED", "IN_PROGRESS", "COMPLETED", "REVISION"]),
  progressPct: z.number().min(0).max(100).optional(),
  notes:     z.string().optional(),
});

export async function academicsSyllabusRoutes(app: FastifyInstance) {

  // ── GET /academics/syllabus?classId=&subjectId= — chapters+topics with progress ──
  app.get("/academics/syllabus",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { classId, subjectId } = req.query as Record<string, string>;

      if (!classId || !subjectId) {
        return reply.status(400).send({ success: false, error: "classId and subjectId required" });
      }

      const cls = await safe("class lookup", () =>
        prisma.class.findFirst({ where: { id: parseInt(classId), schoolId }, select: { academicYear: true } }), null);
      if (!cls) return reply.status(404).send({ success: false, error: "CLASS_NOT_FOUND" });

      const curriculum = await safe("curriculum lookup", () =>
        prisma.studyCurriculum.findFirst({
          where: { schoolId, academicYear: cls.academicYear, isActive: true },
          orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
        }), null);

      if (!curriculum) {
        return reply.send({ success: true, data: { chapters: [], overallProgress: 0, noCurriculum: true } });
      }

      const chapters = await safe("chapters fetch", () =>
        prisma.studyChapter.findMany({
          where: { schoolId, curriculumId: curriculum.id, subjectId: parseInt(subjectId), isActive: true },
          orderBy: [{ sortOrder: "asc" }, { chapterNumber: "asc" }],
          include: {
            topics: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { topicNumber: "asc" }] },
          },
        }), [] as any[]);

      const topicIds = chapters.flatMap((c: any) => c.topics.map((t: any) => t.id));
      const trackers = await safe("trackers fetch", () =>
        prisma.studySyllabusTracker.findMany({
          where: { topicId: { in: topicIds }, staffId, classId: parseInt(classId), academicYear: cls.academicYear },
        }), [] as any[]);
      const trackerMap = new Map(trackers.map((t: any) => [t.topicId, t]));

      const result = chapters.map((c: any) => {
        const topics = c.topics.map((t: any) => {
          const tr = trackerMap.get(t.id) as any;
          return {
            id: t.id, name: t.name, topicNumber: t.topicNumber, estimatedMins: t.estimatedMins,
            status: tr?.status ?? "NOT_STARTED",
            progressPct: tr?.progressPct ?? 0,
            startedAt: tr?.startedAt ?? null,
            completedAt: tr?.completedAt ?? null,
            notes: tr?.notes ?? null,
          };
        });
        const progressPct = topics.length > 0
          ? Math.round(topics.reduce((s: number, t: any) => s + t.progressPct, 0) / topics.length)
          : 0;
        const completedTopics = topics.filter((t: any) => t.status === "COMPLETED").length;

        return {
          id: c.id, name: c.name, chapterNumber: c.chapterNumber,
          importance: c.importance, estimatedHours: c.estimatedHours,
          topics, progressPct, completedTopics, totalTopics: topics.length,
        };
      });

      const overallProgress = result.length > 0
        ? Math.round(result.reduce((s, c) => s + c.progressPct, 0) / result.length)
        : 0;

      return reply.send({
        success: true,
        data: {
          curriculumName: curriculum.name,
          academicYear: cls.academicYear,
          chapters: result,
          overallProgress,
        },
      });
    }
  );

  // ── PATCH /academics/syllabus/topic/:topicId — update progress ──
  app.patch("/academics/syllabus/topic/:topicId",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const topicId = parseInt((req.params as any).topicId);

      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });
      const { classId, subjectId, status, progressPct, notes } = parsed.data;

      const cls = await safe("class lookup", () =>
        prisma.class.findFirst({ where: { id: classId, schoolId }, select: { academicYear: true } }), null);
      if (!cls) return reply.status(404).send({ success: false, error: "CLASS_NOT_FOUND" });

      const existing = await safe("existing tracker", () =>
        prisma.studySyllabusTracker.findUnique({
          where: { topicId_staffId_classId_academicYear: { topicId, staffId, classId, academicYear: cls.academicYear } },
        }), null);

      const computedProgress = progressPct ?? (status === "COMPLETED" ? 100 : status === "NOT_STARTED" ? 0 : existing?.progressPct ?? 0);
      const startedAt = existing?.startedAt ?? (status !== "NOT_STARTED" ? new Date() : null);
      const completedAt = status === "COMPLETED" ? (existing?.completedAt ?? new Date()) : null;

      const tracker = await prisma.studySyllabusTracker.upsert({
        where: { topicId_staffId_classId_academicYear: { topicId, staffId, classId, academicYear: cls.academicYear } },
        update: { status, progressPct: computedProgress, startedAt, completedAt, notes: notes ?? undefined },
        create: {
          schoolId, subjectId, topicId, staffId, classId, academicYear: cls.academicYear,
          status, progressPct: computedProgress, startedAt, completedAt, notes: notes ?? null,
        },
      });

      return reply.send({ success: true, message: "Progress updated", data: { tracker } });
    }
  );
}