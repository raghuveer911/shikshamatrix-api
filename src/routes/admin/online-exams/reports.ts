import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

const DEFAULT_TEMPLATES = [
  { name:"Student Report Card",    reportType:"STUDENT_INDIVIDUAL", description:"Individual student performance with marks, grade and feedback",       config:{ fields:["name","marks","grade","rank","subject_breakdown"], charts:["score_trend"] } },
  { name:"Class Performance",      reportType:"CLASS_PERFORMANCE",  description:"Class-wise average, pass%, topper list and weak students",             config:{ fields:["class","avg","passPercent","toppers","weakStudents"], charts:["grade_dist","pass_fail"] } },
  { name:"Exam Summary",           reportType:"EXAM_SUMMARY",       description:"Full exam analysis with rank list, grade distribution and statistics",  config:{ fields:["exam","total","passed","failed","avg","highest","lowest"], charts:["grade_dist","score_buckets"] } },
  { name:"Topper List",            reportType:"EXAM_SUMMARY",       description:"Top 10 students by score for an exam",                                 config:{ fields:["rank","name","score","grade"], charts:[] } },
  { name:"Teacher Summary",        reportType:"TEACHER_PERFORMANCE",description:"Teacher-wise student averages and evaluation status",                   config:{ fields:["teacher","avgScore","passPercent","pending"], charts:["comparison"] } },
  { name:"Subject Analysis",       reportType:"SUBJECT_SUMMARY",    description:"Subject-wise performance with chapter breakdown",                      config:{ fields:["subject","avg","passPercent","topQuestion"], charts:["subject_bar"] } },
];

