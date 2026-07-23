import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── Helpers ───────────────────────────────────────────────────
function generateExamCode(id: number) {
  return `ONL-${new Date().getFullYear()}-${String(id).padStart(4, "0")}`;
}

const EXAM_TEMPLATES = [
  { name: "30 Min MCQ Quiz",         type: "MCQ",       duration: 30, totalMarks: 30,  totalQuestions: 30, hasNegMarking: false },
  { name: "60 Min Unit Test",        type: "MCQ",       duration: 60, totalMarks: 50,  totalQuestions: 50, hasNegMarking: false },
  { name: "90 Min Mock Test",        type: "MIXED",     duration: 90, totalMarks: 100, totalQuestions: 60, hasNegMarking: true, negMarkValue: -1, posMarkValue: 4 },
  { name: "CBSE Pattern Test",       type: "MIXED",     duration: 120, totalMarks: 80, totalQuestions: 40, hasNegMarking: false },
  { name: "Olympiad Pattern",        type: "MCQ",       duration: 90, totalMarks: 200, totalQuestions: 50, hasNegMarking: true, negMarkValue: -1, posMarkValue: 4 },
  { name: "Assignment Submission",   type: "ASSIGNMENT",duration: 0,  totalMarks: 20,  totalQuestions: 5,  hasNegMarking: false },
];

