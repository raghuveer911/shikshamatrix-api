import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ── DEFAULT SETTINGS ──────────────────────────────────────────
const DEFAULTS = {
  officeOpenTime:"09:00", officeCloseTime:"17:00",
  workingDays:["MON","TUE","WED","THU","FRI"],
  enquiryAutoNumber:true, enquiryPrefix:"ENQ", enquiryDefaultStatus:"NEW",
  enquiryAutoAssign:false, followUpReminderHours:24, leadCooldownDays:90,
  visitorAutoNumber:true, visitorPrefix:"VIS", visitorPassRequired:true,
  visitorPhotoRequired:false, visitorIdRequired:false, maxVisitDurationHours:4,
  complaintPrefix:"TKT", slaLowDays:7, slaMediumDays:3, slaHighDays:1, slaUrgentHours:12,
  complaintAutoEscalate:true, escalateAfterHoursMultiplier:1.5,
  smsGateway:null, smsSenderId:null, emailFromAddress:null, emailFromName:null,
  whatsappApiEnabled:false, noticeExpiryDays:30, defaultLanguage:"ENGLISH",
  autoAssignEnquiry:false, autoFollowUpCreate:true, autoNotifyDeptOnComplaint:true,
  autoSendExamReminder:true, autoSendFeeReminder:true, autoSendAbsentAlert:true,
};

export async function adminFOSettingsRoutes(app: FastifyInstance) {

  // ── GET /admin/fo-settings ────────────────────────────────
  app.get("/admin/fo-settings",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      let settings = await prisma.frontOfficeSettings.findFirst({ where:{ schoolId }, include:{ updatedBy:{ select:{ name:true } } } });
      if (!settings) {
        settings = await prisma.frontOfficeSettings.create({ data:{ schoolId, ...DEFAULTS }, include:{ updatedBy:{ select:{ name:true } } } });
      }
      return reply.send({ success:true, data:{ settings } });
    }
  );

  // ── PUT /admin/fo-settings ────────────────────────────────
  app.put("/admin/fo-settings",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as any;
      const allowed = Object.keys(DEFAULTS);
      const data: any = { updatedById: userId };
      allowed.forEach(k => { if (body[k] !== undefined) data[k] = body[k]; });

      const old = await prisma.frontOfficeSettings.findFirst({ where:{ schoolId } });
      const settings = await prisma.frontOfficeSettings.upsert({ where:{ schoolId }, create:{ schoolId, ...DEFAULTS, ...data }, update:data });

      // Audit
      const changes: any = {};
      Object.keys(data).filter(k=>k!=="updatedById").forEach(k=>{ if(old && (old as any)[k]!==data[k]) changes[k]={ from:(old as any)[k], to:data[k] }; });
      await prisma.frontOfficeSettingsAudit.create({ data:{ schoolId, userId, action:"SETTINGS_UPDATED", changes, ipAddress:(req.headers["x-forwarded-for"] as string??req.socket.remoteAddress??null) } });

      return reply.send({ success:true, message:"Settings saved.", data:{ settings } });
    }
  );

  // ── PATCH /admin/fo-settings/section ─────────────────────
  app.patch("/admin/fo-settings/section",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { section, data } = req.body as { section:string; data:Record<string,any> };
      const update: any = { updatedById:userId, ...data };
      await prisma.frontOfficeSettings.upsert({ where:{ schoolId }, create:{ schoolId, ...DEFAULTS, ...update }, update });
      await prisma.frontOfficeSettingsAudit.create({ data:{ schoolId, userId, action:`SECTION_${section.toUpperCase()}_UPDATED`, changes:data } });
      return reply.send({ success:true, message:`${section} settings saved.` });
    }
  );

  // ── POST /admin/fo-settings/reset ────────────────────────
  app.post("/admin/fo-settings/reset",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      await prisma.frontOfficeSettings.upsert({ where:{ schoolId }, create:{ schoolId, ...DEFAULTS }, update:{ ...DEFAULTS, updatedById:userId } });
      await prisma.frontOfficeSettingsAudit.create({ data:{ schoolId, userId, action:"SETTINGS_RESET_TO_DEFAULTS" } });
      return reply.send({ success:true, message:"Settings reset to defaults." });
    }
  );

  // ── GET /admin/fo-settings/audit ─────────────────────────
  app.get("/admin/fo-settings/audit",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?:string };
      const page = Math.max(1, parseInt(q.page??"1"));
      const [logs, total] = await Promise.all([
        prisma.frontOfficeSettingsAudit.findMany({ where:{ schoolId }, orderBy:{ occurredAt:"desc" }, skip:(page-1)*20, take:20, include:{ user:{ select:{ name:true } } } }),
        prisma.frontOfficeSettingsAudit.count({ where:{ schoolId } }),
      ]);
      return reply.send({ success:true, data:{ logs, total, totalPages:Math.ceil(total/20) } });
    }
  );
}

