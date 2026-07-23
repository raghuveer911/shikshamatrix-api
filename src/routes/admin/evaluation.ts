import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── Grade Calculator ──────────────────────────────────────────
async function calcGrade(schoolId: number, examId: number, pct: number) {
  const grades = await prisma.gradeScale.findMany({
    where: { schoolId, examConfigId: examId },
    orderBy: { minPercent: "desc" },
  }).catch(() => []);

  for (const g of grades) {
    if (pct >= Number(g.minPercent) && pct <= Number(g.maxPercent))
      return { grade: g.grade, gradePoint: g.gradePoint ? Number(g.gradePoint) : null };
  }
  // Fallback
  if (pct >= 91) return { grade:"A1", gradePoint:10 };
  if (pct >= 81) return { grade:"A2", gradePoint:9 };
  if (pct >= 71) return { grade:"B1", gradePoint:8 };
  if (pct >= 61) return { grade:"B2", gradePoint:7 };
  if (pct >= 51) return { grade:"C1", gradePoint:6 };
  if (pct >= 41) return { grade:"C2", gradePoint:5 };
  if (pct >= 33) return { grade:"D",  gradePoint:4 };
  return { grade:"E", gradePoint:0 };
}

export async function adminEvaluationRoutes(app: FastifyInstance) {

  // ── GET /admin/evaluation/meta ────────────────────────────
  app.get("/admin/evaluation/meta",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [exams, schedules, staff, stats] = await Promise.all([
        prisma.onlineExam.findMany({
          where: { schoolId, status: { in: ["COMPLETED","LIVE","PUBLISHED"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, name: true, examCode: true, examType: true, totalMarks: true, subject: { select: { name: true } } },
        }),
        prisma.testSchedule.findMany({
          where: { schoolId, status: { in: ["COMPLETED","LIVE"] } },
          select: { id: true, exam: { select: { name: true } } },
        }),
        prisma.staff.findMany({
          where: { schoolId, isActive: true },
          select: { userId: true, user: { select: { id: true, name: true } } },
          take: 50,
        }),
        (async () => {
          const [total, autoDone, pending, manual, recheck, completed] = await Promise.all([
            prisma.evaluationRecord.count({ where: { schoolId } }),
            prisma.evaluationRecord.count({ where: { schoolId, status: "AUTO_EVALUATED" } }),
            prisma.evaluationRecord.count({ where: { schoolId, status: "PENDING" } }),
            prisma.evaluationRecord.count({ where: { schoolId, status: "IN_REVIEW" } }),
            prisma.recheckRequest.count({ where: { schoolId, status: "PENDING" } }),
            prisma.evaluationRecord.count({ where: { schoolId, status: { in: ["VERIFIED","APPROVED","PUBLISHED"] } } }),
          ]);
          return { total, autoDone, pending, manual, recheck, completed };
        })(),
      ]);

      return reply.send({ success: true, data: { exams, schedules, staff, stats } });
    }
  );

  // ── GET /admin/evaluation/submissions ─────────────────────
  app.get("/admin/evaluation/submissions",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as {
        page?: string; examId?: string; scheduleId?: string;
        status?: string; classId?: string; search?: string;
        evalType?: string;
      };

      const page  = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 20;
      const where: any = { schoolId };

      if (q.examId)     where.examId     = parseInt(q.examId);
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);
      if (q.status)     where.status     = q.status;
      if (q.search) {
        const sids = await prisma.student.findMany({
          where: { schoolId, user: { name: { contains: q.search, mode: "insensitive" } } },
          select: { id: true },
        });
        where.studentId = { in: sids.map(s => s.id) };
      }

      const [records, total] = await Promise.all([
        prisma.evaluationRecord.findMany({
          where, skip: (page-1)*limit, take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } },
            exam: { select: { name: true, examType: true } },
            evaluatedBy: { select: { name: true } },
          },
        }),
        prisma.evaluationRecord.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: { records, total, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  // ── GET /admin/evaluation/submission/:id ──────────────────
  app.get("/admin/evaluation/submission/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const record = await prisma.evaluationRecord.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          student: { include: { user: true, class: { select: { name: true } } } },
          exam: { select: { id: true, name: true, examType: true, totalMarks: true, totalQuestions: true } },
          evaluatedBy: { select: { name: true } },
          verifiedBy:  { select: { name: true } },
          recheckRequests: { orderBy: { createdAt: "desc" }, take: 3 },
        },
      });

      if (!record) return reply.status(404).send({ success: false, message: "Record not found." });

      // Get attempt responses
      const attempt = await prisma.testAttemptRecord.findFirst({
        where: { scheduleId: record.scheduleId, studentId: record.studentId },
        orderBy: { attemptNumber: "desc" },
      });

      // Get question details
      const questionMarks = record.questionMarks as any[] ?? [];
      const qIds = questionMarks.map((q: any) => q.questionId).filter(Boolean);
      const questions = qIds.length > 0
        ? await prisma.questionBank.findMany({
            where: { id: { in: qIds }, schoolId },
            select: { id: true, questionText: true, questionType: true, options: true, correctAnswer: true, explanation: true, marks: true },
          }).catch(() => [])
        : [];
      const qMap: Record<number, any> = {};
      questions.forEach((q: any) => { qMap[q.id] = q; });

      const enrichedQMarks = questionMarks.map((qm: any) => ({
        ...qm, questionDetail: qMap[qm.questionId] ?? null,
      }));

      return reply.send({
        success: true,
        data: { record, attempt, questionMarks: enrichedQMarks },
      });
    }
  );

  // ── POST /admin/evaluation/auto-evaluate ──────────────────
  app.post("/admin/evaluation/auto-evaluate",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { scheduleId: number; studentIds?: number[] };

      const schedule = await prisma.testSchedule.findFirst({
        where: { id: body.scheduleId, schoolId },
        include: { exam: { select: { id: true, totalMarks: true, passingMarks: true, hasNegMarking: true, negMarkValue: true, posMarkValue: true } } },
      });
      if (!schedule) return reply.status(404).send({ success: false, message: "Schedule not found." });

      // Get submissions
      const attWhere: any = { scheduleId: body.scheduleId, status: "SUBMITTED" };
      if (body.studentIds?.length) attWhere.studentId = { in: body.studentIds };

      const attempts = await prisma.testAttemptRecord.findMany({
        where: attWhere,
        include: { student: true },
      });

      // Get question bank for answers
      const responses0 = attempts[0]?.responses as any[] ?? [];
      const qIds = responses0.map((r: any) => r.questionId).filter(Boolean);
      const questions = qIds.length > 0
        ? await prisma.questionBank.findMany({
            where: { id: { in: qIds }, schoolId },
            select: { id: true, questionType: true, options: true, correctAnswer: true, trueFalseAnswer: true, numericalAnswer: true, numericalRange: true, marks: true },
          }).catch(() => [])
        : [];
      const qMap: Record<number, any> = {};
      questions.forEach((q: any) => { qMap[q.id] = q; });

      let evaluated = 0;

      for (const attempt of attempts) {
        const responses = attempt.responses as any[] ?? [];
        let correct = 0, wrong = 0, skipped = 0;
        let totalObtained = 0;
        const questionMarks: any[] = [];

        for (const r of responses) {
          const q = qMap[r.questionId];
          if (!q) continue;

          let isCorrect = false;
          let qMarks = 0;
          const maxMarks = Number(q.marks ?? 1);

          // Auto-evaluable types
          if (["SINGLE_MCQ","MULTI_MCQ","TRUE_FALSE","FILL_BLANK","NUMERICAL"].includes(q.questionType)) {
            if (q.questionType === "SINGLE_MCQ") {
              const correctOpt = (q.options as any[])?.find((o: any) => o.isCorrect)?.key;
              isCorrect = r.selectedOption === correctOpt;
            } else if (q.questionType === "MULTI_MCQ") {
              const correctKeys = new Set((q.options as any[])?.filter((o: any) => o.isCorrect).map((o: any) => o.key));
              const selectedKeys = new Set(Array.isArray(r.selectedOption) ? r.selectedOption : [r.selectedOption]);
              isCorrect = correctKeys.size === selectedKeys.size && [...correctKeys].every(k => selectedKeys.has(k));
            } else if (q.questionType === "TRUE_FALSE") {
              isCorrect = r.selectedOption === String(q.trueFalseAnswer);
            } else if (q.questionType === "FILL_BLANK") {
              isCorrect = r.textAnswer?.toLowerCase().trim() === q.correctAnswer?.toLowerCase().trim();
            } else if (q.questionType === "NUMERICAL") {
              const num = parseFloat(r.textAnswer ?? "");
              const range = Number(q.numericalRange ?? 0);
              isCorrect = !isNaN(num) && Math.abs(num - Number(q.numericalAnswer)) <= range;
            }

            if (r.selectedOption === null && r.textAnswer === null) {
              skipped++;
              qMarks = 0;
            } else if (isCorrect) {
              correct++;
              qMarks = schedule.exam.posMarkValue ? Math.min(Number(schedule.exam.posMarkValue), maxMarks) : maxMarks;
            } else {
              wrong++;
              qMarks = schedule.exam.hasNegMarking ? Number(schedule.exam.negMarkValue ?? 0) : 0;
            }
            totalObtained += qMarks;
          } else {
            // Subjective — needs manual evaluation
            qMarks = -1; // sentinel: not evaluated
          }

          questionMarks.push({
            questionId: r.questionId,
            questionType: q.questionType,
            maxMarks: Number(q.marks),
            obtainedMarks: qMarks,
            isCorrect: ["SINGLE_MCQ","MULTI_MCQ","TRUE_FALSE","FILL_BLANK","NUMERICAL"].includes(q.questionType) ? isCorrect : null,
            selectedOption: r.selectedOption,
            textAnswer: r.textAnswer,
            feedback: null,
            isManuallyEvaluated: false,
          });
        }

        const totalMax = Number(schedule.exam.totalMarks);
        const pct = totalMax > 0 ? Math.round((totalObtained / totalMax) * 100 * 100) / 100 : 0;
        const { grade, gradePoint } = await calcGrade(schoolId, schedule.exam.id, pct);
        const passing = Number(schedule.exam.passingMarks ?? totalMax * 0.33);
        const isPassed = totalObtained >= passing;

        const hasManual = questionMarks.some(q => q.obtainedMarks === -1);

        await prisma.evaluationRecord.upsert({
          where: { scheduleId_studentId: { scheduleId: body.scheduleId, studentId: attempt.studentId } },
          create: {
            schoolId, scheduleId: body.scheduleId,
            studentId: attempt.studentId, examId: schedule.exam.id,
            totalMarks: totalMax, obtainedMarks: Math.max(0, totalObtained),
            autoMarks: Math.max(0, totalObtained), manualMarks: 0,
            percentage: pct, grade, gradePoint, isPassed,
            correctAnswers: correct, wrongAnswers: wrong, skippedAnswers: skipped,
            questionMarks, timeTakenSecs: attempt.timeTakenSecs,
            status: hasManual ? "IN_REVIEW" : "AUTO_EVALUATED",
            evaluatedById: userId, evaluatedAt: new Date(),
          },
          update: {
            totalMarks: totalMax, obtainedMarks: Math.max(0, totalObtained),
            autoMarks: Math.max(0, totalObtained),
            percentage: pct, grade, gradePoint, isPassed,
            correctAnswers: correct, wrongAnswers: wrong, skippedAnswers: skipped,
            questionMarks,
            status: hasManual ? "IN_REVIEW" : "AUTO_EVALUATED",
            evaluatedById: userId, evaluatedAt: new Date(),
          },
        });
        evaluated++;
      }

      return reply.send({
        success: true,
        message: `Auto-evaluated ${evaluated} submissions.`,
        data: { evaluated },
      });
    }
  );

  // ── POST /admin/evaluation/save-marks ─────────────────────
  app.post("/admin/evaluation/save-marks",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        evaluationId: number;
        questionId: number;
        obtainedMarks: number;
        feedback?: string;
      };

      const record = await prisma.evaluationRecord.findFirst({
        where: { id: body.evaluationId, schoolId },
        include: { exam: { select: { totalMarks: true, passingMarks: true } } },
      });
      if (!record) return reply.status(404).send({ success: false, message: "Not found." });
      if (record.isLocked) return reply.status(400).send({ success: false, message: "Evaluation is locked." });

      // Update specific question marks in JSON
      const qMarks = (record.questionMarks as any[]) ?? [];
      const idx = qMarks.findIndex((q: any) => q.questionId === body.questionId);
      if (idx >= 0) {
        qMarks[idx] = { ...qMarks[idx], obtainedMarks: body.obtainedMarks, feedback: body.feedback ?? null, isManuallyEvaluated: true };
      }

      // Recalculate totals
      const manualTotal = qMarks.filter((q: any) => q.isManuallyEvaluated).reduce((s: number, q: any) => s + (q.obtainedMarks >= 0 ? q.obtainedMarks : 0), 0);
      const autoTotal   = qMarks.filter((q: any) => !q.isManuallyEvaluated && q.obtainedMarks !== -1).reduce((s: number, q: any) => s + Math.max(0, q.obtainedMarks), 0);
      const total = autoTotal + manualTotal;
      const totalMax = Number(record.exam.totalMarks);
      const pct = totalMax > 0 ? Math.round((total / totalMax) * 100 * 100) / 100 : 0;
      const { grade, gradePoint } = await calcGrade(schoolId, record.examId, pct);
      const passing = Number(record.exam.passingMarks ?? totalMax * 0.33);

      const allEvaluated = qMarks.every((q: any) => q.obtainedMarks !== -1);

      await prisma.evaluationRecord.update({
        where: { id: body.evaluationId },
        data: {
          questionMarks: qMarks,
          obtainedMarks: total, manualMarks: manualTotal, autoMarks: autoTotal,
          percentage: pct, grade, gradePoint, isPassed: total >= passing,
          status: allEvaluated ? "REVIEWED" : "IN_REVIEW",
          evaluatedById: userId, evaluatedAt: new Date(),
        },
      });

      return reply.send({
        success: true,
        message: "Marks saved.",
        data: { total, percentage: pct, grade, allEvaluated },
      });
    }
  );

  // ── POST /admin/evaluation/save-feedback ──────────────────
  app.post("/admin/evaluation/save-feedback",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { evaluationId, teacherFeedback, overallRemark } = req.body as { evaluationId: number; teacherFeedback?: string; overallRemark?: string };

      await prisma.evaluationRecord.updateMany({
        where: { id: evaluationId, schoolId },
        data: { teacherFeedback: teacherFeedback ?? undefined, overallRemark: overallRemark ?? undefined },
      });
      return reply.send({ success: true, message: "Feedback saved." });
    }
  );

  // ── PATCH /admin/evaluation/:id/status ────────────────────
  app.patch("/admin/evaluation/:id/status",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { status } = req.body as { status: string };

      await prisma.evaluationRecord.updateMany({
        where: { id: parseInt(id), schoolId },
        data: {
          status: status as any,
          ...(status === "VERIFIED"  && { verifiedById: userId, verifiedAt: new Date() }),
          ...(status === "PUBLISHED" && { publishedById: userId, publishedAt: new Date(), isResultVisible: true, isLocked: true }),
        },
      });
      return reply.send({ success: true, message: `Status → ${status}` });
    }
  );

  // ── POST /admin/evaluation/bulk-evaluate ──────────────────
  app.post("/admin/evaluation/bulk-evaluate",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { scheduleId } = req.body as { scheduleId: number };

      // Forward to auto-evaluate with no student filter = all
      return app.inject({
        method: "POST", url: "/admin/evaluation/auto-evaluate",
        headers: { authorization: req.headers.authorization ?? "" },
        payload: JSON.stringify({ scheduleId }),
      }).then(r => reply.status(r.statusCode).send(JSON.parse(r.body)));
    }
  );

  // ── POST /admin/evaluation/bulk-publish ───────────────────
  app.post("/admin/evaluation/bulk-publish",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { scheduleId, evalIds } = req.body as { scheduleId?: number; evalIds?: number[] };

      const where: any = { schoolId, status: { in: ["REVIEWED","VERIFIED","APPROVED"] } };
      if (scheduleId) where.scheduleId = scheduleId;
      if (evalIds?.length) where.id = { in: evalIds };

      const cnt = await prisma.evaluationRecord.updateMany({
        where,
        data: { status: "PUBLISHED", publishedById: userId, publishedAt: new Date(), isResultVisible: true, isLocked: true },
      });

      return reply.send({ success: true, message: `${cnt.count} results published.`, data: { count: cnt.count } });
    }
  );

  // ── GET /admin/evaluation/analytics ──────────────────────
  app.get("/admin/evaluation/analytics",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { examId?: string; scheduleId?: string };

      const where: any = { schoolId };
      if (q.examId)     where.examId     = parseInt(q.examId);
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);

      const records = await prisma.evaluationRecord.findMany({
        where,
        select: { percentage: true, isPassed: true, grade: true, obtainedMarks: true, correctAnswers: true, wrongAnswers: true, skippedAnswers: true, timeTakenSecs: true },
      });

      const pcts = records.map(r => Number(r.percentage));
      const avg    = pcts.length ? Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length*10)/10 : 0;
      const highest = pcts.length ? Math.max(...pcts) : 0;
      const lowest  = pcts.length ? Math.min(...pcts) : 0;
      const passed  = records.filter(r => r.isPassed).length;
      const gradeDist: Record<string,number> = {};
      records.forEach(r => { if (r.grade) gradeDist[r.grade] = (gradeDist[r.grade]??0)+1; });

      const avgTime = records.filter(r => r.timeTakenSecs).reduce((s,r) => s+(r.timeTakenSecs??0),0) / Math.max(1, records.filter(r=>r.timeTakenSecs).length);

      return reply.send({
        success: true,
        data: {
          total: records.length, passed, failed: records.length-passed,
          passPercent: records.length > 0 ? Math.round((passed/records.length)*100) : 0,
          avg, highest, lowest, avgTimeSecs: Math.round(avgTime),
          gradeDist,
        },
      });
    }
  );

  // ── GET /admin/evaluation/recheck-requests ────────────────
  app.get("/admin/evaluation/recheck-requests",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { status?: string };

      const requests = await prisma.recheckRequest.findMany({
        where: { schoolId, ...(q.status ? { status: q.status as any } : {}) },
        orderBy: { createdAt: "desc" },
        include: {
          student: { include: { user: { select: { name: true } } } },
          evaluation: { include: { exam: { select: { name: true } } } },
        },
      });

      return reply.send({ success: true, data: { requests } });
    }
  );

  // ── PATCH /admin/evaluation/recheck/:id ───────────────────
  app.patch("/admin/evaluation/recheck/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { action, newMarks, reviewNote } = req.body as { action: "ACCEPT"|"REJECT"; newMarks?: number; reviewNote?: string };

      const recheck = await prisma.recheckRequest.findFirst({
        where: { id: parseInt(id), schoolId },
        include: { evaluation: true },
      });
      if (!recheck) return reply.status(404).send({ success: false, message: "Not found." });

      await prisma.recheckRequest.update({
        where: { id: parseInt(id) },
        data: {
          status: action === "ACCEPT" ? "ACCEPTED" : "REJECTED",
          reviewNote: reviewNote ?? null,
          oldMarks: recheck.evaluation.obtainedMarks,
          newMarks: newMarks ?? null,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      });

      if (action === "ACCEPT" && newMarks !== undefined) {
        const eval_ = recheck.evaluation;
        const totalMax = Number(eval_.totalMarks);
        const pct = totalMax > 0 ? Math.round((newMarks / totalMax) * 100 * 100) / 100 : 0;
        const { grade, gradePoint } = await calcGrade(schoolId, eval_.examId, pct);
        await prisma.evaluationRecord.update({
          where: { id: recheck.evaluationId },
          data: { obtainedMarks: newMarks, percentage: pct, grade, gradePoint, isLocked: false, status: "REVIEWED" },
        });
        await prisma.recheckRequest.update({ where: { id: parseInt(id) }, data: { status: "RESOLVED" } });
      }

      return reply.send({ success: true, message: `Recheck ${action === "ACCEPT" ? "accepted" : "rejected"}.` });
    }
  );
}
