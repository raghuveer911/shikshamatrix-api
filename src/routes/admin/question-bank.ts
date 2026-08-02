import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

export async function adminQuestionBankRoutes(app: FastifyInstance) {

  // ── GET /admin/question-bank/meta ─────────────────────────
  app.get("/admin/question-bank/meta",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [sectionSubjects, staff, stats] = await Promise.all([
        prisma.subject.findMany({
          where: { schoolId, isActive: true },
          select: { name: true, class: { select: { classNumber: true } } },
        }),
        prisma.staff.findMany({
          where: { schoolId, isActive: true },
          select: { userId: true, user: { select: { id: true, name: true } } },
          take: 50,
        }),
        (async () => {
          const [total, approved, pending, draft, mcq, subjective] = await Promise.all([
            prisma.questionBank.count({ where: { schoolId } }),
            prisma.questionBank.count({ where: { schoolId, status: "APPROVED" } }),
            prisma.questionBank.count({ where: { schoolId, status: "PENDING_REVIEW" } }),
            prisma.questionBank.count({ where: { schoolId, status: "DRAFT" } }),
            prisma.questionBank.count({ where: { schoolId, questionType: { in: ["SINGLE_MCQ","MULTI_MCQ","TRUE_FALSE"] } } }),
            prisma.questionBank.count({ where: { schoolId, questionType: { in: ["SHORT_ANSWER","LONG_ANSWER","CASE_STUDY"] } } }),
          ]);
          return { total, approved, pending, draft, mcq, subjective };
        })(),
      ]);

      // Distinct (classNumber, subjectName) combos — grade-level, shared
      // across every section instead of one dropdown row per section.
      const seen = new Map<string, { classNumber: string; subjectName: string }>();
      for (const s of sectionSubjects) {
        const key = `${s.class.classNumber}::${s.name}`;
        if (!seen.has(key)) seen.set(key, { classNumber: s.class.classNumber, subjectName: s.name });
      }
      const subjects = [...seen.values()].sort((a, b) => Number(a.classNumber) - Number(b.classNumber) || a.subjectName.localeCompare(b.subjectName));

      // Chapters grouped by subject
      const chapters = await prisma.qBChapter.findMany({
        where: { schoolId, isActive: true },
        orderBy: [{ classNumber: "asc" }, { subjectName: "asc" }, { serialNumber: "asc" }],
        include: {
          topics: { where: { isActive: true }, orderBy: { serialNumber: "asc" } },
        },
      });

      return reply.send({ success: true, data: { subjects, staff, stats, chapters } });
    }
  );

  // ── GET /admin/question-bank ──────────────────────────────
  app.get("/admin/question-bank",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as {
        page?: string; search?: string; subjectName?: string;
        chapterId?: string; topicId?: string; difficulty?: string;
        questionType?: string; status?: string; classNumber?: string;
        createdById?: string; boardType?: string; tags?: string;
      };

      const page  = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 15;
      const where: any = { schoolId };

      if (q.subjectName)  where.subjectName  = q.subjectName;
      if (q.chapterId)    where.chapterId    = parseInt(q.chapterId);
      if (q.topicId)      where.topicId      = parseInt(q.topicId);
      if (q.difficulty)   where.difficulty   = q.difficulty;
      if (q.questionType) where.questionType = q.questionType;
      if (q.status)       where.status       = q.status;
      if (q.classNumber)  where.classNumber  = q.classNumber;
      if (q.createdById)  where.createdById  = parseInt(q.createdById);
      if (q.boardType)    where.boardType    = q.boardType;
      if (q.tags)         where.tags         = { has: q.tags };
      if (q.search) {
        where.OR = [
          { questionText: { contains: q.search, mode: "insensitive" } },
          { tags: { has: q.search } },
        ];
      }

      const [questions, total] = await Promise.all([
        prisma.questionBank.findMany({
          where, skip: (page-1)*limit, take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            chapter:   { select: { name: true } },
            topic:     { select: { name: true } },
            createdBy: { select: { name: true } },
            reviewer:  { select: { name: true } },
          },
        }),
        prisma.questionBank.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: { questions, total, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  // ── GET /admin/question-bank/:id ──────────────────────────
  app.get("/admin/question-bank/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const q = await prisma.questionBank.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          chapter: { select: { id: true, name: true } },
          topic:   { select: { id: true, name: true } },
          createdBy: { select: { name: true } },
          reviewer:  { select: { name: true } },
        },
      });

      if (!q) return reply.status(404).send({ success: false, message: "Question not found." });
      return reply.send({ success: true, data: { question: q } });
    }
  );

  // ── POST /admin/question-bank ─────────────────────────────
  app.post("/admin/question-bank",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        classNumber: string; subjectName: string;
        chapterId?: number; topicId?: number;
        learningOutcome?: string; tags?: string[]; boardType?: string;
        questionType: string;
        questionText: string; questionHtml?: string; questionImageUrl?: string;
        options?: any[]; correctAnswer?: string; explanation?: string;
        explanationHtml?: string; matchPairs?: any[];
        trueFalseAnswer?: boolean; numericalAnswer?: number; numericalRange?: number;
        marks?: number; negativeMarks?: number;
        difficulty?: string; estimatedTimeSec?: number; cognitiveLevel?: string;
        status?: string; reviewerId?: number; reviewComment?: string;
        source?: string;
      };

      if (!body.questionText?.trim() || !body.classNumber || !body.subjectName || !body.questionType) {
        return reply.status(400).send({ success: false, message: "questionText, classNumber, subjectName and questionType required." });
      }

      const q = await prisma.questionBank.create({
        data: {
          schoolId, createdById: userId,
          classNumber: body.classNumber,
          subjectName: body.subjectName,
          chapterId: body.chapterId ?? null,
          topicId: body.topicId ?? null,
          learningOutcome: body.learningOutcome ?? null,
          tags: body.tags ?? [],
          boardType: body.boardType ?? null,
          questionType: body.questionType as any,
          questionText: body.questionText.trim(),
          questionHtml: body.questionHtml ?? null,
          questionImageUrl: body.questionImageUrl ?? null,
          options: body.options ?? null,
          correctAnswer: body.correctAnswer ?? null,
          explanation: body.explanation ?? null,
          explanationHtml: body.explanationHtml ?? null,
          matchPairs: body.matchPairs ?? null,
          trueFalseAnswer: body.trueFalseAnswer ?? null,
          numericalAnswer: body.numericalAnswer ?? null,
          numericalRange: body.numericalRange ?? null,
          marks: body.marks ?? 1,
          negativeMarks: body.negativeMarks ?? null,
          difficulty: body.difficulty as any ?? "MEDIUM",
          estimatedTimeSec: body.estimatedTimeSec ?? null,
          cognitiveLevel: body.cognitiveLevel as any ?? null,
          status: body.status as any ?? "DRAFT",
          reviewerId: body.reviewerId ?? null,
          reviewComment: body.reviewComment ?? null,
          source: body.source ?? "TEACHER",
        },
      });

      return reply.status(201).send({ success: true, message: "Question created.", data: { questionId: q.id } });
    }
  );

  // ── PUT /admin/question-bank/:id ──────────────────────────
  app.put("/admin/question-bank/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const body = req.body as any;

      const q = await prisma.questionBank.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!q) return reply.status(404).send({ success: false, message: "Not found." });

      await prisma.questionBank.update({
        where: { id: parseInt(id) },
        data: {
          ...(body.classNumber !== undefined     && { classNumber: body.classNumber }),
          ...(body.subjectName !== undefined     && { subjectName: body.subjectName }),
          ...(body.chapterId !== undefined       && { chapterId: body.chapterId }),
          ...(body.topicId !== undefined         && { topicId: body.topicId }),
          ...(body.learningOutcome !== undefined && { learningOutcome: body.learningOutcome }),
          ...(body.tags !== undefined            && { tags: body.tags }),
          ...(body.boardType !== undefined       && { boardType: body.boardType }),
          ...(body.questionType !== undefined    && { questionType: body.questionType }),
          ...(body.questionText !== undefined    && { questionText: body.questionText }),
          ...(body.questionHtml !== undefined    && { questionHtml: body.questionHtml }),
          ...(body.questionImageUrl !== undefined && { questionImageUrl: body.questionImageUrl }),
          ...(body.options !== undefined         && { options: body.options }),
          ...(body.correctAnswer !== undefined   && { correctAnswer: body.correctAnswer }),
          ...(body.explanation !== undefined     && { explanation: body.explanation }),
          ...(body.matchPairs !== undefined      && { matchPairs: body.matchPairs }),
          ...(body.trueFalseAnswer !== undefined && { trueFalseAnswer: body.trueFalseAnswer }),
          ...(body.numericalAnswer !== undefined && { numericalAnswer: body.numericalAnswer }),
          ...(body.marks !== undefined           && { marks: body.marks }),
          ...(body.negativeMarks !== undefined   && { negativeMarks: body.negativeMarks }),
          ...(body.difficulty !== undefined      && { difficulty: body.difficulty }),
          ...(body.estimatedTimeSec !== undefined && { estimatedTimeSec: body.estimatedTimeSec }),
          ...(body.cognitiveLevel !== undefined  && { cognitiveLevel: body.cognitiveLevel }),
          ...(body.status !== undefined          && { status: body.status }),
          ...(body.reviewerId !== undefined      && { reviewerId: body.reviewerId }),
          ...(body.reviewComment !== undefined   && { reviewComment: body.reviewComment }),
        },
      });

      return reply.send({ success: true, message: "Question updated." });
    }
  );

  // ── PATCH /admin/question-bank/:id/status ─────────────────
  app.patch("/admin/question-bank/:id/status",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { status, reviewComment } = req.body as { status: string; reviewComment?: string };

      await prisma.questionBank.updateMany({
        where: { id: parseInt(id), schoolId },
        data: {
          status: status as any,
          reviewerId: userId,
          reviewComment: reviewComment ?? null,
          reviewedAt: new Date(),
        },
      });
      return reply.send({ success: true, message: `Status updated to ${status}.` });
    }
  );

  // ── POST /admin/question-bank/:id/duplicate ───────────────
  app.post("/admin/question-bank/:id/duplicate",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };

      const src = await prisma.questionBank.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!src) return reply.status(404).send({ success: false, message: "Not found." });

      const dup = await prisma.questionBank.create({
        data: {
          schoolId, createdById: userId,
          classNumber: src.classNumber, subjectName: src.subjectName,
          chapterId: src.chapterId, topicId: src.topicId,
          learningOutcome: src.learningOutcome, tags: src.tags, boardType: src.boardType,
          questionType: src.questionType,
          questionText: `[COPY] ${src.questionText}`,
          questionHtml: src.questionHtml, questionImageUrl: src.questionImageUrl,
          options: src.options as any, correctAnswer: src.correctAnswer,
          explanation: src.explanation, matchPairs: src.matchPairs as any,
          trueFalseAnswer: src.trueFalseAnswer,
          numericalAnswer: src.numericalAnswer, numericalRange: src.numericalRange,
          marks: src.marks, negativeMarks: src.negativeMarks,
          difficulty: src.difficulty, estimatedTimeSec: src.estimatedTimeSec,
          cognitiveLevel: src.cognitiveLevel,
          status: "DRAFT", parentId: src.id, version: 1, source: src.source,
        },
      });

      return reply.status(201).send({ success: true, message: "Question duplicated.", data: { questionId: dup.id } });
    }
  );

  // ── DELETE /admin/question-bank/:id ───────────────────────
  app.delete("/admin/question-bank/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      // Soft delete → archive
      await prisma.questionBank.updateMany({
        where: { id: parseInt(id), schoolId },
        data: { status: "ARCHIVED" },
      });
      return reply.send({ success: true, message: "Question moved to archive." });
    }
  );

  // ── POST /admin/question-bank/bulk-import ─────────────────
  app.post("/admin/question-bank/bulk-import",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        classNumber: string; subjectName: string;
        chapterId?: number; difficulty?: string;
        questions: {
          questionText: string; questionType?: string;
          options?: any[]; correctAnswer?: string;
          explanation?: string; marks?: number; tags?: string[];
          difficulty?: string;
        }[];
      };

      if (!body.questions?.length) return reply.status(400).send({ success: false, message: "No questions." });

      const errors: string[] = [];
      const valid: any[] = [];

      body.questions.forEach((q, i) => {
        const row = i + 2; // row in Excel (header = row 1)
        if (!q.questionText?.trim()) { errors.push(`Row ${row}: Missing question text.`); return; }
        const qt = q.questionType ?? "SINGLE_MCQ";
        if (["SINGLE_MCQ","MULTI_MCQ"].includes(qt) && (!q.options || q.options.length < 2)) {
          errors.push(`Row ${row}: MCQ needs at least 2 options.`); return;
        }
        if (["SINGLE_MCQ","MULTI_MCQ"].includes(qt) && !q.correctAnswer && !q.options?.some((o:any) => o.isCorrect)) {
          errors.push(`Row ${row}: Correct answer not specified.`); return;
        }
        valid.push(q);
      });

      if (valid.length === 0) return reply.status(400).send({ success: false, message: "No valid questions.", data: { errors } });

      const created = await prisma.questionBank.createMany({
        data: valid.map(q => ({
          schoolId, createdById: userId,
          classNumber: body.classNumber,
          subjectName: body.subjectName,
          chapterId: body.chapterId ?? null,
          questionType: (q.questionType ?? "SINGLE_MCQ") as any,
          questionText: q.questionText.trim(),
          options: q.options ?? null,
          correctAnswer: q.correctAnswer ?? null,
          explanation: q.explanation ?? null,
          marks: q.marks ?? 1,
          difficulty: (q.difficulty ?? body.difficulty ?? "MEDIUM") as any,
          tags: q.tags ?? [],
          status: "DRAFT" as any,
          source: "IMPORTED",
        })),
      });

      return reply.status(201).send({
        success: true,
        message: `${created.count} questions imported.`,
        data: { imported: created.count, skipped: body.questions.length - valid.length, errors },
      });
    }
  );

  // ── GET /admin/question-bank/analytics ────────────────────
  app.get("/admin/question-bank/analytics",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { subjectName?: string };

      const where: any = { schoolId };
      if (q.subjectName) where.subjectName = q.subjectName;

      const [byDifficulty, byType, byStatus, bySubject, mostUsed, leastAccurate] = await Promise.all([
        prisma.questionBank.groupBy({ by: ["difficulty"], where, _count: true }),
        prisma.questionBank.groupBy({ by: ["questionType"], where, _count: true }),
        prisma.questionBank.groupBy({ by: ["status"], where, _count: true }),
        prisma.questionBank.groupBy({ by: ["subjectName"], where: { schoolId }, _count: true }),
        prisma.questionBank.findMany({ where: { ...where, usageCount: { gt: 0 } }, orderBy: { usageCount: "desc" }, take: 5 }),
        prisma.questionBank.findMany({ where: { ...where, attemptCount: { gt: 5 } }, orderBy: { correctCount: "asc" }, take: 5 }),
      ]);

      return reply.send({
        success: true,
        data: {
          byDifficulty: byDifficulty.map(b => ({ difficulty: b.difficulty, count: b._count })),
          byType: byType.map(b => ({ type: b.questionType, count: b._count })),
          byStatus: byStatus.map(b => ({ status: b.status, count: b._count })),
          bySubject: bySubject.map(b => ({ name: b.subjectName ?? "?", count: b._count })),
          mostUsed: mostUsed.map(q => ({ id: q.id, text: q.questionText.slice(0,80), usage: q.usageCount, subject: q.subjectName })),
          leastAccurate: leastAccurate.map(q => ({
            id: q.id, text: q.questionText.slice(0,80),
            accuracy: q.attemptCount > 0 ? Math.round((q.correctCount/q.attemptCount)*100) : 0,
            subject: q.subjectName,
          })),
        },
      });
    }
  );

  // ── Chapter CRUD ──────────────────────────────────────────
  app.get("/admin/question-bank/chapters",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { classNumber, subjectName } = req.query as { classNumber?: string; subjectName?: string };
      const chapters = await prisma.qBChapter.findMany({
        where: { schoolId, isActive: true, ...(classNumber ? { classNumber } : {}), ...(subjectName ? { subjectName } : {}) },
        orderBy: [{ classNumber: "asc" }, { subjectName: "asc" }, { serialNumber: "asc" }],
        include: {
          topics: { where: { isActive: true }, orderBy: { serialNumber: "asc" } },
          _count: { select: { questions: true } },
        },
      });
      return reply.send({ success: true, data: { chapters } });
    }
  );

  app.post("/admin/question-bank/chapters",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { classNumber, subjectName, name } = req.body as { classNumber: string; subjectName: string; name: string };
      const count = await prisma.qBChapter.count({ where: { schoolId, classNumber, subjectName } });
      const ch = await prisma.qBChapter.create({ data: { schoolId, classNumber, subjectName, name: name.trim(), serialNumber: count+1 } });
      return reply.status(201).send({ success: true, data: { chapter: ch } });
    }
  );

  app.post("/admin/question-bank/topics",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { chapterId, name } = req.body as { chapterId: number; name: string };
      const count = await prisma.qBTopic.count({ where: { chapterId } });
      const t = await prisma.qBTopic.create({ data: { schoolId, chapterId, name: name.trim(), serialNumber: count+1 } });
      return reply.status(201).send({ success: true, data: { topic: t } });
    }
  );

  app.delete("/admin/question-bank/chapters/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.qBChapter.updateMany({ where: { id: parseInt(id), schoolId }, data: { isActive: false } });
      return reply.send({ success: true });
    }
  );

  app.delete("/admin/question-bank/topics/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.questionBank')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.qBTopic.updateMany({ where: { id: parseInt(id), schoolId }, data: { isActive: false } });
      return reply.send({ success: true });
    }
  );
}
