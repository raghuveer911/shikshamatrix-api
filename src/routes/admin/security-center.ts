import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── Helper: compute security health score ────────────────────
async function calcHealthScore(schoolId: number): Promise<{ score: number; status: string }> {
  const [
    openIncidents,
    criticalStates,
    totalActive,
    settingsExist,
  ] = await Promise.all([
    prisma.examIncident.count({ where: { schoolId, isResolved: false, severity: { in: ["HIGH","CRITICAL"] } } }),
    prisma.examCandidateState.count({ where: { schoolId, suspicionScore: { gte: 80 } } }),
    prisma.examCandidateState.count({ where: { schoolId, status: { in: ["ACTIVE","IDLE"] } } }),
    prisma.schoolSecuritySettings.findFirst({ where: { schoolId } }),
  ]);

  let score = 100;
  score -= Math.min(openIncidents * 5, 30);
  score -= Math.min(criticalStates * 3, 20);
  if (!settingsExist) score -= 5;

  score = Math.max(0, Math.min(100, score));
  const status = score >= 85 ? "EXCELLENT" : score >= 70 ? "GOOD" : score >= 50 ? "WARNING" : "CRITICAL";
  return { score, status };
}

export async function adminSecurityCenterRoutes(app: FastifyInstance) {

  // ── POST /admin/security-center/audit ─────────────────────
  // Utility used by other modules to log actions
  app.post("/admin/security-center/audit",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        action: string; entityType?: string; entityId?: number;
        description?: string; metadata?: any;
      };
      await prisma.auditLog.create({
        data: {
          schoolId, userId,
          action:      body.action as any,
          entityType:  body.entityType  ?? null,
          entityId:    body.entityId    ?? null,
          description: body.description ?? null,
          ipAddress:   (req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? null),
          metadata:    body.metadata    ?? null,
        },
      });
      return reply.send({ success: true });
    }
  );

  // ── GET /admin/security-center/meta ──────────────────────
  app.get("/admin/security-center/meta",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const health = await calcHealthScore(schoolId);

      const [
        secureExams, alerts, tabSwitches, multiLogin, blockedSessions, openIncidents,
      ] = await Promise.all([
        prisma.onlineExam.count({ where: { schoolId, status: { in:["PUBLISHED","LIVE","COMPLETED"] } } }),
        prisma.examIncident.count({ where: { schoolId, isResolved:false } }),
        prisma.examActivityEvent.count({ where: { schoolId, eventType:"TAB_SWITCH" } }),
        prisma.examActivityEvent.count({ where: { schoolId, eventType:"MULTIPLE_LOGIN" } }),
        prisma.examCandidateState.count({ where: { schoolId, isBlocked:true } }),
        prisma.examIncident.count({ where: { schoolId, isResolved:false } }),
      ]);

      return reply.send({
        success: true,
        data: { health, kpi: { secureExams, alerts, tabSwitches, multiLogin, blockedSessions, openIncidents } },
      });
    }
  );

  // ── GET /admin/security-center/dashboard ─────────────────
  app.get("/admin/security-center/dashboard",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [liveAlerts, recentIncidents, highRisk, trends] = await Promise.all([
        // Live alerts from activity events
        prisma.examActivityEvent.findMany({
          where: { schoolId, eventType: { in:["TAB_SWITCH","MULTIPLE_LOGIN","IP_CHANGE","DEVICE_CHANGE"] } },
          orderBy: { occurredAt: "desc" },
          take: 20,
          include: {
            student: { include: { user: { select: { name: true } } } },
            schedule: { include: { exam: { select: { name: true } } } },
          },
        }),
        // Recent incidents
        prisma.examIncident.findMany({
          where: { schoolId, isResolved: false },
          orderBy: { occurredAt: "desc" },
          take: 10,
          include: {
            student: { include: { user: { select: { name: true } } } },
            schedule: { include: { exam: { select: { name: true } } } },
          },
        }),
        // High risk students
        prisma.examCandidateState.findMany({
          where: { schoolId, suspicionScore: { gte: 50 } },
          orderBy: { suspicionScore: "desc" },
          take: 10,
          include: {
            student: { include: { user: { select: { name: true } } }, },
            schedule: { include: { exam: { select: { name: true } } } },
          },
        }),
        // Last 7 days trends
        (async () => {
          const days: { date: string; incidents: number; tabSwitches: number }[] = [];
          for (let i = 6; i >= 0; i--) {
            const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
            const d2 = new Date(d); d2.setHours(23,59,59,999);
            const [inc, tab] = await Promise.all([
              prisma.examIncident.count({ where: { schoolId, occurredAt: { gte:d, lte:d2 } } }),
              prisma.examActivityEvent.count({ where: { schoolId, eventType:"TAB_SWITCH", occurredAt: { gte:d, lte:d2 } } }),
            ]);
            days.push({ date: d.toLocaleDateString("en-IN",{day:"2-digit",month:"short"}), incidents: inc, tabSwitches: tab });
          }
          return days;
        })(),
      ]);

      // Incident category distribution
      const catDist = await prisma.examIncident.groupBy({
        by: ["incidentType"],
        where: { schoolId },
        _count: true,
      });

      return reply.send({
        success: true,
        data: {
          liveAlerts: liveAlerts.map(a => ({
            id: a.id, eventType: a.eventType,
            studentName: a.student.user.name,
            examName: a.schedule?.exam?.name ?? "—",
            occurredAt: a.occurredAt, severity: a.severity,
            metadata: a.metadata,
          })),
          recentIncidents,
          highRisk: highRisk.map(h => ({
            studentId: h.studentId, studentName: h.student.user.name,
            examName: h.schedule?.exam?.name ?? "—",
            suspicionScore: h.suspicionScore, alertLevel: h.alertLevel,
            tabSwitchCount: h.tabSwitchCount, disconnectCount: h.disconnectCount,
          })),
          trends,
          catDist: catDist.map(c => ({ type: c.incidentType, count: c._count })),
        },
      });
    }
  );

  // ── GET /admin/security-center/policies ──────────────────
  app.get("/admin/security-center/policies",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [policies, exams] = await Promise.all([
        prisma.examSecurityPolicy.findMany({
          where: { schoolId },
          include: { exam: { select: { id:true, name:true, examCode:true, subject: { select:{ name:true } } } }, createdBy: { select: { name:true } } },
          orderBy: { createdAt: "desc" },
        }),
        prisma.onlineExam.findMany({
          where: { schoolId, status: { in:["DRAFT","PUBLISHED","READY","SCHEDULED"] } },
          select: { id:true, name:true, examCode:true, subject:{ select:{ name:true } } },
          orderBy: { createdAt:"desc" },
        }),
      ]);

      return reply.send({ success:true, data:{ policies, exams } });
    }
  );

  // ── POST /admin/security-center/policies ─────────────────
  app.post("/admin/security-center/policies",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        examId: number;
        fullScreenRequired?: boolean; fullScreenPolicy?: string;
        tabSwitchPolicy?: string; maxTabSwitches?: number;
        refreshPolicy?: string; preventMultiLogin?: boolean; singleDeviceOnly?: boolean;
        allowedIpRange?: string; deviceRestriction?: string;
        copyPasteRestrict?: boolean; rightClickDisable?: boolean; printDisable?: boolean;
        examWindowRestrict?: boolean; idleTimeoutMins?: number;
      };

      const policy = await prisma.examSecurityPolicy.upsert({
        where:  { examId: body.examId },
        create: {
          schoolId, examId: body.examId, createdById: userId,
          fullScreenRequired:  body.fullScreenRequired  ?? false,
          fullScreenPolicy:    body.fullScreenPolicy    ?? "OPTIONAL",
          tabSwitchPolicy:     body.tabSwitchPolicy as any ?? "WARN",
          maxTabSwitches:      body.maxTabSwitches      ?? 3,
          refreshPolicy:       body.refreshPolicy       ?? "WARN",
          preventMultiLogin:   body.preventMultiLogin   ?? true,
          singleDeviceOnly:    body.singleDeviceOnly    ?? false,
          allowedIpRange:      body.allowedIpRange      ?? null,
          deviceRestriction:   body.deviceRestriction   ?? "ANY",
          copyPasteRestrict:   body.copyPasteRestrict   ?? false,
          rightClickDisable:   body.rightClickDisable   ?? false,
          printDisable:        body.printDisable        ?? true,
          examWindowRestrict:  body.examWindowRestrict  ?? true,
          idleTimeoutMins:     body.idleTimeoutMins     ?? 15,
        },
        update: {
          fullScreenRequired:  body.fullScreenRequired  ?? undefined,
          fullScreenPolicy:    body.fullScreenPolicy    ?? undefined,
          tabSwitchPolicy:     body.tabSwitchPolicy as any ?? undefined,
          maxTabSwitches:      body.maxTabSwitches      ?? undefined,
          refreshPolicy:       body.refreshPolicy       ?? undefined,
          preventMultiLogin:   body.preventMultiLogin   ?? undefined,
          singleDeviceOnly:    body.singleDeviceOnly    ?? undefined,
          allowedIpRange:      body.allowedIpRange      ?? undefined,
          deviceRestriction:   body.deviceRestriction   ?? undefined,
          copyPasteRestrict:   body.copyPasteRestrict   ?? undefined,
          rightClickDisable:   body.rightClickDisable   ?? undefined,
          printDisable:        body.printDisable        ?? undefined,
          examWindowRestrict:  body.examWindowRestrict  ?? undefined,
          idleTimeoutMins:     body.idleTimeoutMins     ?? undefined,
        },
      });

      await prisma.auditLog.create({
        data: { schoolId, userId, action:"POLICY_UPDATED", entityType:"OnlineExam", entityId: body.examId, description:`Security policy updated for exam #${body.examId}` },
      });

      return reply.send({ success:true, message:"Policy saved.", data:{ policyId: policy.id } });
    }
  );

  // ── GET /admin/security-center/devices ───────────────────
  app.get("/admin/security-center/devices",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string; search?: string };

      const where: any = { schoolId };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);

      const states = await prisma.examCandidateState.findMany({
        where,
        orderBy: { lastActivityAt: "desc" },
        take: 50,
        include: {
          student: { include: { user: { select: { name:true } }, class: { select: { name:true } } } },
          schedule: { include: { exam: { select: { name:true } } } },
        },
      });

      const devices = states.map(s => ({
        studentId:      s.studentId,
        studentName:    s.student.user.name,
        class:          s.student.class?.name ?? "—",
        examName:       s.schedule?.exam?.name ?? "—",
        ipAddress:      s.ipAddress,
        browser:        s.browser,
        deviceInfo:     s.deviceInfo,
        status:         s.status,
        isBlocked:      s.isBlocked,
        startedAt:      s.startedAt,
        lastActivityAt: s.lastActivityAt,
      }));

      return reply.send({ success:true, data:{ devices } });
    }
  );

  // ── POST /admin/security-center/force-logout ─────────────
  app.post("/admin/security-center/force-logout",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { studentId, scheduleId } = req.body as { studentId: number; scheduleId: number };

      await prisma.examCandidateState.updateMany({
        where: { schoolId, studentId, scheduleId },
        data: { status:"DISCONNECTED", isBlocked:true },
      });
      await prisma.auditLog.create({
        data: { schoolId, userId, action:"SESSION_FORCE_LOGOUT", entityType:"Student", entityId: studentId, description:`Force logout student #${studentId}` },
      });

      return reply.send({ success:true, message:"Session force logged out." });
    }
  );

  // ── GET /admin/security-center/suspicious ────────────────
  app.get("/admin/security-center/suspicious",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { level?: string; scheduleId?: string };

      const where: any = { schoolId, suspicionScore: { gt: 0 } };
      if (q.scheduleId) where.scheduleId = parseInt(q.scheduleId);
      if (q.level === "HIGH")     where.suspicionScore = { gte:61, lt:81 };
      if (q.level === "CRITICAL") where.suspicionScore = { gte:81 };
      if (q.level === "MEDIUM")   where.suspicionScore = { gte:31, lt:61 };
      if (q.level === "LOW")      where.suspicionScore = { gte:1,  lt:31 };

      const states = await prisma.examCandidateState.findMany({
        where, orderBy: { suspicionScore: "desc" }, take: 50,
        include: {
          student: { include: { user: { select:{ name:true } }, class:{ select:{ name:true } } } },
          schedule: { include: { exam:{ select:{ name:true } } } },
        },
      });

      // Per-student activity counts
      const withActivity = await Promise.all(states.map(async s => {
        const events = await prisma.examActivityEvent.groupBy({
          by: ["eventType"],
          where: { scheduleId: s.scheduleId, studentId: s.studentId, schoolId },
          _count: true,
        });
        const evMap: Record<string,number> = {};
        events.forEach(e => { evMap[e.eventType] = e._count; });
        return {
          ...s, studentName: s.student.user.name, class: s.student.class?.name ?? "—",
          examName: s.schedule?.exam?.name ?? "—", events: evMap,
        };
      }));

      return reply.send({ success:true, data:{ students: withActivity } });
    }
  );

  // ── GET /admin/security-center/incidents ─────────────────
  app.get("/admin/security-center/incidents",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?:string; status?:string; type?:string; severity?:string; search?:string };
      const page  = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 20;

      const where: any = { schoolId };
      if (q.status && q.status !== "ALL") where.isResolved = q.status === "RESOLVED";
      if (q.type)     where.incidentType = q.type;
      if (q.severity) where.severity     = q.severity;

      const [incidents, total] = await Promise.all([
        prisma.examIncident.findMany({
          where, skip: (page-1)*limit, take: limit,
          orderBy: { occurredAt: "desc" },
          include: {
            student:     { include: { user: { select:{ name:true } }, class:{ select:{ name:true } } } },
            schedule:    { include: { exam:{ select:{ name:true } } } },
            reportedBy:  { select:{ name:true } },
          },
        }),
        prisma.examIncident.count({ where }),
      ]);

      return reply.send({
        success:true,
        data: { incidents, total, totalPages: Math.ceil(total/limit) },
      });
    }
  );

  // ── PATCH /admin/security-center/incidents/:id ────────────
  app.patch("/admin/security-center/incidents/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id:string };
      const { resolution, actionTaken, note } = req.body as {
        resolution: "RESOLVED"|"IGNORED"|"UNDER_REVIEW"; actionTaken?:string; note?:string;
      };

      const isResolved = resolution === "RESOLVED" || resolution === "IGNORED";
      await prisma.examIncident.updateMany({
        where: { id: parseInt(id), schoolId },
        data: {
          isResolved,
          resolvedAt: isResolved ? new Date() : null,
          actionTaken: actionTaken ?? undefined,
        },
      });

      await prisma.auditLog.create({
        data: { schoolId, userId, action:"INCIDENT_RESOLVED", entityType:"ExamIncident", entityId:parseInt(id), description:`Incident ${resolution}: ${note??actionTaken??""}` },
      });

      return reply.send({ success:true, message:`Incident marked ${resolution}.` });
    }
  );

  // ── GET /admin/security-center/audit-logs ────────────────
  app.get("/admin/security-center/audit-logs",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?:string; action?:string; userId?:string; from?:string; to?:string };
      const page  = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 30;

      const where: any = { schoolId };
      if (q.action) where.action = q.action;
      if (q.userId) where.userId = parseInt(q.userId);
      if (q.from || q.to) {
        where.occurredAt = {};
        if (q.from) where.occurredAt.gte = new Date(q.from);
        if (q.to)   where.occurredAt.lte = new Date(q.to);
      }

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where, skip: (page-1)*limit, take: limit,
          orderBy: { occurredAt:"desc" },
          include: { user: { select: { name:true } } },
        }),
        prisma.auditLog.count({ where }),
      ]);

      return reply.send({ success:true, data:{ logs, total, totalPages:Math.ceil(total/limit) } });
    }
  );

  // ── GET /admin/security-center/settings ──────────────────
  app.get("/admin/security-center/settings",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const settings = await prisma.schoolSecuritySettings.findFirst({ where: { schoolId } });
      return reply.send({ success:true, data:{ settings } });
    }
  );

  // ── PUT /admin/security-center/settings ──────────────────
  app.put("/admin/security-center/settings",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as any;

      const settings = await prisma.schoolSecuritySettings.upsert({
        where: { schoolId },
        create: { schoolId, ...body },
        update: { ...body },
      });

      await prisma.auditLog.create({
        data: { schoolId, userId, action:"SECURITY_SETTINGS_CHANGED", description:"Global security settings updated" },
      });

      return reply.send({ success:true, message:"Settings saved.", data:{ settings } });
    }
  );

  // ── GET /admin/security-center/reports ───────────────────
  app.get("/admin/security-center/reports",
    { preHandler: [authenticate, requireCapability('onlineExams.securityCenter')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { type?:string; scheduleId?:string };

      if (q.type === "INCIDENT") {
        const data = await prisma.examIncident.findMany({
          where: { schoolId, ...(q.scheduleId?{ scheduleId:parseInt(q.scheduleId) }:{}) },
          orderBy: { occurredAt:"desc" },
          include: {
            student: { include:{ user:{ select:{ name:true } } } },
            schedule: { include:{ exam:{ select:{ name:true } } } },
            reportedBy: { select:{ name:true } },
          },
        });
        return reply.send({ success:true, data:{ report:data, type:"INCIDENT" } });
      }

      if (q.type === "SUSPICIOUS") {
        const data = await prisma.examCandidateState.findMany({
          where: { schoolId, suspicionScore:{ gt:25 }, ...(q.scheduleId?{ scheduleId:parseInt(q.scheduleId) }:{}) },
          orderBy: { suspicionScore:"desc" },
          include: {
            student: { include:{ user:{ select:{ name:true } } } },
            schedule: { include:{ exam:{ select:{ name:true } } } },
          },
        });
        return reply.send({ success:true, data:{ report:data, type:"SUSPICIOUS" } });
      }

      if (q.type === "LOGIN") {
        const data = await prisma.auditLog.findMany({
          where: { schoolId, action:{ in:["USER_LOGIN","USER_LOGOUT","SESSION_FORCE_LOGOUT","STUDENT_BLOCKED"] } },
          orderBy: { occurredAt:"desc" }, take:100,
          include: { user:{ select:{ name:true } } },
        });
        return reply.send({ success:true, data:{ report:data, type:"LOGIN" } });
      }

      // General compliance summary
      const [totalExams, policiesSet, totalIncidents, resolved, unresolved] = await Promise.all([
        prisma.onlineExam.count({ where:{ schoolId } }),
        prisma.examSecurityPolicy.count({ where:{ schoolId } }),
        prisma.examIncident.count({ where:{ schoolId } }),
        prisma.examIncident.count({ where:{ schoolId, isResolved:true } }),
        prisma.examIncident.count({ where:{ schoolId, isResolved:false } }),
      ]);
      const health = await calcHealthScore(schoolId);

      return reply.send({
        success:true,
        data:{
          type:"COMPLIANCE",
          report:{ totalExams, policiesSet, coveragePct: totalExams>0?Math.round((policiesSet/totalExams)*100):0,
                   totalIncidents, resolved, unresolved, health },
        },
      });
    }
  );
}
