import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminFOReportsRoutes(app: FastifyInstance) {

  // ── GET /admin/fo-reports/overview ───────────────────────
  app.get("/admin/fo-reports/overview",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string };
      const dateWhere: any = {};
      if (q.from) dateWhere.gte = new Date(q.from);
      if (q.to)   dateWhere.lte = new Date(q.to);
      const hasDate = q.from || q.to;

      const [
        totalEnquiries, converted, visitors, totalComplaints,
        messagesSent, resolvedComplaints, openComplaints,
        todayEnquiries, todayVisitors,
      ] = await Promise.all([
        prisma.enquiry.count({ where: { schoolId, ...(hasDate ? { createdAt: dateWhere } : {}) } }),
        prisma.enquiry.count({ where: { schoolId, status: "ADMISSION_CONFIRMED", ...(hasDate ? { createdAt: dateWhere } : {}) } }),
        prisma.visitor.count({ where: { schoolId, ...(hasDate ? { createdAt: dateWhere } : {}) } }),
        prisma.complaint.count({ where: { schoolId, ...(hasDate ? { createdAt: dateWhere } : {}) } }),
        prisma.communicationMessage.count({ where: { schoolId, status: { in: ["SENT","PARTIALLY_SENT"] }, ...(hasDate ? { createdAt: dateWhere } : {}) } }),
        prisma.complaint.count({ where: { schoolId, status: { in: ["RESOLVED","CLOSED"] }, ...(hasDate ? { createdAt: dateWhere } : {}) } }),
        prisma.complaint.count({ where: { schoolId, status: { notIn: ["RESOLVED","CLOSED"] } } }),
        prisma.enquiry.count({ where: { schoolId, createdAt: { gte: new Date(new Date().setHours(0,0,0,0)) } } }),
        prisma.visitor.count({ where: { schoolId, createdAt: { gte: new Date(new Date().setHours(0,0,0,0)) } } }),
      ]);

      const resolutionRate = totalComplaints > 0 ? Math.round((resolvedComplaints / totalComplaints) * 100) : 100;
      const conversionRate = totalEnquiries > 0 ? Math.round((converted / totalEnquiries) * 100) : 0;

      // 7-day trend
      const trend: any[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
        const d2 = new Date(d); d2.setHours(23,59,59,999);
        const [enq, vis, comp, msg] = await Promise.all([
          prisma.enquiry.count({ where: { schoolId, createdAt: { gte:d, lte:d2 } } }),
          prisma.visitor.count({ where: { schoolId, createdAt: { gte:d, lte:d2 } } }),
          prisma.complaint.count({ where: { schoolId, createdAt: { gte:d, lte:d2 } } }),
          prisma.communicationMessage.count({ where: { schoolId, status:{ in:["SENT","PARTIALLY_SENT"] }, createdAt:{ gte:d, lte:d2 } } }),
        ]);
        trend.push({ date: d.toLocaleDateString("en-IN",{day:"2-digit",month:"short"}), enquiries:enq, visitors:vis, complaints:comp, messages:msg });
      }

      return reply.send({
        success: true,
        data: {
          kpi: { totalEnquiries, converted, visitors, totalComplaints, messagesSent, resolutionRate, conversionRate, openComplaints, todayEnquiries, todayVisitors },
          trend,
        },
      });
    }
  );

  // ── GET /admin/fo-reports/enquiries ──────────────────────
  app.get("/admin/fo-reports/enquiries",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string };
      const where: any = { schoolId };
      if (q.from || q.to) { where.createdAt = {}; if(q.from) where.createdAt.gte=new Date(q.from); if(q.to) where.createdAt.lte=new Date(q.to); }

      const [bySource, byStatus, byClass, byMonth, followUpStats, conversionFunnel] = await Promise.all([
        prisma.enquiry.groupBy({ by:["source"],          where, _count:true }),
        prisma.enquiry.groupBy({ by:["status"],          where, _count:true }),
        prisma.enquiry.groupBy({ by:["interestedClass"], where, _count:true }),
        // Group by month (last 6)
        (async () => {
          const months: any[] = [];
          for (let i = 5; i >= 0; i--) {
            const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); d.setHours(0,0,0,0);
            const d2 = new Date(d); d2.setMonth(d2.getMonth()+1); d2.setDate(0); d2.setHours(23,59,59,999);
            const [total, conv] = await Promise.all([
              prisma.enquiry.count({ where: { schoolId, createdAt:{ gte:d, lte:d2 } } }),
              prisma.enquiry.count({ where: { schoolId, status:"ADMISSION_CONFIRMED", createdAt:{ gte:d, lte:d2 } } }),
            ]);
            months.push({ month: d.toLocaleDateString("en-IN",{month:"short",year:"2-digit"}), total, converted:conv, convRate:total>0?Math.round((conv/total)*100):0 });
          }
          return months;
        })(),
        // Follow-up stats
        Promise.all([
          prisma.followUp.count({ where:{ schoolId, isDone:false } }),
          prisma.followUp.count({ where:{ schoolId, isDone:true } }),
          prisma.followUp.count({ where:{ schoolId, isDone:false, scheduledDate:{ lt:new Date() } } }),
        ]),
        // Conversion funnel
        Promise.all(["NEW","CONTACTED","FOLLOW_UP","VISIT_SCHEDULED","INTERESTED","ADMISSION_CONFIRMED"].map(s =>
          prisma.enquiry.count({ where:{ schoolId, status:s as any } })
        )),
      ]);

      const funnel = ["NEW","CONTACTED","FOLLOW_UP","VISIT_SCHEDULED","INTERESTED","ADMISSION_CONFIRMED"].map((s,i) => ({
        stage: s.replace(/_/g," "), count: conversionFunnel[i],
      }));

      // Top counselors
      const byCounselor = await prisma.enquiry.groupBy({ by:["assignedToId"], where, _count:true });
      const cIds = byCounselor.map(b => b.assignedToId).filter(Boolean) as number[];
      const cUsers = cIds.length > 0 ? await prisma.user.findMany({ where:{ id:{ in:cIds } }, select:{ id:true, name:true } }) : [];
      const cMap: Record<number,string> = {}; cUsers.forEach(u => { cMap[u.id]=u.name; });

      return reply.send({ success:true, data: {
        bySource: bySource.map(b=>({ source:b.source, count:b._count })).sort((a,b)=>b.count-a.count),
        byStatus: byStatus.map(b=>({ status:b.status, count:b._count })),
        byClass:  byClass.filter(b=>b.interestedClass).map(b=>({ class:b.interestedClass!, count:b._count })).sort((a,b)=>b.count-a.count),
        byMonth, funnel,
        followUps:{ pending:followUpStats[0], done:followUpStats[1], overdue:followUpStats[2] },
        byCounselor: byCounselor.filter(b=>b.assignedToId).map(b=>({ name:cMap[b.assignedToId!]??"—", count:b._count })).sort((a,b)=>b.count-a.count),
      }});
    }
  );

  // ── GET /admin/fo-reports/visitors ───────────────────────
  app.get("/admin/fo-reports/visitors",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string };
      const where: any = { schoolId };
      if (q.from || q.to) { where.createdAt={}; if(q.from) where.createdAt.gte=new Date(q.from); if(q.to) where.createdAt.lte=new Date(q.to); }

      const [byType, byPurpose, byStatus, avgDuration, byMonth, visitsByHour] = await Promise.all([
        prisma.visitor.groupBy({ by:["visitorType"], where, _count:true }),
        prisma.visitor.groupBy({ by:["purpose"],     where, _count:true }),
        prisma.visitor.groupBy({ by:["status"],      where, _count:true }),
        prisma.visitor.aggregate({ where:{ ...where, visitDurationMins:{ not:null } }, _avg:{ visitDurationMins:true } }),
        (async()=>{
          const months:any[]=[];
          for(let i=5;i>=0;i--){
            const d=new Date();d.setDate(1);d.setMonth(d.getMonth()-i);d.setHours(0,0,0,0);
            const d2=new Date(d);d2.setMonth(d2.getMonth()+1);d2.setDate(0);d2.setHours(23,59,59,999);
            const cnt=await prisma.visitor.count({where:{schoolId,createdAt:{gte:d,lte:d2}}});
            months.push({month:d.toLocaleDateString("en-IN",{month:"short",year:"2-digit"}),visitors:cnt});
          }
          return months;
        })(),
        // Peak hours from checkInAt
        (async()=>{
          const visitors=await prisma.visitor.findMany({ where:{ ...where, checkInAt:{ not:null } }, select:{ checkInAt:true } });
          const hourMap: Record<number,number>={};
          visitors.forEach(v=>{ if(v.checkInAt){ const h=new Date(v.checkInAt).getHours(); hourMap[h]=(hourMap[h]??0)+1; } });
          return Array.from({length:12},(_,i)=>i+7).map(h=>({ hour:`${h}:00`, count:hourMap[h]??0 }));
        })(),
      ]);

      // Most visited staff
      const byStaff = await prisma.visitor.groupBy({ by:["personToMeetId"], where:{ ...where, personToMeetId:{ not:null } }, _count:true });
      const sIds = byStaff.map(b=>b.personToMeetId).filter(Boolean) as number[];
      const sUsers = sIds.length>0 ? await prisma.user.findMany({ where:{ id:{ in:sIds } }, select:{ id:true, name:true } }) : [];
      const sMap:Record<number,string>={}; sUsers.forEach(u=>{ sMap[u.id]=u.name; });

      return reply.send({ success:true, data:{
        byType:    byType.map(b=>({ type:b.visitorType, count:b._count })).sort((a,b)=>b.count-a.count),
        byPurpose: byPurpose.map(b=>({ purpose:b.purpose.replace(/_/g," "), count:b._count })).sort((a,b)=>b.count-a.count),
        byStatus:  byStatus.map(b=>({ status:b.status, count:b._count })),
        avgDurationMins: Math.round(avgDuration._avg.visitDurationMins??0),
        byMonth, visitsByHour,
        byStaff: byStaff.filter(b=>b.personToMeetId).map(b=>({ name:sMap[b.personToMeetId!]??"—", count:b._count })).sort((a,b)=>b.count-a.count).slice(0,8),
      }});
    }
  );

  // ── GET /admin/fo-reports/complaints ─────────────────────
  app.get("/admin/fo-reports/complaints",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string };
      const where: any = { schoolId };
      if (q.from || q.to) { where.createdAt={}; if(q.from) where.createdAt.gte=new Date(q.from); if(q.to) where.createdAt.lte=new Date(q.to); }

      const [byCategory, byStatus, byPriority, byDept, escalations, avgResData] = await Promise.all([
        prisma.complaint.groupBy({ by:["category"],   where, _count:true }),
        prisma.complaint.groupBy({ by:["status"],     where, _count:true }),
        prisma.complaint.groupBy({ by:["priority"],   where, _count:true }),
        prisma.complaint.groupBy({ by:["department"], where, _count:true }),
        prisma.complaint.count({ where:{ ...where, status:"ESCALATED" } }),
        prisma.complaint.findMany({ where:{ ...where, resolvedAt:{ not:null } }, select:{ createdAt:true, resolvedAt:true, priority:true, feedbackRating:true } }),
      ]);

      const avgResHrs = avgResData.length>0
        ? Math.round(avgResData.reduce((s,c)=>s+(new Date(c.resolvedAt!).getTime()-new Date(c.createdAt).getTime()),0)/avgResData.length/3600000*10)/10 : 0;
      const avgRating = avgResData.filter(r=>r.feedbackRating).length>0
        ? Math.round(avgResData.filter(r=>r.feedbackRating).reduce((s,r)=>s+(r.feedbackRating!),0)/avgResData.filter(r=>r.feedbackRating).length*10)/10 : 0;

      // SLA compliance
      const SLA_HRS:Record<string,number>={LOW:168,MEDIUM:72,HIGH:24,URGENT:12};
      const withinSla = avgResData.filter(r=>{ const h=(new Date(r.resolvedAt!).getTime()-new Date(r.createdAt).getTime())/3600000; return h<=(SLA_HRS[r.priority]??72); }).length;
      const slaRate = avgResData.length>0 ? Math.round((withinSla/avgResData.length)*100) : 100;

      // By staff
      const byStaff = await prisma.complaint.groupBy({ by:["assignedToId"], where:{ ...where, assignedToId:{ not:null } }, _count:true });
      const sIds=byStaff.map(b=>b.assignedToId).filter(Boolean) as number[];
      const sUsers=sIds.length>0?await prisma.user.findMany({where:{id:{in:sIds}},select:{id:true,name:true}}):[];
      const sMap:Record<number,string>={}; sUsers.forEach(u=>{ sMap[u.id]=u.name; });

      return reply.send({ success:true, data:{
        byCategory: byCategory.map(b=>({ category:b.category, count:b._count })).sort((a,b)=>b.count-a.count),
        byStatus:   byStatus.map(b=>({ status:b.status, count:b._count })),
        byPriority: byPriority.map(b=>({ priority:b.priority, count:b._count })),
        byDept:     byDept.map(b=>({ dept:b.department??"Unassigned", count:b._count })).sort((a,b)=>b.count-a.count),
        metrics:{ avgResHrs, avgRating, slaRate, escalations, resolved:avgResData.length },
        byStaff: byStaff.filter(b=>b.assignedToId).map(b=>({ name:sMap[b.assignedToId!]??"—", count:b._count })).sort((a,b)=>b.count-a.count),
      }});
    }
  );

  // ── GET /admin/fo-reports/communication ──────────────────
  app.get("/admin/fo-reports/communication",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string };
      const where: any = { schoolId };
      if (q.from || q.to) { where.createdAt={}; if(q.from) where.createdAt.gte=new Date(q.from); if(q.to) where.createdAt.lte=new Date(q.to); }

      const [byChannel, byStatus, byCategory, totals, templates, byMonth] = await Promise.all([
        prisma.communicationMessage.groupBy({ by:["channel"],  where, _count:true }),
        prisma.communicationMessage.groupBy({ by:["status"],   where, _count:true }),
        prisma.communicationMessage.groupBy({ by:["category"], where:{ ...where, status:{ in:["SENT","PARTIALLY_SENT"] } }, _count:true }),
        prisma.communicationMessage.aggregate({ where:{ ...where, status:{ in:["SENT","PARTIALLY_SENT"] } }, _sum:{ recipientCount:true, deliveredCount:true, readCount:true, failedCount:true } }),
        prisma.messageTemplate.findMany({ where:{ schoolId }, orderBy:{ useCount:"desc" }, take:6, select:{ name:true, channel:true, useCount:true } }),
        (async()=>{
          const months:any[]=[];
          for(let i=5;i>=0;i--){
            const d=new Date();d.setDate(1);d.setMonth(d.getMonth()-i);d.setHours(0,0,0,0);
            const d2=new Date(d);d2.setMonth(d2.getMonth()+1);d2.setDate(0);d2.setHours(23,59,59,999);
            const [sent,del]=await Promise.all([
              prisma.communicationMessage.count({where:{schoolId,status:{in:["SENT","PARTIALLY_SENT"]},createdAt:{gte:d,lte:d2}}}),
              prisma.communicationMessage.aggregate({where:{schoolId,status:{in:["SENT","PARTIALLY_SENT"]},createdAt:{gte:d,lte:d2}},_sum:{deliveredCount:true}}),
            ]);
            months.push({month:d.toLocaleDateString("en-IN",{month:"short",year:"2-digit"}),sent,delivered:del._sum.deliveredCount??0});
          }
          return months;
        })(),
      ]);

      const t=totals._sum;
      const delivRate=t.recipientCount?Math.round(((t.deliveredCount??0)/(t.recipientCount??1))*100):0;
      const readRate=(t.deliveredCount??0)>0?Math.round(((t.readCount??0)/(t.deliveredCount??1))*100):0;

      return reply.send({ success:true, data:{
        byChannel:   byChannel.map(b=>({ channel:b.channel, count:b._count })).sort((a,b)=>b.count-a.count),
        byStatus:    byStatus.map(b=>({ status:b.status, count:b._count })),
        byCategory:  byCategory.map(b=>({ category:b.category, count:b._count })).sort((a,b)=>b.count-a.count),
        totals:{ sent:t.recipientCount??0, delivered:t.deliveredCount??0, read:t.readCount??0, failed:t.failedCount??0, delivRate, readRate },
        topTemplates: templates,
        byMonth,
      }});
    }
  );

  // ── GET /admin/fo-reports/staff ───────────────────────────
  app.get("/admin/fo-reports/staff",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string; month?: string; year?: string };

      const m = parseInt(q.month ?? String(new Date().getMonth()+1));
      const y = parseInt(q.year  ?? String(new Date().getFullYear()));

      const [staff, perfs] = await Promise.all([
        prisma.fOStaffProfile.findMany({ where:{ schoolId, isActive:true }, include:{ user:{ select:{ name:true } } } }),
        prisma.fOMonthlyPerf.findMany({ where:{ schoolId, month:m, year:y } }),
      ]);

      const perfMap:Record<number,any>={};
      perfs.forEach(p=>{ perfMap[p.staffId]=p; });

      const enriched = staff.map(s=>({
        staffId: s.id, userId:s.userId, name:s.user.name, role:s.foRole, employeeId:s.employeeId,
        targets:{ enquiries:s.targetEnquiries, admissions:s.targetAdmissions, followUps:s.targetFollowUps, complaints:s.targetComplaints },
        perf: perfMap[s.id] ?? { enquiriesHandled:0, admissionsConverted:0, visitorsManaged:0, complaintsResolved:0, followUpsDone:0, callsLogged:0 },
        convRate: s.targetAdmissions>0&&perfMap[s.id]
          ? Math.round((perfMap[s.id].admissionsConverted/(perfMap[s.id].enquiriesHandled||1))*100) : 0,
      })).sort((a,b)=>(b.perf.admissionsConverted+b.perf.complaintsResolved)-(a.perf.admissionsConverted+a.perf.complaintsResolved));

      return reply.send({ success:true, data:{ staff:enriched, month:m, year:y } });
    }
  );
}
