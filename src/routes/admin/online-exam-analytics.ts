import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── helpers ──────────────────────────────────────────────────
function stdDev(vals: number[]) {
  if (!vals.length) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sq = vals.map(v => (v - mean) ** 2);
  return Math.round(Math.sqrt(sq.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}
function median(sorted: number[]) {
  if (!sorted.length) return 0;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}
function difficultyLabel(pct: number) {
  if (pct >= 70) return "EASY";
  if (pct >= 40) return "MODERATE";
  return "HARD";
}

export async function adminOnlineExamAnalyticsRoutes(app: FastifyInstance) {

  // ── GET /admin/online-exam-analytics/meta ────────────────────────
  app.get("/admin/online-exam-analytics/meta",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [exams, schedules, classes, subjects] = await Promise.all([
        prisma.onlineExam.findMany({
          where: { schoolId, status: { in: ["COMPLETED","PUBLISHED","LIVE"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, name: true, examCode: true, category: true, createdAt: true,
                    subject: { select: { id: true, name: true } } },
        }),
        prisma.testSchedule.findMany({
          where: { schoolId, status: { in: ["COMPLETED","LIVE"] } },
          orderBy: { startTime: "desc" },
          select: { id: true, startTime: true, endTime: true,
                    exam: { select: { id: true, name: true } } },
        }),
        prisma.class.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          select: { id: true, name: true, classNumber: true, section: true },
        }),
        prisma.subject.findMany({
          where: { schoolId, isActive: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        }),
      ]);

      return reply.send({ success: true, data: { exams, schedules, classes, subjects } });
    }
  );

  // ── GET /admin/online-exam-analytics/overview ────────────────────
  app.get("/admin/online-exam-analytics/overview",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string; examId?: string; classId?: string };

      const where: any = { schoolId };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);
      if (q.examId)     where.examId     = parseInt(q.examId);

      const evals = await prisma.evaluationRecord.findMany({
        where,
        select: {
          percentage: true, isPassed: true, grade: true,
          obtainedMarks: true, totalMarks: true,
          correctAnswers: true, wrongAnswers: true, skippedAnswers: true,
          timeTakenSecs: true, createdAt: true, studentId: true,
          student: { include: { class: { select: { name: true } } } },
        },
      });

      if (!evals.length) return reply.send({ success: true, data: { empty: true } });

      const pcts    = evals.map(e => Number(e.percentage));
      const sorted  = [...pcts].sort((a, b) => a - b);
      const passed  = evals.filter(e => e.isPassed).length;
      const total   = evals.length;

      // Grade distribution
      const gradeDist: Record<string, number> = {};
      evals.forEach(e => { if (e.grade) gradeDist[e.grade] = (gradeDist[e.grade] ?? 0) + 1; });

      // Score buckets
      const buckets = [
        { range:"0-20",  count:0 }, { range:"21-40", count:0 },
        { range:"41-60", count:0 }, { range:"61-80",  count:0 },
        { range:"81-100",count:0 },
      ];
      pcts.forEach(p => {
        if (p <= 20) buckets[0].count++;
        else if (p <= 40) buckets[1].count++;
        else if (p <= 60) buckets[2].count++;
        else if (p <= 80) buckets[3].count++;
        else              buckets[4].count++;
      });

      // Attempt rate = students who submitted vs eligible
      let eligible = total;
      if (q.scheduleId) {
        const sch = await prisma.testSchedule.findFirst({ where: { id: parseInt(q.scheduleId) }, select: { totalEligible: true } });
        eligible = sch?.totalEligible || total;
      }

      return reply.send({
        success: true,
        data: {
          kpi: {
            totalStudents: total,
            attemptRate: eligible > 0 ? Math.round((total / eligible) * 100) : 100,
            avgScore: Math.round(pcts.reduce((a, b) => a + b, 0) / total * 10) / 10,
            passPercent: Math.round((passed / total) * 100),
            highest: Math.max(...pcts),
            lowest:  Math.min(...pcts),
            median:  median(sorted),
            stdDev:  stdDev(pcts),
          },
          gradeDist: Object.entries(gradeDist).map(([g, c]) => ({ grade: g, count: c }))
                           .sort((a, b) => b.count - a.count),
          buckets,
          passFail: [{ name:"Passed", value:passed }, { name:"Failed", value:total - passed }],
          difficultyIndex: difficultyLabel(Math.round(pcts.reduce((a, b) => a + b, 0) / total)),
        },
      });
    }
  );

  // ── GET /admin/online-exam-analytics/students ────────────────────
  app.get("/admin/online-exam-analytics/students",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string; examId?: string; classId?: string; filter?: string };

      const where: any = { schoolId };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);
      if (q.examId)     where.examId     = parseInt(q.examId);

      const evals = await prisma.evaluationRecord.findMany({
        where,
        orderBy: { percentage: "desc" },
        include: {
          student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } },
        },
      });

      // Rank + flag at-risk
      const ranked = evals.map((e, i) => ({
        studentId:    e.studentId,
        name:         e.student.user.name,
        class:        e.student.class?.name ?? "—",
        rank:         i + 1,
        score:        Number(e.obtainedMarks),
        totalMarks:   Number(e.totalMarks),
        percentage:   Number(e.percentage),
        grade:        e.grade ?? "—",
        isPassed:     e.isPassed,
        correctAnswers: e.correctAnswers,
        wrongAnswers:   e.wrongAnswers,
        timeTakenSecs:  e.timeTakenSecs,
        isAtRisk:     Number(e.percentage) < 40,
        isTopper:     i < 3,
      }));

      const all    = ranked;
      const atRisk = ranked.filter(s => s.isAtRisk);
      const toppers= ranked.slice(0, 10);

      const result = q.filter === "AT_RISK" ? atRisk : q.filter === "TOPPERS" ? toppers : all;

      return reply.send({ success: true, data: { students: result, total: result.length } });
    }
  );

  // ── GET /admin/online-exam-analytics/student/:studentId ──────────
  app.get("/admin/online-exam-analytics/student/:studentId",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { studentId } = req.params as { studentId: string };

      // All evaluations for this student
      const evals = await prisma.evaluationRecord.findMany({
        where: { schoolId, studentId: parseInt(studentId) },
        orderBy: { createdAt: "asc" },
        include: {
          exam: { include: { subject: { select: { name: true } } } },
        },
      });

      // Trend across exams
      const trend = evals.map(e => ({
        examName:   e.exam.name,
        subject:    e.exam.subject?.name ?? "—",
        percentage: Number(e.percentage),
        grade:      e.grade,
        isPassed:   e.isPassed,
        date:       e.createdAt,
      }));

      // Subject performance
      const subMap: Record<string, number[]> = {};
      evals.forEach(e => {
        const sub = e.exam.subject?.name ?? "Other";
        if (!subMap[sub]) subMap[sub] = [];
        subMap[sub].push(Number(e.percentage));
      });
      const subjectPerf = Object.entries(subMap).map(([name, pcts]) => ({
        subject: name,
        avg: Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length * 10)/10,
        attempts: pcts.length,
      })).sort((a, b) => b.avg - a.avg);

      const strengths = subjectPerf.filter(s => s.avg >= 70).slice(0, 3);
      const weaknesses = subjectPerf.filter(s => s.avg < 50).slice(0, 3);

      const pcts = evals.map(e => Number(e.percentage));
      const avgPct = pcts.length ? Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length*10)/10 : 0;

      return reply.send({
        success: true,
        data: { trend, subjectPerf, strengths, weaknesses, avgPct, totalExams: evals.length },
      });
    }
  );

  // ── GET /admin/online-exam-analytics/subjects ────────────────────
  app.get("/admin/online-exam-analytics/subjects",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string };

      const where: any = { schoolId };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);

      const evals = await prisma.evaluationRecord.findMany({
        where,
        include: { exam: { include: { subject: { select: { id: true, name: true } } } } },
      });

      const subMap: Record<string, { name:string; pcts:number[]; passed:number }> = {};
      evals.forEach(e => {
        const sub = e.exam.subject?.name ?? "General";
        if (!subMap[sub]) subMap[sub] = { name: sub, pcts: [], passed: 0 };
        subMap[sub].pcts.push(Number(e.percentage));
        if (e.isPassed) subMap[sub].passed++;
      });

      const subjects = Object.entries(subMap).map(([, v]) => ({
        subject:     v.name,
        avg:         Math.round(v.pcts.reduce((a,b)=>a+b,0)/v.pcts.length*10)/10,
        max:         Math.max(...v.pcts),
        min:         Math.min(...v.pcts),
        passPercent: Math.round((v.passed / v.pcts.length)*100),
        total:       v.pcts.length,
      })).sort((a, b) => b.avg - a.avg);

      return reply.send({ success: true, data: { subjects } });
    }
  );

  // ── GET /admin/online-exam-analytics/questions ───────────────────
  app.get("/admin/online-exam-analytics/questions",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string; examId?: string };

      const where: any = { schoolId };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);
      if (q.examId)     where.examId     = parseInt(q.examId);

      const evals = await prisma.evaluationRecord.findMany({ where, select: { questionMarks: true } });

      // Aggregate per questionId
      const qMap: Record<number, { correct:number; wrong:number; skip:number; times:number[] }> = {};
      evals.forEach(e => {
        ((e.questionMarks as any[]) ?? []).forEach((qm: any) => {
          if (!qm?.questionId) return;
          if (!qMap[qm.questionId]) qMap[qm.questionId] = { correct:0, wrong:0, skip:0, times:[] };
          const isAuto = ["SINGLE_MCQ","MULTI_MCQ","TRUE_FALSE","FILL_BLANK","NUMERICAL"].includes(qm.questionType);
          if (!isAuto) return;
          if (qm.isCorrect === true)  qMap[qm.questionId].correct++;
          else if (qm.obtainedMarks < 0 || qm.isCorrect === false) qMap[qm.questionId].wrong++;
          else qMap[qm.questionId].skip++;
        });
      });

      // Fetch question texts
      const qIds = Object.keys(qMap).map(Number);
      const questions = qIds.length > 0
        ? await prisma.questionBank.findMany({
            where: { id: { in: qIds }, schoolId },
            select: { id: true, questionText: true, questionType: true, difficulty: true },
          }).catch(() => [])
        : [];
      const qtextMap: Record<number,any> = {};
      questions.forEach((q:any) => { qtextMap[q.id] = q; });

      const result = Object.entries(qMap).map(([qId, v]) => {
        const total = v.correct + v.wrong + v.skip;
        const correctPct = total > 0 ? Math.round((v.correct / total)*100) : 0;
        const skipRate   = total > 0 ? Math.round((v.skip   / total)*100) : 0;
        return {
          questionId: parseInt(qId),
          questionText: qtextMap[parseInt(qId)]?.questionText?.slice(0,80) ?? `Q#${qId}`,
          questionType: qtextMap[parseInt(qId)]?.questionType ?? "—",
          difficulty:   qtextMap[parseInt(qId)]?.difficulty   ?? "—",
          total, correct: v.correct, wrong: v.wrong, skip: v.skip,
          correctPct, skipRate,
          difficultyIndex: difficultyLabel(correctPct),
          isConfusing: correctPct > 0 && correctPct < 50 && skipRate < 20,
        };
      }).sort((a, b) => a.correctPct - b.correctPct);

      return reply.send({ success: true, data: { questions: result } });
    }
  );

  // ── GET /admin/online-exam-analytics/classes ─────────────────────
  app.get("/admin/online-exam-analytics/classes",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string; examId?: string };

      const where: any = { schoolId };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);
      if (q.examId)     where.examId     = parseInt(q.examId);

      const evals = await prisma.evaluationRecord.findMany({
        where,
        include: { student: { include: { class: { select: { id:true, name:true } } } } },
      });

      const classMap: Record<string, { name:string; pcts:number[]; passed:number }> = {};
      evals.forEach(e => {
        const cls = e.student.class?.name ?? "Unknown";
        if (!classMap[cls]) classMap[cls] = { name:cls, pcts:[], passed:0 };
        classMap[cls].pcts.push(Number(e.percentage));
        if (e.isPassed) classMap[cls].passed++;
      });

      const classes = Object.entries(classMap).map(([,v]) => ({
        className:   v.name,
        avg:         Math.round(v.pcts.reduce((a,b)=>a+b,0)/v.pcts.length*10)/10,
        passPercent: Math.round((v.passed/v.pcts.length)*100),
        total:       v.pcts.length,
        highest:     Math.max(...v.pcts),
        lowest:      Math.min(...v.pcts),
      })).sort((a, b) => b.avg - a.avg);

      return reply.send({ success: true, data: { classes } });
    }
  );

  // ── GET /admin/online-exam-analytics/teachers ────────────────────
  app.get("/admin/online-exam-analytics/teachers",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string };

      const where: any = { schoolId };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);

      const evals = await prisma.evaluationRecord.findMany({
        where,
        include: {
          evaluatedBy: { select: { name:true } },
          exam: { include: { subject: { select: { name:true } } } },
        },
      });

      const teacherMap: Record<string, { name:string; pcts:number[]; passed:number; subjects:Set<string> }> = {};
      evals.forEach(e => {
        const name = e.evaluatedBy?.name ?? "Auto";
        if (!teacherMap[name]) teacherMap[name] = { name, pcts:[], passed:0, subjects:new Set() };
        teacherMap[name].pcts.push(Number(e.percentage));
        if (e.isPassed) teacherMap[name].passed++;
        if (e.exam.subject?.name) teacherMap[name].subjects.add(e.exam.subject.name);
      });

      const teachers = Object.entries(teacherMap).map(([,v]) => ({
        teacher:     v.name,
        avgScore:    Math.round(v.pcts.reduce((a,b)=>a+b,0)/v.pcts.length*10)/10,
        passPercent: Math.round((v.passed/v.pcts.length)*100),
        total:       v.pcts.length,
        subjects:    [...v.subjects].join(", "),
      })).sort((a, b) => b.avgScore - a.avgScore);

      return reply.send({ success: true, data: { teachers } });
    }
  );

  // ── GET /admin/online-exam-analytics/comparison ──────────────────
  app.get("/admin/online-exam-analytics/comparison",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId1: string; scheduleId2: string };

      if (!q.scheduleId1 || !q.scheduleId2) {
        return reply.status(400).send({ success: false, message: "Both scheduleId1 and scheduleId2 required." });
      }

      const [e1, e2] = await Promise.all([
        prisma.evaluationRecord.findMany({
          where: { schoolId, scheduleId: parseInt(q.scheduleId1) },
          include: { schedule: { include: { exam: { select:{ name:true } } } } },
        }),
        prisma.evaluationRecord.findMany({
          where: { schoolId, scheduleId: parseInt(q.scheduleId2) },
          include: { schedule: { include: { exam: { select:{ name:true } } } } },
        }),
      ]);

      const stats = (evals: typeof e1) => {
        const pcts   = evals.map(e => Number(e.percentage));
        const passed = evals.filter(e => e.isPassed).length;
        return {
          name:        evals[0]?.schedule?.exam?.name ?? "Exam",
          total:       evals.length,
          avg:         pcts.length ? Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length*10)/10 : 0,
          highest:     pcts.length ? Math.max(...pcts) : 0,
          lowest:      pcts.length ? Math.min(...pcts) : 0,
          passPercent: pcts.length ? Math.round((passed/pcts.length)*100) : 0,
          stdDev:      stdDev(pcts),
        };
      };

      const s1 = stats(e1), s2 = stats(e2);
      const improvement = s1.avg > 0 ? Math.round(((s2.avg - s1.avg) / s1.avg)*100*10)/10 : 0;

      // Student-level comparison (common students)
      const s1Map: Record<number, number> = {};
      const s2Map: Record<number, number> = {};
      e1.forEach(e => { s1Map[e.studentId] = Number(e.percentage); });
      e2.forEach(e => { s2Map[e.studentId] = Number(e.percentage); });
      const common = Object.keys(s1Map).filter(id => s2Map[parseInt(id)]);
      const improved = common.filter(id => s2Map[parseInt(id)] > s1Map[parseInt(id)]).length;
      const declined = common.filter(id => s2Map[parseInt(id)] < s1Map[parseInt(id)]).length;

      return reply.send({
        success: true,
        data: { exam1: s1, exam2: s2, improvement, common: common.length, improved, declined },
      });
    }
  );

  // ── GET /admin/online-exam-analytics/trend ───────────────────────
  app.get("/admin/online-exam-analytics/trend",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { examIds?: string; classId?: string };

      const examIds = q.examIds ? q.examIds.split(",").map(Number) : [];
      const where: any = { schoolId };
      if (examIds.length) where.examId = { in: examIds };

      const evals = await prisma.evaluationRecord.findMany({
        where,
        include: { exam: { select: { id:true, name:true, createdAt:true } } },
        orderBy: { createdAt: "asc" },
      });

      // Group by exam
      const examMap: Record<number,{ name:string; pcts:number[]; passed:number; date:Date }> = {};
      evals.forEach(e => {
        if (!examMap[e.examId]) examMap[e.examId] = { name:e.exam.name, pcts:[], passed:0, date:e.exam.createdAt };
        examMap[e.examId].pcts.push(Number(e.percentage));
        if (e.isPassed) examMap[e.examId].passed++;
      });

      const trend = Object.entries(examMap).map(([,v]) => ({
        exam:        v.name,
        avg:         Math.round(v.pcts.reduce((a,b)=>a+b,0)/v.pcts.length*10)/10,
        passPercent: Math.round((v.passed/v.pcts.length)*100),
        date:        v.date,
      })).sort((a,b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      return reply.send({ success: true, data: { trend } });
    }
  );

  // ── GET /admin/online-exam-analytics/ai-insights ─────────────────
  app.get("/admin/online-exam-analytics/ai-insights",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string };

      const where: any = { schoolId };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);

      const evals = await prisma.evaluationRecord.findMany({
        where,
        include: {
          student: { include: { user:{ select:{name:true} }, class:{ select:{name:true} } } },
          exam: { include: { subject:{ select:{name:true} } } },
        },
      });

      if (!evals.length) return reply.send({ success:true, data:{ insights:[] } });

      const insights: { type:string; severity:"INFO"|"WARNING"|"ALERT"; message:string; count?:number }[] = [];

      const pcts    = evals.map(e => Number(e.percentage));
      const avgPct  = pcts.reduce((a,b)=>a+b,0)/pcts.length;
      const passed  = evals.filter(e => e.isPassed).length;
      const passPct = Math.round((passed/evals.length)*100);
      const atRisk  = evals.filter(e => Number(e.percentage) < 40);

      if (avgPct < 50) insights.push({ type:"LOW_AVG",    severity:"ALERT",   message:`Overall class average is low at ${avgPct.toFixed(1)}%. Revision may be required.` });
      if (passPct < 60) insights.push({ type:"HIGH_FAIL",  severity:"ALERT",   message:`${100-passPct}% students failed. Consider remedial sessions.`, count:evals.length-passed });
      if (atRisk.length > 0) insights.push({ type:"AT_RISK",   severity:"WARNING", message:`${atRisk.length} students are at risk (below 40%). Immediate intervention needed.`, count:atRisk.length });
      if (avgPct >= 75) insights.push({ type:"HIGH_PERF",  severity:"INFO",    message:`Excellent performance! Class average is ${avgPct.toFixed(1)}%.` });

      // Question-level insight from aggregated data
      const qAgg: Record<number,{correct:number;total:number;skip:number}> = {};
      evals.forEach(e => {
        ((e.questionMarks as any[])??[]).forEach((qm:any) => {
          if (!qm?.questionId) return;
          if (!qAgg[qm.questionId]) qAgg[qm.questionId] = {correct:0,total:0,skip:0};
          qAgg[qm.questionId].total++;
          if (qm.isCorrect) qAgg[qm.questionId].correct++;
          if (qm.obtainedMarks === 0 && !qm.isCorrect) qAgg[qm.questionId].skip++;
        });
      });

      const hardQs = Object.entries(qAgg).filter(([,v]) => v.total>=3 && (v.correct/v.total)<0.25);
      if (hardQs.length>0) insights.push({ type:"HARD_QUESTIONS", severity:"WARNING", message:`${hardQs.length} questions have less than 25% correct rate. Review these questions.`, count:hardQs.length });

      const skipQs = Object.entries(qAgg).filter(([,v]) => v.total>=3 && (v.skip/v.total)>0.4);
      if (skipQs.length>0) insights.push({ type:"HIGH_SKIP", severity:"INFO", message:`${skipQs.length} questions have >40% skip rate. May indicate confusion.`, count:skipQs.length });

      // Class gap detection
      const classMap: Record<string,number[]> = {};
      evals.forEach(e => {
        const cls = e.student.class?.name??"?";
        if (!classMap[cls]) classMap[cls] = [];
        classMap[cls].push(Number(e.percentage));
      });
      const classAvgs = Object.entries(classMap).map(([cls,p]) => ({ cls, avg:p.reduce((a,b)=>a+b,0)/p.length }));
      if (classAvgs.length >= 2) {
        const maxA = Math.max(...classAvgs.map(c=>c.avg));
        const minA = Math.min(...classAvgs.map(c=>c.avg));
        if (maxA - minA > 20) {
          insights.push({ type:"CLASS_GAP", severity:"WARNING", message:`Large performance gap between classes (${(maxA-minA).toFixed(1)}%). Review teaching methods.` });
        }
      }

      // Top performers
      const toppers = evals.filter(e => Number(e.percentage) >= 90);
      if (toppers.length>0) insights.push({ type:"TOPPERS", severity:"INFO", message:`${toppers.length} students scored 90%+. Consider scholarship recognition.`, count:toppers.length });

      return reply.send({ success: true, data: { insights, generatedAt: new Date() } });
    }
  );
}