export async function adminOnlineExamRoutes(app: FastifyInstance) {

  // ── GET /admin/online-exams/meta ──────────────────────────
  app.get("/admin/online-exams/meta",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [subjects, classes, dashStats] = await Promise.all([
        prisma.subject.findMany({
          where: { schoolId, isActive: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        }),
        prisma.class.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          select: { id: true, name: true, classNumber: true, section: true },
        }),
        (async () => {
          const all = await prisma.onlineExam.groupBy({
            by: ["status"],
            where: { schoolId },
            _count: true,
          });
          const m: Record<string, number> = {};
          all.forEach(a => { m[a.status] = a._count; });
          return {
            total:     Object.values(m).reduce((s,c)=>s+c,0),
            draft:     m["DRAFT"]     ?? 0,
            published: m["PUBLISHED"] ?? 0,
            live:      m["LIVE"]      ?? 0,
            scheduled: m["SCHEDULED"] ?? 0,
            completed: m["COMPLETED"] ?? 0,
          };
        })(),
      ]);

      // Question bank count
      const qbCount = await prisma.questionBank?.count({ where: { schoolId } }).catch(() => 0);

      return reply.send({
        success: true,
        data: { subjects, classes, dashStats, templates: EXAM_TEMPLATES, questionBankCount: qbCount ?? 0 },
      });
    }
  );

  // ── GET /admin/online-exams ───────────────────────────────
  app.get("/admin/online-exams",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as {
        page?: string; search?: string; status?: string;
        subjectId?: string; category?: string;
      };

      const page  = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 15;
      const where: any = { schoolId };
      if (q.status)    where.status    = q.status;
      if (q.subjectId) where.subjectId = parseInt(q.subjectId);
      if (q.category)  where.category  = q.category;
      if (q.search)    where.OR = [
        { name:     { contains: q.search, mode: "insensitive" } },
        { examCode: { contains: q.search, mode: "insensitive" } },
      ];

      const [exams, total] = await Promise.all([
        prisma.onlineExam.findMany({
          where, skip: (page-1)*limit, take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            subject: { select: { name: true } },
            createdBy: { select: { name: true } },
            _count: { select: { attempts: true } },
          },
        }),
        prisma.onlineExam.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: { exams, total, totalPages: Math.ceil(total/limit) },
      });
    }
  );

  // ── GET /admin/online-exams/:id ───────────────────────────
  app.get("/admin/online-exams/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const exam = await prisma.onlineExam.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          subject: { select: { id: true, name: true } },
          createdBy: { select: { name: true } },
          _count: { select: { attempts: true } },
        },
      });

      if (!exam) return reply.status(404).send({ success: false, message: "Exam not found." });

      // Question details if questionConfig exists
      let questions: any[] = [];
      if (exam.questionConfig) {
        const cfg = exam.questionConfig as any[];
        const qIds = cfg.map(q => q.questionId).filter(Boolean);
        if (qIds.length) {
          const qRows = await prisma.questionBank?.findMany({
            where: { id: { in: qIds }, schoolId },
            select: { id: true, questionText: true, questionType: true, difficulty: true, subject: { select: { name: true } } },
          }).catch(() => []) ?? [];
          const qMap: Record<number, any> = {};
          qRows.forEach((q: any) => { qMap[q.id] = q; });
          questions = cfg.map(c => ({ ...c, question: qMap[c.questionId] ?? null }));
        }
      }

      return reply.send({ success: true, data: { exam, questions } });
    }
  );

  // ── POST /admin/online-exams ──────────────────────────────
  app.post("/admin/online-exams",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as any;

      // Get current session
      const currentYear = await prisma.academicYear.findFirst({
        where: { schoolId, isCurrent: true },
        select: { name: true },
      });

      const exam = await prisma.onlineExam.create({
        data: {
          schoolId, createdById: userId,
          name: body.name?.trim() ?? "New Exam",
          examCode: "TEMP",
          description: body.description ?? null,
          instructions: body.instructions ?? null,
          academicSession: currentYear?.name ?? body.academicSession ?? "",
          subjectId: body.subjectId ?? null,
          chapterTopic: body.chapterTopic ?? null,
          applicableClasses: body.applicableClasses ?? [],
          applicableSections: body.applicableSections ?? [],
          category: body.category ?? "UNIT_TEST",
          tags: body.tags ?? [],
          examType: body.examType ?? "MCQ",
          totalQuestions: body.totalQuestions ?? 0,
          totalMarks: body.totalMarks ?? 0,
          duration: body.duration ?? 60,
          passingMarks: body.passingMarks ?? null,
          passingPercent: body.passingPercent ?? null,
          hasNegMarking: body.hasNegMarking ?? false,
          negMarkValue: body.negMarkValue ?? null,
          posMarkValue: body.posMarkValue ?? null,
          hasPartialMarks: body.hasPartialMarks ?? false,
          randomizeQns: body.randomizeQns ?? false,
          randomizeOpts: body.randomizeOpts ?? false,
          showCalculator: body.showCalculator ?? false,
          showFormulaSheet: body.showFormulaSheet ?? false,
          questionConfig: body.questionConfig ?? null,
          attemptsAllowed: body.attemptsAllowed ?? 1,
          strictTimer: body.strictTimer ?? true,
          allowResume: body.allowResume ?? false,
          allowPause: body.allowPause ?? false,
          navigationMode: body.navigationMode ?? "FREE",
          markForReview: body.markForReview ?? true,
          questionView: body.questionView ?? "ONE_BY_ONE",
          resultVisibility: body.resultVisibility ?? "AFTER_SUBMISSION",
          fullScreenMode: body.fullScreenMode ?? false,
          tabSwitchDetect: body.tabSwitchDetect ?? false,
          refreshDetect: body.refreshDetect ?? false,
          preventMultiLogin: body.preventMultiLogin ?? false,
          singleDeviceOnly: body.singleDeviceOnly ?? false,
          rightClickDisable: body.rightClickDisable ?? false,
          copyPasteRestrict: body.copyPasteRestrict ?? false,
          maxTabSwitches: body.maxTabSwitches ?? 3,
          status: "DRAFT",
          scheduledStart: body.scheduledStart ? new Date(body.scheduledStart) : null,
          scheduledEnd:   body.scheduledEnd   ? new Date(body.scheduledEnd)   : null,
        },
      });

      // Update examCode
      await prisma.onlineExam.update({
        where: { id: exam.id },
        data: { examCode: generateExamCode(exam.id) },
      });

      return reply.status(201).send({ success: true, message: "Exam created.", data: { examId: exam.id } });
    }
  );

  // ── PUT /admin/online-exams/:id ───────────────────────────
  app.put("/admin/online-exams/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const body = req.body as any;

      const exam = await prisma.onlineExam.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!exam) return reply.status(404).send({ success: false, message: "Not found." });
      if (exam.status === "LIVE" || exam.status === "COMPLETED") {
        return reply.status(400).send({ success: false, message: "Cannot edit a live or completed exam." });
      }

      await prisma.onlineExam.update({
        where: { id: parseInt(id) },
        data: {
          ...(body.name !== undefined           && { name: body.name }),
          ...(body.description !== undefined    && { description: body.description }),
          ...(body.instructions !== undefined   && { instructions: body.instructions }),
          ...(body.subjectId !== undefined      && { subjectId: body.subjectId }),
          ...(body.chapterTopic !== undefined   && { chapterTopic: body.chapterTopic }),
          ...(body.applicableClasses !== undefined && { applicableClasses: body.applicableClasses }),
          ...(body.applicableSections !== undefined && { applicableSections: body.applicableSections }),
          ...(body.category !== undefined       && { category: body.category }),
          ...(body.tags !== undefined           && { tags: body.tags }),
          ...(body.examType !== undefined       && { examType: body.examType }),
          ...(body.totalQuestions !== undefined && { totalQuestions: body.totalQuestions }),
          ...(body.totalMarks !== undefined     && { totalMarks: body.totalMarks }),
          ...(body.duration !== undefined       && { duration: body.duration }),
          ...(body.passingMarks !== undefined   && { passingMarks: body.passingMarks }),
          ...(body.passingPercent !== undefined && { passingPercent: body.passingPercent }),
          ...(body.hasNegMarking !== undefined  && { hasNegMarking: body.hasNegMarking }),
          ...(body.negMarkValue !== undefined   && { negMarkValue: body.negMarkValue }),
          ...(body.posMarkValue !== undefined   && { posMarkValue: body.posMarkValue }),
          ...(body.hasPartialMarks !== undefined && { hasPartialMarks: body.hasPartialMarks }),
          ...(body.randomizeQns !== undefined   && { randomizeQns: body.randomizeQns }),
          ...(body.randomizeOpts !== undefined  && { randomizeOpts: body.randomizeOpts }),
          ...(body.showCalculator !== undefined && { showCalculator: body.showCalculator }),
          ...(body.showFormulaSheet !== undefined && { showFormulaSheet: body.showFormulaSheet }),
          ...(body.questionConfig !== undefined && { questionConfig: body.questionConfig }),
          ...(body.attemptsAllowed !== undefined && { attemptsAllowed: body.attemptsAllowed }),
          ...(body.strictTimer !== undefined    && { strictTimer: body.strictTimer }),
          ...(body.allowResume !== undefined    && { allowResume: body.allowResume }),
          ...(body.allowPause !== undefined     && { allowPause: body.allowPause }),
          ...(body.navigationMode !== undefined && { navigationMode: body.navigationMode }),
          ...(body.markForReview !== undefined  && { markForReview: body.markForReview }),
          ...(body.questionView !== undefined   && { questionView: body.questionView }),
          ...(body.resultVisibility !== undefined && { resultVisibility: body.resultVisibility }),
          ...(body.fullScreenMode !== undefined && { fullScreenMode: body.fullScreenMode }),
          ...(body.tabSwitchDetect !== undefined && { tabSwitchDetect: body.tabSwitchDetect }),
          ...(body.refreshDetect !== undefined  && { refreshDetect: body.refreshDetect }),
          ...(body.preventMultiLogin !== undefined && { preventMultiLogin: body.preventMultiLogin }),
          ...(body.singleDeviceOnly !== undefined && { singleDeviceOnly: body.singleDeviceOnly }),
          ...(body.rightClickDisable !== undefined && { rightClickDisable: body.rightClickDisable }),
          ...(body.copyPasteRestrict !== undefined && { copyPasteRestrict: body.copyPasteRestrict }),
          ...(body.maxTabSwitches !== undefined && { maxTabSwitches: body.maxTabSwitches }),
          ...(body.status !== undefined         && { status: body.status }),
          ...(body.scheduledStart !== undefined && { scheduledStart: body.scheduledStart ? new Date(body.scheduledStart) : null }),
          ...(body.scheduledEnd !== undefined   && { scheduledEnd: body.scheduledEnd ? new Date(body.scheduledEnd) : null }),
        },
      });

      return reply.send({ success: true, message: "Exam updated." });
    }
  );

  // ── PATCH /admin/online-exams/:id/publish ─────────────────
  app.patch("/admin/online-exams/:id/publish",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { scheduledStart, scheduledEnd } = req.body as { scheduledStart?: string; scheduledEnd?: string };

      const exam = await prisma.onlineExam.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!exam) return reply.status(404).send({ success: false, message: "Not found." });

      // Validation
      const cfg = exam.questionConfig as any[] | null;
      if (!cfg || cfg.length === 0) return reply.status(400).send({ success: false, message: "No questions selected. Add questions before publishing." });
      if (exam.totalQuestions === 0) return reply.status(400).send({ success: false, message: "Total questions cannot be 0." });

      const newStatus = scheduledStart ? "SCHEDULED" : "PUBLISHED";
      await prisma.onlineExam.update({
        where: { id: parseInt(id) },
        data: {
          status: newStatus as any,
          publishedAt: new Date(),
          scheduledStart: scheduledStart ? new Date(scheduledStart) : undefined,
          scheduledEnd: scheduledEnd ? new Date(scheduledEnd) : undefined,
        },
      });

      return reply.send({ success: true, message: `Exam ${newStatus.toLowerCase()}.` });
    }
  );

  // ── POST /admin/online-exams/:id/clone ────────────────────
  app.post("/admin/online-exams/:id/clone",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { name } = req.body as { name?: string };

      const src = await prisma.onlineExam.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!src) return reply.status(404).send({ success: false, message: "Not found." });

      const cloned = await prisma.onlineExam.create({
        data: {
          schoolId, createdById: userId,
          name: name ?? `${src.name} (Copy)`,
          examCode: "TEMP",
          description: src.description, instructions: src.instructions,
          academicSession: src.academicSession,
          subjectId: src.subjectId, chapterTopic: src.chapterTopic,
          applicableClasses: src.applicableClasses, applicableSections: src.applicableSections,
          category: src.category, tags: src.tags,
          examType: src.examType, totalQuestions: src.totalQuestions, totalMarks: src.totalMarks,
          duration: src.duration, passingMarks: src.passingMarks, passingPercent: src.passingPercent,
          hasNegMarking: src.hasNegMarking, negMarkValue: src.negMarkValue, posMarkValue: src.posMarkValue,
          hasPartialMarks: src.hasPartialMarks, randomizeQns: src.randomizeQns, randomizeOpts: src.randomizeOpts,
          showCalculator: src.showCalculator, showFormulaSheet: src.showFormulaSheet,
          questionConfig: src.questionConfig as any,
          attemptsAllowed: src.attemptsAllowed, strictTimer: src.strictTimer,
          allowResume: src.allowResume, allowPause: src.allowPause,
          navigationMode: src.navigationMode, markForReview: src.markForReview,
          questionView: src.questionView, resultVisibility: src.resultVisibility,
          fullScreenMode: src.fullScreenMode, tabSwitchDetect: src.tabSwitchDetect,
          refreshDetect: src.refreshDetect, preventMultiLogin: src.preventMultiLogin,
          singleDeviceOnly: src.singleDeviceOnly, rightClickDisable: src.rightClickDisable,
          copyPasteRestrict: src.copyPasteRestrict, maxTabSwitches: src.maxTabSwitches,
          status: "DRAFT", version: 1, parentId: src.id,
        },
      });

      await prisma.onlineExam.update({ where: { id: cloned.id }, data: { examCode: generateExamCode(cloned.id) } });

      return reply.status(201).send({ success: true, message: "Exam cloned.", data: { examId: cloned.id } });
    }
  );

  // ── DELETE /admin/online-exams/:id ────────────────────────
  app.delete("/admin/online-exams/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const exam = await prisma.onlineExam.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!exam) return reply.status(404).send({ success: false, message: "Not found." });
      if (exam.status === "LIVE") return reply.status(400).send({ success: false, message: "Cannot delete a live exam." });

      await prisma.onlineExam.delete({ where: { id: parseInt(id) } });
      return reply.send({ success: true, message: "Exam deleted." });
    }
  );

  // ── PATCH /admin/online-exams/:id/status ─────────────────
  app.patch("/admin/online-exams/:id/status",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { status } = req.body as { status: string };

      await prisma.onlineExam.updateMany({
        where: { id: parseInt(id), schoolId },
        data: {
          status: status as any,
          ...(status === "COMPLETED" && { completedAt: new Date() }),
        },
      });
      return reply.send({ success: true, message: `Exam status updated to ${status}.` });
    }
  );

  // ── GET /admin/online-exams/:id/validate ──────────────────
  app.get("/admin/online-exams/:id/validate",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const exam = await prisma.onlineExam.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!exam) return reply.status(404).send({ success: false, message: "Not found." });

      const errors: string[] = [];
      const warnings: string[] = [];

      if (!exam.name?.trim()) errors.push("Exam name is required.");
      if (exam.totalQuestions === 0) errors.push("No questions added.");
      if (Number(exam.totalMarks) === 0) errors.push("Total marks cannot be 0.");
      if (exam.duration <= 0) errors.push("Duration must be greater than 0.");

      const cfg = exam.questionConfig as any[] | null;
      if (!cfg || cfg.length === 0) errors.push("No questions selected in Step 3.");
      else {
        const cfgTotal = cfg.reduce((s, q) => s + (q.marks ?? 0), 0);
        if (Math.abs(cfgTotal - Number(exam.totalMarks)) > 0.01) {
          warnings.push(`Marks mismatch: Question marks total (${cfgTotal}) ≠ Total marks (${exam.totalMarks}).`);
        }
      }

      if (exam.applicableClasses.length === 0) warnings.push("No classes assigned.");
      if (!exam.subjectId) warnings.push("No subject linked.");
      if (!exam.passingMarks && !exam.passingPercent) warnings.push("Passing criteria not set.");

      return reply.send({
        success: true,
        data: { isValid: errors.length === 0, errors, warnings },
      });
    }
  );
}