export async function adminReportsRoutes(app: FastifyInstance) {

  // ── GET /admin/reports/meta ───────────────────────────────
  app.get("/admin/reports/meta",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [stats, recent, templates, exams, classes, subjects, students] = await Promise.all([
        (async () => {
          const [generated, scheduled, shared, downloaded, activeTemplates, pending] = await Promise.all([
            prisma.savedReport.count({ where: { schoolId } }),
            prisma.scheduledReport.count({ where: { schoolId, isActive:true } }),
            prisma.savedReport.count({ where: { schoolId, isShared:true } }),
            prisma.savedReport.aggregate({ where:{ schoolId }, _sum:{ downloadCount:true } }),
            prisma.reportTemplate.count({ where: { schoolId } }),
            prisma.scheduledReport.count({ where: { schoolId, isActive:true, nextRunAt:{ lte:new Date() } } }),
          ]);
          return { generated, scheduled, shared, downloaded: downloaded._sum.downloadCount ?? 0, activeTemplates, pending };
        })(),
        prisma.savedReport.findMany({ where:{ schoolId }, orderBy:{ createdAt:"desc" }, take:6, include:{ createdBy:{ select:{ name:true } } } }),
        prisma.reportTemplate.findMany({ where:{ schoolId }, orderBy:{ useCount:"desc" } }),
        prisma.onlineExam.findMany({ where:{ schoolId, status:{ in:["COMPLETED","PUBLISHED","LIVE"] } }, orderBy:{ createdAt:"desc" }, select:{ id:true, name:true, examCode:true }, take:20 }),
        prisma.class.findMany({ where:{ schoolId, isActive:true }, orderBy:[{ classNumber:"asc" },{ section:"asc" }], select:{ id:true, name:true } }),
        prisma.subject.findMany({ where:{ schoolId, isActive:true }, orderBy:{ name:"asc" }, select:{ id:true, name:true } }),
        prisma.student.count({ where:{ schoolId, isActive:true } }),
      ]);

      // Seed default templates if none exist
      if (templates.length === 0) {
        for (const t of DEFAULT_TEMPLATES) {
          await prisma.reportTemplate.upsert({
            where: { id: -1 },    // dummy, create always
            create: { schoolId, createdById: (req.user as any).userId, isDefault:true, ...t as any },
            update: {},
          }).catch(() => null);
        }
      }

      return reply.send({ success:true, data:{ stats, recent, templates, exams, classes, subjects, totalStudents: students } });
    }
  );

  // ── GET /admin/reports/student ────────────────────────────
  app.get("/admin/reports/student",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { studentId?: string; scheduleId?: string; examId?: string; classId?: string };

      const where: any = { schoolId };
      if (q.studentId)  where.studentId  = parseInt(q.studentId);
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);
      if (q.examId)     where.examId     = parseInt(q.examId);

      const evals = await prisma.evaluationRecord.findMany({
        where,
        include: {
          student: { include: { user: { select:{ name:true } }, class:{ select:{ name:true } } } },
          exam:    { include: { subject:{ select:{ name:true } } } },
          evaluatedBy: { select:{ name:true } },
        },
        orderBy: { createdAt:"asc" },
      });

      // Group by student
      const studentMap: Record<number, any> = {};
      evals.forEach(e => {
        if (!studentMap[e.studentId]) {
          studentMap[e.studentId] = {
            studentId: e.studentId, name: e.student.user.name,
            class: e.student.class?.name ?? "—", exams: [],
          };
        }
        studentMap[e.studentId].exams.push({
          examId: e.examId, examName: e.exam.name, subject: e.exam.subject?.name ?? "—",
          totalMarks: Number(e.totalMarks), obtainedMarks: Number(e.obtainedMarks),
          percentage: Number(e.percentage), grade: e.grade, isPassed: e.isPassed,
          rank: e.rank, correctAnswers: e.correctAnswers, wrongAnswers: e.wrongAnswers,
          teacherFeedback: e.teacherFeedback, timeTakenSecs: e.timeTakenSecs,
        });
      });

      // Per-student summary
      const students = Object.values(studentMap).map((s: any) => {
        const pcts = s.exams.map((e:any) => e.percentage);
        const avg  = pcts.length ? Math.round(pcts.reduce((a:number,b:number)=>a+b,0)/pcts.length*10)/10 : 0;
        const subPerf: Record<string,number[]> = {};
        s.exams.forEach((e:any) => {
          if (!subPerf[e.subject]) subPerf[e.subject] = [];
          subPerf[e.subject].push(e.percentage);
        });
        const subjectSummary = Object.entries(subPerf).map(([sub,ps]) => ({
          subject: sub, avg: Math.round((ps as number[]).reduce((a,b)=>a+b,0)/(ps as number[]).length*10)/10,
        }));
        const strengths  = subjectSummary.filter(s=>s.avg>=70).slice(0,3).map(s=>s.subject);
        const weaknesses = subjectSummary.filter(s=>s.avg<50).slice(0,3).map(s=>s.subject);
        return { ...s, avg, subjectSummary, strengths, weaknesses };
      });

      return reply.send({ success:true, data:{ students } });
    }
  );

  // ── GET /admin/reports/exam ───────────────────────────────
  app.get("/admin/reports/exam",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string; examId?: string; classId?: string };

      const where: any = { schoolId };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);
      if (q.examId)     where.examId     = parseInt(q.examId);

      const [evals, examInfo] = await Promise.all([
        prisma.evaluationRecord.findMany({
          where, orderBy:{ percentage:"desc" },
          include: { student:{ include:{ user:{ select:{ name:true } }, class:{ select:{ name:true } } } } },
        }),
        q.examId ? prisma.onlineExam.findFirst({ where:{ id:parseInt(q.examId!), schoolId }, include:{ subject:{ select:{ name:true } } } }) : null,
      ]);

      if (!evals.length) return reply.send({ success:true, data:{ empty:true } });

      const pcts    = evals.map(e => Number(e.percentage));
      const passed  = evals.filter(e => e.isPassed).length;
      const sorted  = [...pcts].sort((a,b)=>a-b);
      const med     = sorted.length%2 ? sorted[Math.floor(sorted.length/2)] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;

      // Grade distribution
      const gradeDist: Record<string,number> = {};
      evals.forEach(e => { if(e.grade) gradeDist[e.grade]=(gradeDist[e.grade]??0)+1; });

      // Score buckets
      const buckets=[{r:"0-20",c:0},{r:"21-40",c:0},{r:"41-60",c:0},{r:"61-80",c:0},{r:"81-100",c:0}];
      pcts.forEach(p=>{ if(p<=20)buckets[0].c++;else if(p<=40)buckets[1].c++;else if(p<=60)buckets[2].c++;else if(p<=80)buckets[3].c++;else buckets[4].c++; });

      // Rank list (top 20)
      const rankList = evals.slice(0,20).map((e,i)=>({
        rank:i+1, name:e.student.user.name, class:e.student.class?.name??"—",
        score:Number(e.obtainedMarks), totalMarks:Number(e.totalMarks), percentage:Number(e.percentage), grade:e.grade,
      }));

      const stdDev = (() => {
        const mean=pcts.reduce((a,b)=>a+b,0)/pcts.length;
        return Math.round(Math.sqrt(pcts.reduce((s,v)=>s+(v-mean)**2,0)/pcts.length)*10)/10;
      })();

      return reply.send({
        success:true,
        data:{
          exam: examInfo ? { name:examInfo.name, subject:examInfo.subject?.name, category:examInfo.category, examCode:examInfo.examCode } : null,
          stats:{ total:evals.length, passed, failed:evals.length-passed, passPercent:Math.round((passed/evals.length)*100),
                  avg:Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length*10)/10, highest:Math.max(...pcts), lowest:Math.min(...pcts), median:Math.round(med*10)/10, stdDev },
          gradeDist: Object.entries(gradeDist).map(([g,c])=>({grade:g,count:c})).sort((a,b)=>b.count-a.count),
          buckets, rankList,
        },
      });
    }
  );

  // ── GET /admin/reports/class ──────────────────────────────
  app.get("/admin/reports/class",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string; examId?: string; classId?: string };

      const where: any = { schoolId };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);
      if (q.examId)     where.examId     = parseInt(q.examId);

      const evals = await prisma.evaluationRecord.findMany({
        where,
        include: { student:{ include:{ user:{ select:{ name:true } }, class:{ select:{ id:true, name:true } } } } },
        orderBy: { percentage:"desc" },
      });

      const classMap: Record<string,{ name:string; pcts:number[]; passed:number; students:any[] }> = {};
      evals.forEach(e => {
        const cls = e.student.class?.name ?? "Unknown";
        if (!classMap[cls]) classMap[cls] = { name:cls, pcts:[], passed:0, students:[] };
        classMap[cls].pcts.push(Number(e.percentage));
        if (e.isPassed) classMap[cls].passed++;
        classMap[cls].students.push({ name:e.student.user.name, pct:Number(e.percentage), grade:e.grade, isPassed:e.isPassed });
      });

      const classes = Object.entries(classMap).map(([,v]) => {
        const pcts = v.pcts;
        const avg  = Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length*10)/10;
        const toppers = [...v.students].sort((a,b)=>b.pct-a.pct).slice(0,5);
        const weak    = [...v.students].sort((a,b)=>a.pct-b.pct).filter(s=>s.pct<40).slice(0,5);
        return {
          className: v.name, total: pcts.length, avg,
          passPercent: Math.round((v.passed/pcts.length)*100),
          highest: Math.max(...pcts), lowest: Math.min(...pcts),
          toppers, weak,
        };
      }).sort((a,b)=>b.avg-a.avg);

      return reply.send({ success:true, data:{ classes } });
    }
  );

  // ── GET /admin/reports/subject ────────────────────────────
  app.get("/admin/reports/subject",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string; examId?: string; subjectId?: string };

      const where: any = { schoolId };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);
      if (q.examId)     where.examId     = parseInt(q.examId);

      const evals = await prisma.evaluationRecord.findMany({
        where,
        include: {
          student: { include:{ user:{ select:{ name:true } } } },
          exam:    { include:{ subject:{ select:{ id:true, name:true } } } },
        },
        orderBy: { percentage:"desc" },
      });

      const subMap: Record<string,{ name:string; pcts:number[]; passed:number; students:any[] }> = {};
      evals.forEach(e => {
        const sub = e.exam.subject?.name ?? "General";
        if (!subMap[sub]) subMap[sub] = { name:sub, pcts:[], passed:0, students:[] };
        subMap[sub].pcts.push(Number(e.percentage));
        if (e.isPassed) subMap[sub].passed++;
        subMap[sub].students.push({ name:e.student.user.name, pct:Number(e.percentage), grade:e.grade });
      });

      const subjects = Object.entries(subMap).map(([,v]) => ({
        subject: v.name, total: v.pcts.length,
        avg: Math.round(v.pcts.reduce((a,b)=>a+b,0)/v.pcts.length*10)/10,
        passPercent: Math.round((v.passed/v.pcts.length)*100),
        highest: Math.max(...v.pcts), lowest: Math.min(...v.pcts),
        topStudents: [...v.students].sort((a,b)=>b.pct-a.pct).slice(0,5),
      })).sort((a,b)=>b.avg-a.avg);

      return reply.send({ success:true, data:{ subjects } });
    }
  );

  // ── GET /admin/reports/teacher ────────────────────────────
  app.get("/admin/reports/teacher",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string };

      const where: any = { schoolId };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);

      const evals = await prisma.evaluationRecord.findMany({
        where,
        include: {
          evaluatedBy: { select:{ name:true } },
          exam:        { include:{ subject:{ select:{ name:true } } } },
        },
      });

      const teacherMap: Record<string,{ name:string; pcts:number[]; passed:number; subjects:Set<string>; pendingEvals:number }> = {};
      evals.forEach(e => {
        const t = e.evaluatedBy?.name ?? "Not Evaluated";
        if (!teacherMap[t]) teacherMap[t] = { name:t, pcts:[], passed:0, subjects:new Set(), pendingEvals:0 };
        teacherMap[t].pcts.push(Number(e.percentage));
        if (e.isPassed) teacherMap[t].passed++;
        if (e.exam.subject?.name) teacherMap[t].subjects.add(e.exam.subject.name);
        if (e.status === "PENDING" || e.status === "IN_REVIEW") teacherMap[t].pendingEvals++;
      });

      const teachers = Object.entries(teacherMap).map(([,v]) => ({
        teacher: v.name, total: v.pcts.length, subjects: [...v.subjects].join(", "),
        avgScore:    Math.round(v.pcts.reduce((a,b)=>a+b,0)/v.pcts.length*10)/10,
        passPercent: Math.round((v.passed/v.pcts.length)*100),
        pendingEvals: v.pendingEvals,
      })).sort((a,b)=>b.avgScore-a.avgScore);

      return reply.send({ success:true, data:{ teachers } });
    }
  );

  // ── GET /admin/reports/security ───────────────────────────
  app.get("/admin/reports/security",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string };

      const where: any = { schoolId };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);

      const [incidents, suspicious, tabEvents, multiLogin, blocked] = await Promise.all([
        prisma.examIncident.findMany({ where:{ schoolId, ...(q.scheduleId?{ scheduleId:parseInt(q.scheduleId) }:{}) }, include:{ student:{ include:{ user:{ select:{ name:true } } } }, schedule:{ include:{ exam:{ select:{ name:true } } } } }, orderBy:{ occurredAt:"desc" }, take:30 }),
        prisma.examCandidateState.count({ where:{ schoolId, suspicionScore:{ gte:50 } } }),
        prisma.examActivityEvent.count({ where:{ schoolId, eventType:"TAB_SWITCH" } }),
        prisma.examActivityEvent.count({ where:{ schoolId, eventType:"MULTIPLE_LOGIN" } }),
        prisma.examCandidateState.count({ where:{ schoolId, isBlocked:true } }),
      ]);

      const catDist: Record<string,number> = {};
      incidents.forEach(i=>{ catDist[i.incidentType]=(catDist[i.incidentType]??0)+1; });

      return reply.send({
        success:true,
        data:{ incidents, stats:{ totalIncidents:incidents.length, suspicious, tabEvents, multiLogin, blocked }, catDist },
      });
    }
  );

  // ── GET /admin/reports/comparison ────────────────────────
  app.get("/admin/reports/comparison",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId1?: string; scheduleId2?: string; examId1?: string; examId2?: string };

      const makeWhere=(sch?: string, ex?: string)=>{
        const w: any = { schoolId };
        if (sch) w.scheduleId = parseInt(sch);
        if (ex)  w.examId     = parseInt(ex);
        return w;
      };

      const [e1, e2] = await Promise.all([
        prisma.evaluationRecord.findMany({ where:makeWhere(q.scheduleId1, q.examId1), include:{ exam:{ select:{ name:true } } } }),
        prisma.evaluationRecord.findMany({ where:makeWhere(q.scheduleId2, q.examId2), include:{ exam:{ select:{ name:true } } } }),
      ]);

      const summarize=(evals:typeof e1)=>{
        if (!evals.length) return null;
        const pcts = evals.map(e=>Number(e.percentage));
        const passed = evals.filter(e=>e.isPassed).length;
        const gradeDist: Record<string,number>={};
        evals.forEach(e=>{ if(e.grade) gradeDist[e.grade]=(gradeDist[e.grade]??0)+1; });
        return {
          examName:    evals[0].exam.name,
          total:       evals.length,
          avg:         Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length*10)/10,
          passPercent: Math.round((passed/pcts.length)*100),
          highest:     Math.max(...pcts), lowest:Math.min(...pcts), passed, gradeDist,
        };
      };

      const s1=summarize(e1), s2=summarize(e2);
      const improvement=s1&&s2&&s1.avg>0 ? Math.round(((s2.avg-s1.avg)/s1.avg)*100*10)/10 : 0;

      const s1Map: Record<number,number>={};
      const s2Map: Record<number,number>={};
      e1.forEach(e=>{s1Map[e.studentId]=Number(e.percentage);});
      e2.forEach(e=>{s2Map[e.studentId]=Number(e.percentage);});
      const common=Object.keys(s1Map).filter(id=>s2Map[parseInt(id)]);
      const improved=common.filter(id=>s2Map[parseInt(id)]>s1Map[parseInt(id)]).length;
      const declined=common.filter(id=>s2Map[parseInt(id)]<s1Map[parseInt(id)]).length;

      return reply.send({ success:true, data:{ exam1:s1, exam2:s2, improvement, common:common.length, improved, declined } });
    }
  );

  // ── GET /admin/reports/saved ──────────────────────────────
  app.get("/admin/reports/saved",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { type?: string; page?: string };
      const page=Math.max(1,parseInt(q.page??"1"));
      const where:any={ schoolId };
      if(q.type) where.reportType=q.type;
      const [reports,total]=await Promise.all([
        prisma.savedReport.findMany({ where, skip:(page-1)*15, take:15, orderBy:{ createdAt:"desc" }, include:{ createdBy:{ select:{ name:true } } } }),
        prisma.savedReport.count({ where }),
      ]);
      return reply.send({ success:true, data:{ reports, total, totalPages:Math.ceil(total/15) } });
    }
  );

  // ── POST /admin/reports/save ──────────────────────────────
  app.post("/admin/reports/save",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { title:string; reportType:string; format?:string; filters?:any };
      const report = await prisma.savedReport.create({
        data: { schoolId, createdById:userId, title:body.title, reportType:body.reportType as any, format:body.format as any??"PDF", filters:body.filters??null, status:"READY" },
      });
      return reply.status(201).send({ success:true, data:{ reportId:report.id } });
    }
  );

  // ── PATCH /admin/reports/saved/:id/download ───────────────
  app.patch("/admin/reports/saved/:id/download",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id:string };
      await prisma.savedReport.updateMany({ where:{ id:parseInt(id), schoolId }, data:{ downloadCount:{ increment:1 }, lastDownloadAt:new Date() } });
      return reply.send({ success:true });
    }
  );

  // ── DELETE /admin/reports/saved/:id ──────────────────────
  app.delete("/admin/reports/saved/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id:string };
      await prisma.savedReport.deleteMany({ where:{ id:parseInt(id), schoolId } });
      return reply.send({ success:true });
    }
  );

  // ── GET /admin/reports/scheduled ─────────────────────────
  app.get("/admin/reports/scheduled",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const reports = await prisma.scheduledReport.findMany({ where:{ schoolId }, orderBy:{ createdAt:"desc" }, include:{ createdBy:{ select:{ name:true } } } });
      return reply.send({ success:true, data:{ reports } });
    }
  );

  // ── POST /admin/reports/scheduled ────────────────────────
  app.post("/admin/reports/scheduled",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { title:string; reportType:string; format?:string; frequency:string; filters?:any; recipients:string[] };
      // Compute nextRunAt based on frequency
      const next=new Date();
      if(body.frequency==="DAILY") next.setDate(next.getDate()+1);
      else if(body.frequency==="WEEKLY") next.setDate(next.getDate()+7);
      else if(body.frequency==="MONTHLY") next.setMonth(next.getMonth()+1);
      else next.setMonth(next.getMonth()+3);
      const r=await prisma.scheduledReport.create({ data:{ schoolId, createdById:userId, title:body.title, reportType:body.reportType as any, format:body.format as any??"PDF", frequency:body.frequency as any, filters:body.filters??null, recipients:body.recipients??[], nextRunAt:next } });
      return reply.status(201).send({ success:true, data:{ id:r.id } });
    }
  );

  // ── DELETE /admin/reports/scheduled/:id ──────────────────
  app.delete("/admin/reports/scheduled/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id:string };
      await prisma.scheduledReport.deleteMany({ where:{ id:parseInt(id), schoolId } });
      return reply.send({ success:true });
    }
  );

  // ── GET /admin/reports/templates ─────────────────────────
  app.get("/admin/reports/templates",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const templates = await prisma.reportTemplate.findMany({ where:{ schoolId }, orderBy:{ useCount:"desc" }, include:{ createdBy:{ select:{ name:true } } } });
      return reply.send({ success:true, data:{ templates } });
    }
  );

  // ── POST /admin/reports/templates ────────────────────────
  app.post("/admin/reports/templates",
    { preHandler: [authenticate, requireCapability('onlineExams.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { name:string; description?:string; reportType:string; config:any };
      const t=await prisma.reportTemplate.create({ data:{ schoolId, createdById:userId, name:body.name, description:body.description??null, reportType:body.reportType as any, config:body.config } });
      return reply.status(201).send({ success:true, data:{ id:t.id } });
    }
  );
}