// ═════════════════════════════════════════════════════════════
//  STAFF MANAGEMENT ROUTES
// ═════════════════════════════════════════════════════════════
export async function adminFOStaffRoutes(app: FastifyInstance) {

  // ── GET /admin/fo-staff/meta ──────────────────────────────
  app.get("/admin/fo-staff/meta",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date(); const m=now.getMonth()+1; const y=now.getFullYear();

      const [total, activeEnquiries, followUpsDue, complaintsAssigned, visitorsToday] = await Promise.all([
        prisma.fOStaffProfile.count({ where:{ schoolId, isActive:true } }),
        prisma.enquiry.count({ where:{ schoolId, status:{ notIn:["ADMISSION_CONFIRMED","LOST","NOT_INTERESTED"] }, assignedToId:{ not:null } } }),
        prisma.followUp.count({ where:{ schoolId, isDone:false, scheduledDate:{ lte:new Date() } } }),
        prisma.complaint.count({ where:{ schoolId, status:{ notIn:["RESOLVED","CLOSED"] }, assignedToId:{ not:null } } }),
        prisma.visitor.count({ where:{ schoolId, createdAt:{ gte:new Date(new Date().setHours(0,0,0,0)) } } }),
      ]);

      // Get eligible staff users
      const existingStaffIds = (await prisma.fOStaffProfile.findMany({ where:{ schoolId }, select:{ userId:true } })).map(s=>s.userId);
      const availableStaff = await prisma.staff.findMany({ where:{ schoolId, isActive:true, userId:{ notIn:existingStaffIds } }, include:{ user:{ select:{ id:true, name:true } } }, take:50 });

      return reply.send({ success:true, data:{ kpi:{ total, activeEnquiries, followUpsDue, complaintsAssigned, visitorsToday }, availableStaff } });
    }
  );

  // ── GET /admin/fo-staff ───────────────────────────────────
  app.get("/admin/fo-staff",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { role?:string; page?:string };
      const where: any = { schoolId };
      if (q.role) where.foRole = q.role;

      const staff = await prisma.fOStaffProfile.findMany({
        where, orderBy:{ createdAt:"asc" },
        include:{ user:{ select:{ name:true, email:true } }, _count:{ select:{ assignments:true, activityLogs:true } } },
      });

      const m=new Date().getMonth()+1; const y=new Date().getFullYear();
      const perfs = await prisma.fOMonthlyPerf.findMany({ where:{ schoolId, month:m, year:y } });
      const perfMap:Record<number,any>={}; perfs.forEach(p=>{ perfMap[p.staffId]=p; });

      // Workload
      const workload = await Promise.all(staff.map(async s => {
        const [assigned, completed, pending] = await Promise.all([
          prisma.fOAssignment.count({ where:{ staffId:s.id } }),
          prisma.fOAssignment.count({ where:{ staffId:s.id, isCompleted:true } }),
          prisma.fOAssignment.count({ where:{ staffId:s.id, isCompleted:false } }),
        ]);
        return { staffId:s.id, assigned, completed, pending };
      }));
      const workMap:Record<number,any>={}; workload.forEach(w=>{ workMap[w.staffId]=w; });

      const enriched = staff.map(s=>({ ...s, perf:perfMap[s.id]??null, work:workMap[s.id]??{assigned:0,completed:0,pending:0} }));
      return reply.send({ success:true, data:{ staff:enriched } });
    }
  );

  // ── GET /admin/fo-staff/:id ───────────────────────────────
  app.get("/admin/fo-staff/:id",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id:string };
      const s = await prisma.fOStaffProfile.findFirst({
        where:{ id:parseInt(id), schoolId },
        include:{ user:{ select:{ name:true, email:true } }, assignments:{ orderBy:{ createdAt:"desc" }, take:20 }, activityLogs:{ orderBy:{ occurredAt:"desc" }, take:30 }, monthlyPerfs:{ orderBy:[{ year:"desc" },{ month:"desc" }], take:6 } },
      });
      if (!s) return reply.status(404).send({ success:false, message:"Not found." });
      return reply.send({ success:true, data:{ staff:s } });
    }
  );

  // ── POST /admin/fo-staff ──────────────────────────────────
  app.post("/admin/fo-staff",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { userId:number; foRole?:string; employeeId?:string; phone?:string; joiningDate?:string; targetEnquiries?:number; targetAdmissions?:number; targetFollowUps?:number; targetComplaints?:number; notes?:string };
      const s = await prisma.fOStaffProfile.create({ data:{ schoolId, userId:body.userId, foRole:body.foRole as any??"RECEPTIONIST", employeeId:body.employeeId??null, phone:body.phone??null, joiningDate:body.joiningDate?new Date(body.joiningDate):null, targetEnquiries:body.targetEnquiries??50, targetAdmissions:body.targetAdmissions??10, targetFollowUps:body.targetFollowUps??100, targetComplaints:body.targetComplaints??20, notes:body.notes??null } });
      return reply.status(201).send({ success:true, data:{ staffId:s.id } });
    }
  );

  // ── PUT /admin/fo-staff/:id ───────────────────────────────
  app.put("/admin/fo-staff/:id",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id:string };
      const body = req.body as any;
      const data:any={};
      ["foRole","employeeId","phone","isActive","notes","targetEnquiries","targetAdmissions","targetFollowUps","targetComplaints"].forEach(k=>{ if(body[k]!==undefined) data[k]=body[k]; });
      await prisma.fOStaffProfile.updateMany({ where:{ id:parseInt(id), schoolId }, data });
      return reply.send({ success:true, message:"Profile updated." });
    }
  );

  // ── POST /admin/fo-staff/assign ───────────────────────────
  app.post("/admin/fo-staff/assign",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { staffId:number; type:string; entityIds:number[]; dueDate?:string; notes?:string };
      const assignments = await prisma.fOAssignment.createMany({
        data: body.entityIds.map(eid=>({ schoolId, staffId:body.staffId, type:body.type as any, entityId:eid, dueDate:body.dueDate?new Date(body.dueDate):null, notes:body.notes??null, assignedById:userId })),
      });
      // Log activity
      await prisma.fOActivityLog.create({ data:{ schoolId, staffId:body.staffId, action:`BULK_ASSIGNED`, description:`${body.entityIds.length} ${body.type.toLowerCase()}(s) assigned` } });
      return reply.status(201).send({ success:true, message:`${body.entityIds.length} items assigned.`, data:{ count:assignments.count } });
    }
  );

  // ── PATCH /admin/fo-staff/assignment/:id/complete ─────────
  app.patch("/admin/fo-staff/assignment/:id/complete",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id:string };
      const asgn = await prisma.fOAssignment.findFirst({ where:{ id:parseInt(id) } });
      if (!asgn) return reply.status(404).send({ success:false, message:"Not found." });
      await prisma.fOAssignment.update({ where:{ id:parseInt(id) }, data:{ isCompleted:true, completedAt:new Date() } });
      return reply.send({ success:true });
    }
  );

  // ── PUT /admin/fo-staff/:id/targets ───────────────────────
  app.put("/admin/fo-staff/:id/targets",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id:string };
      const { targetEnquiries, targetAdmissions, targetFollowUps, targetComplaints } = req.body as any;
      await prisma.fOStaffProfile.updateMany({ where:{ id:parseInt(id), schoolId }, data:{ targetEnquiries,targetAdmissions,targetFollowUps,targetComplaints } });
      return reply.send({ success:true, message:"Targets updated." });
    }
  );

  // ── POST /admin/fo-staff/:id/perf ─────────────────────────
  app.post("/admin/fo-staff/:id/perf",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id:string };
      const body = req.body as { month:number; year:number; enquiriesHandled?:number; admissionsConverted?:number; visitorsManaged?:number; complaintsResolved?:number; followUpsDone?:number; callsLogged?:number; rating?:number };
      await prisma.fOMonthlyPerf.upsert({
        where:{ staffId_month_year:{ staffId:parseInt(id), month:body.month, year:body.year } },
        create:{ schoolId, staffId:parseInt(id), month:body.month, year:body.year, ...body },
        update:{ ...body },
      });
      return reply.send({ success:true, message:"Performance updated." });
    }
  );

  // ── GET /admin/fo-staff/:id/activity ─────────────────────
  app.get("/admin/fo-staff/:id/activity",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id:string };
      const logs = await prisma.fOActivityLog.findMany({ where:{ staffId:parseInt(id), schoolId }, orderBy:{ occurredAt:"desc" }, take:50 });
      return reply.send({ success:true, data:{ logs } });
    }
  );

  // ── GET /admin/fo-staff/leaderboard ──────────────────────
  app.get("/admin/fo-staff/leaderboard",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const m = new Date().getMonth()+1; const y = new Date().getFullYear();
      const perfs = await prisma.fOMonthlyPerf.findMany({
        where:{ schoolId, month:m, year:y },
        include:{ staff:{ include:{ user:{ select:{ name:true } } } } },
        orderBy:{ admissionsConverted:"desc" },
      });
      const board = perfs.map((p,i)=>({ rank:i+1, name:p.staff.user.name, role:p.staff.foRole, admissions:p.admissionsConverted, enquiries:p.enquiriesHandled, complaints:p.complaintsResolved, rating:p.rating, score:p.admissionsConverted*3+p.complaintsResolved*2+p.followUpsDone }));
      return reply.send({ success:true, data:{ leaderboard:board, month:m, year:y } });
    }
  );

  // ── DELETE /admin/fo-staff/:id ────────────────────────────
  app.delete("/admin/fo-staff/:id",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id:string };
      await prisma.fOStaffProfile.updateMany({ where:{ id:parseInt(id), schoolId }, data:{ isActive:false } });
      return reply.send({ success:true });
    }
  );
}
