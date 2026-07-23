import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

export async function adminExamAnalyticsRoutes(app: FastifyInstance) {

  // ── GET /admin/analytics/meta ─────────────────────────────
  app.get("/admin/analytics/meta",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [examConfigs, classes] = await Promise.all([
        prisma.examConfig.findMany({
          where: { schoolId, status: { in: ["ACTIVE","PUBLISHED","COMPLETED"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, name: true, sessionName: true, category: true },
        }),
        prisma.class.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          select: { id: true, name: true, classNumber: true, section: true },
        }),
      ]);
      return reply.send({ success: true, data: { examConfigs, classes } });
    }
  );

  // ── GET /admin/analytics/overview ────────────────────────
  app.get("/admin/analytics/overview",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { examConfigId: string; classId?: string };

      const where: any = { schoolId, examConfigId: parseInt(q.examConfigId) };
      if (q.classId) where.classId = parseInt(q.classId);

      const results = await prisma.studentResult.findMany({
        where, select: { percentage: true, isPassed: true, grade: true, isHeld: true, isCompartment: true, failedSubjects: true },
      });

      const total = results.length;
      const passed = results.filter(r => r.isPassed).length;
      const failed = results.filter(r => !r.isPassed && !r.isCompartment).length;
      const compartment = results.filter(r => r.isCompartment).length;
      const held = results.filter(r => r.isHeld).length;
      const pcts = results.map(r => Number(r.percentage));
      const avg = pcts.length ? Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length*10)/10 : 0;
      const highest = pcts.length ? Math.max(...pcts) : 0;
      const lowest = pcts.length ? Math.min(...pcts) : 0;
      const distinction = results.filter(r => Number(r.percentage) >= 75).length;
      const firstClass = results.filter(r => Number(r.percentage) >= 60 && Number(r.percentage) < 75).length;
      const passPercent = total > 0 ? Math.round((passed/total)*100) : 0;

      // Grade distribution
      const gradeDist: Record<string,number> = {};
      results.forEach(r => { if (r.grade) gradeDist[r.grade] = (gradeDist[r.grade]??0)+1; });

      // % buckets for histogram
      const buckets = [
        { label:"0-33%",   count: results.filter(r=>Number(r.percentage)<33).length  },
        { label:"33-50%",  count: results.filter(r=>Number(r.percentage)>=33&&Number(r.percentage)<50).length },
        { label:"50-60%",  count: results.filter(r=>Number(r.percentage)>=50&&Number(r.percentage)<60).length },
        { label:"60-75%",  count: results.filter(r=>Number(r.percentage)>=60&&Number(r.percentage)<75).length },
        { label:"75-90%",  count: results.filter(r=>Number(r.percentage)>=75&&Number(r.percentage)<90).length },
        { label:"90-100%", count: results.filter(r=>Number(r.percentage)>=90).length },
      ];

      return reply.send({
        success: true,
        data: {
          kpi: { total, passed, failed, compartment, held, avg, highest, lowest, distinction, firstClass, passPercent },
          gradeDist: Object.entries(gradeDist).sort((a,b) => a[0].localeCompare(b[0])).map(([g,c]) => ({ grade:g, count:c })),
          buckets,
          passFail: [{ name:"Passed", value:passed },{ name:"Failed", value:failed },{ name:"Compartment", value:compartment }],
        },
      });
    }
  );

  // ── GET /admin/analytics/subjects ────────────────────────
  app.get("/admin/analytics/subjects",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { examConfigId: string; classId?: string };

      const where: any = { schoolId, examConfigId: parseInt(q.examConfigId) };
      if (q.classId) where.classId = parseInt(q.classId);

      const entries = await prisma.marksEntry.findMany({
        where,
        include: { examSubject: { include: { subject: { select: { id:true, name:true } } } } },
      });

      // Group by subject
      const bySubject: Record<string, { name:string; marks:number[]; maxMarks:number; passed:number; total:number }> = {};
      entries.forEach(e => {
        const name = e.examSubject.subject.name;
        const sid = String(e.examSubject.subjectId);
        if (!bySubject[sid]) bySubject[sid] = { name, marks:[], maxMarks:Number(e.maxMarks), passed:0, total:0 };
        if (e.marksStatus === "PRESENT" && e.finalMarks !== null) {
          bySubject[sid].marks.push(Number(e.finalMarks));
          bySubject[sid].total++;
          if (e.isPassed) bySubject[sid].passed++;
        }
      });

      const subjectData = Object.values(bySubject).map(s => {
        const avg = s.marks.length ? Math.round(s.marks.reduce((a,b)=>a+b,0)/s.marks.length*10)/10 : 0;
        const highest = s.marks.length ? Math.max(...s.marks) : 0;
        const lowest  = s.marks.length ? Math.min(...s.marks) : 0;
        const passPercent = s.total > 0 ? Math.round((s.passed/s.total)*100) : 0;
        const avgPct = s.maxMarks > 0 ? Math.round((avg/s.maxMarks)*100) : 0;
        return { name:s.name, avg, highest, lowest, maxMarks:s.maxMarks, passPercent, total:s.total, avgPct };
      });

      subjectData.sort((a,b) => b.avg-a.avg);
      return reply.send({ success:true, data:{ subjects: subjectData } });
    }
  );

  // ── GET /admin/analytics/classes ─────────────────────────
  app.get("/admin/analytics/classes",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { examConfigId } = req.query as { examConfigId: string };

      const results = await prisma.studentResult.findMany({
        where: { schoolId, examConfigId: parseInt(examConfigId) },
        include: { class: { select: { id:true, name:true } } },
      });

      const byClass: Record<number, { name:string; pcts:number[]; passed:number; total:number }> = {};
      results.forEach(r => {
        if (!byClass[r.classId]) byClass[r.classId] = { name:r.class.name, pcts:[], passed:0, total:0 };
        byClass[r.classId].pcts.push(Number(r.percentage));
        byClass[r.classId].total++;
        if (r.isPassed) byClass[r.classId].passed++;
      });

      // Topper per class
      const classData = await Promise.all(Object.entries(byClass).map(async ([classId, data]) => {
        const avg = data.pcts.length ? Math.round(data.pcts.reduce((a,b)=>a+b,0)/data.pcts.length*10)/10 : 0;
        const passPercent = data.total > 0 ? Math.round((data.passed/data.total)*100) : 0;
        const topper = await prisma.studentResult.findFirst({
          where: { schoolId, examConfigId: parseInt(examConfigId), classId: parseInt(classId), isPassed: true },
          orderBy: { percentage: "desc" },
          include: { student: { include: { user: { select:{ name:true } } } } },
        });
        return { classId: parseInt(classId), name:data.name, avg, passPercent, total:data.total, passed:data.passed, topperName:topper?.student.user.name??"-", topperPct:Number(topper?.percentage??0) };
      }));

      classData.sort((a,b) => b.avg-a.avg);
      return reply.send({ success:true, data:{ classes: classData } });
    }
  );

  // ── GET /admin/analytics/toppers ─────────────────────────
  app.get("/admin/analytics/toppers",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { examConfigId: string; classId?: string; limit?: string };

      const where: any = { schoolId, examConfigId: parseInt(q.examConfigId), isPassed: true };
      if (q.classId) where.classId = parseInt(q.classId);

      const toppers = await prisma.studentResult.findMany({
        where, orderBy: { percentage: "desc" }, take: parseInt(q.limit??"20"),
        include: {
          student: { include: { user: { select:{ name:true, avatarUrl:true } } } },
          class: { select: { name:true } },
        },
      });

      const weakStudents = await prisma.studentResult.findMany({
        where: { ...where, isPassed: false, percentage: { lt: 40 } },
        orderBy: { percentage: "asc" }, take: 10,
        include: {
          student: { include: { user: { select:{ name:true } } } },
          class: { select: { name:true } },
        },
      });

      const improving = await prisma.studentResult.findMany({
        where, orderBy: { percentage: "desc" }, take: 5,
        include: { student: { include: { user: { select:{ name:true } } } }, class: { select:{ name:true } } },
      });

      return reply.send({ success:true, data:{ toppers, weakStudents, improving } });
    }
  );

  // ── GET /admin/analytics/attendance-correlation ───────────
  app.get("/admin/analytics/attendance-correlation",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { examConfigId: string; classId?: string };

      const where: any = { schoolId, examConfigId: parseInt(q.examConfigId) };
      if (q.classId) where.classId = parseInt(q.classId);

      const results = await prisma.studentResult.findMany({
        where,
        select: { percentage:true, attendancePct:true, isPassed:true },
      });

      const withAtt = results.filter(r => r.attendancePct !== null);

      // Bucket by attendance range
      const buckets = [
        { att:"<50%",  data: withAtt.filter(r=>Number(r.attendancePct)<50) },
        { att:"50-60%",data: withAtt.filter(r=>Number(r.attendancePct)>=50&&Number(r.attendancePct)<60) },
        { att:"60-75%",data: withAtt.filter(r=>Number(r.attendancePct)>=60&&Number(r.attendancePct)<75) },
        { att:"75-85%",data: withAtt.filter(r=>Number(r.attendancePct)>=75&&Number(r.attendancePct)<85) },
        { att:"85-95%",data: withAtt.filter(r=>Number(r.attendancePct)>=85&&Number(r.attendancePct)<95) },
        { att:"95%+",  data: withAtt.filter(r=>Number(r.attendancePct)>=95) },
      ].map(b => ({
        att: b.att,
        count: b.data.length,
        avgMarks: b.data.length ? Math.round(b.data.reduce((s,r)=>s+Number(r.percentage),0)/b.data.length*10)/10 : 0,
        passPercent: b.data.length ? Math.round(b.data.filter(r=>r.isPassed).length/b.data.length*100) : 0,
      }));

      // Scatter data (sample 50)
      const scatter = withAtt.slice(0, 50).map(r => ({ x: Number(r.attendancePct), y: Number(r.percentage) }));

      return reply.send({ success:true, data:{ buckets, scatter, totalWithAtt: withAtt.length } });
    }
  );

  // ── GET /admin/analytics/trends ──────────────────────────
  app.get("/admin/analytics/trends",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { classId?: string; sessionFilter?: string };

      const examConfigs = await prisma.examConfig.findMany({
        where: { schoolId, status: { in: ["ACTIVE","PUBLISHED","COMPLETED"] } },
        orderBy: { createdAt: "asc" },
        select: { id:true, name:true, sessionName:true, category:true },
      });

      const trendData = await Promise.all(examConfigs.map(async ec => {
        const where: any = { schoolId, examConfigId: ec.id };
        if (q.classId) where.classId = parseInt(q.classId);

        const agg = await prisma.studentResult.aggregate({
          where, _avg: { percentage:true }, _count: true,
        });
        const passed = await prisma.studentResult.count({ where: { ...where, isPassed:true } });
        const avg = Math.round(Number(agg._avg.percentage??0)*10)/10;
        const passPercent = agg._count > 0 ? Math.round((passed/agg._count)*100) : 0;
        return { exam:ec.name, session:ec.sessionName, category:ec.category, avg, passPercent, total:agg._count };
      }));

      return reply.send({ success:true, data:{ trends: trendData.filter(t=>t.total>0) } });
    }
  );

  // ── GET /admin/analytics/teachers ────────────────────────
  app.get("/admin/analytics/teachers",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { examConfigId } = req.query as { examConfigId: string };

      const staffList = await prisma.staff.findMany({
        where: { schoolId, isActive: true },
        include: { user: { select: { id:true, name:true } } },
      });

      // Marks entered by each staff (as teacher)
      const teacherData = await Promise.all(staffList.slice(0,15).map(async staff => {
        const entered = await prisma.marksEntry.count({
          where: { schoolId, examConfigId: parseInt(examConfigId), enteredById: staff.userId },
        });
        const avg = await prisma.marksEntry.aggregate({
          where: { schoolId, examConfigId: parseInt(examConfigId), enteredById: staff.userId, marksStatus:"PRESENT" },
          _avg: { obtainedMarks:true },
        });
        const passed = await prisma.marksEntry.count({
          where: { schoolId, examConfigId: parseInt(examConfigId), enteredById: staff.userId, isPassed:true },
        });
        return { name:staff.user.name, entered, avgMarks: Math.round(Number(avg._avg.obtainedMarks??0)*10)/10, passed };
      }));

      return reply.send({ success:true, data:{ teachers: teacherData.filter(t=>t.entered>0) } });
    }
  );

  // ── GET /admin/analytics/behaviour-insights ───────────────
  app.get("/admin/analytics/behaviour-insights",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { examConfigId: string; classId?: string };

      const where: any = { schoolId, examConfigId: parseInt(q.examConfigId) };
      if (q.classId) where.classId = parseInt(q.classId);

      const results = await prisma.studentResult.findMany({
        where, select: { studentId:true, percentage:true, isPassed:true },
      });
      const studentIds = results.map(r => r.studentId);

      const behaviourAgg = await prisma.behaviourRecord.groupBy({
        by: ["studentId","behaviourType"],
        where: { schoolId, studentId: { in: studentIds } },
        _count: true, _sum: { points:true },
      });

      // Map: studentId → { positive points, negative points }
      const bMap: Record<number,{pos:number,neg:number}> = {};
      behaviourAgg.forEach(b => {
        if (!bMap[b.studentId]) bMap[b.studentId] = { pos:0, neg:0 };
        if (b.behaviourType === "POSITIVE") bMap[b.studentId].pos += Number(b._sum.points??0);
        else bMap[b.studentId].neg += Math.abs(Number(b._sum.points??0));
      });

      // Correlate
      const withBehaviour = results
        .filter(r => bMap[r.studentId])
        .map(r => ({
          studentId: r.studentId,
          percentage: Number(r.percentage),
          isPassed: r.isPassed,
          posPoints: bMap[r.studentId].pos,
          negPoints: bMap[r.studentId].neg,
          netPoints: bMap[r.studentId].pos - bMap[r.studentId].neg,
        }));

      const highBehaviour    = withBehaviour.filter(r => r.netPoints >= 20);
      const lowBehaviour     = withBehaviour.filter(r => r.netPoints < -10);
      const highBehavAvg     = highBehaviour.length ? Math.round(highBehaviour.reduce((s,r)=>s+r.percentage,0)/highBehaviour.length*10)/10 : 0;
      const lowBehavAvg      = lowBehaviour.length  ? Math.round(lowBehaviour.reduce((s,r)=>s+r.percentage,0)/lowBehaviour.length*10)/10 : 0;

      return reply.send({
        success:true,
        data:{
          summary: { highBehavCount:highBehaviour.length, lowBehavCount:lowBehaviour.length, highBehavAvg, lowBehavAvg },
          withBehaviour: withBehaviour.slice(0, 30),
        },
      });
    }
  );

  // ── GET /admin/analytics/smart-alerts ────────────────────
  app.get("/admin/analytics/smart-alerts",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { examConfigId } = req.query as { examConfigId: string };

      const alerts: { type:string; severity:"HIGH"|"MEDIUM"|"LOW"; message:string; count:number }[] = [];

      const [failed, lowAtt, compartment, held] = await Promise.all([
        prisma.studentResult.count({ where: { schoolId, examConfigId: parseInt(examConfigId), isPassed:false } }),
        prisma.studentResult.count({ where: { schoolId, examConfigId: parseInt(examConfigId), attendancePct:{ lt:75 } } }),
        prisma.studentResult.count({ where: { schoolId, examConfigId: parseInt(examConfigId), isCompartment:true } }),
        prisma.studentResult.count({ where: { schoolId, examConfigId: parseInt(examConfigId), isHeld:true } }),
      ]);

      if (failed > 0)      alerts.push({ type:"FAILURE_ALERT",    severity:"HIGH",   message:`${failed} students failed this examination`,           count:failed });
      if (compartment > 0) alerts.push({ type:"COMPARTMENT",      severity:"HIGH",   message:`${compartment} students in compartment`,               count:compartment });
      if (lowAtt > 0)      alerts.push({ type:"LOW_ATTENDANCE",   severity:"MEDIUM", message:`${lowAtt} students had attendance below 75%`,          count:lowAtt });
      if (held > 0)        alerts.push({ type:"RESULT_HELD",      severity:"MEDIUM", message:`${held} results currently on hold`,                    count:held });

      // Subject with lowest pass %
      const subjectStats = await prisma.marksEntry.groupBy({
        by: ["examSubjectId"],
        where: { schoolId, examConfigId: parseInt(examConfigId), marksStatus:"PRESENT" },
        _count: true,
      });
      const passedBySubject = await prisma.marksEntry.groupBy({
        by: ["examSubjectId"],
        where: { schoolId, examConfigId: parseInt(examConfigId), marksStatus:"PRESENT", isPassed:true },
        _count: true,
      });
      const passMap: Record<number,number> = {};
      passedBySubject.forEach(p => { passMap[p.examSubjectId] = p._count; });
      let worstSubjectId: number|null = null; let worstPct = 101;
      subjectStats.forEach(s => {
        const pct = s._count > 0 ? Math.round((passMap[s.examSubjectId]??0)/s._count*100) : 0;
        if (pct < worstPct) { worstPct = pct; worstSubjectId = s.examSubjectId; }
      });
      if (worstSubjectId && worstPct < 60) {
        const sub = await prisma.examSubject.findFirst({ where:{ id:worstSubjectId }, include:{ subject:{ select:{ name:true } } } });
        if (sub) alerts.push({ type:"WEAK_SUBJECT", severity:"MEDIUM", message:`${sub.subject.name} has only ${worstPct}% pass rate — needs attention`, count:worstPct });
      }

      return reply.send({ success:true, data:{ alerts } });
    }
  );
}