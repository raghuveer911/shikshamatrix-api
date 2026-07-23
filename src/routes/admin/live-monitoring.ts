import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── Helper: compute suspicion score ──────────────────────────
function computeSuspicion(state: { tabSwitchCount: number; disconnectCount: number; }): { score: number; level: string } {
  let score = 0;
  score += Math.min(state.tabSwitchCount * 15, 60);
  score += Math.min(state.disconnectCount * 10, 30);
  score = Math.min(score, 100);
  const level = score >= 75 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "MEDIUM" : score > 0 ? "LOW" : null;
  return { score, level: level ?? "" };
}

export async function adminLiveMonitoringRoutes(app: FastifyInstance) {

  // ── GET /admin/live-monitoring/meta ───────────────────────
  app.get("/admin/live-monitoring/meta",
    { preHandler: [authenticate, requireCapability('onlineExams.liveMonitoring')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const activeSchedules = await prisma.testSchedule.findMany({
        where: { schoolId, status: { in: ["LIVE", "PUBLISHED"] } },
        include: {
          exam: { select: { id: true, name: true, totalQuestions: true, duration: true, subject: { select: { name: true } } } },
        },
        orderBy: { startTime: "asc" },
      });

      return reply.send({ success: true, data: { schedules: activeSchedules } });
    }
  );

  // ── GET /admin/live-monitoring/:scheduleId/dashboard ──────
  app.get("/admin/live-monitoring/:scheduleId/dashboard",
    { preHandler: [authenticate, requireCapability('onlineExams.liveMonitoring')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { scheduleId } = req.params as { scheduleId: string };
      const sid = parseInt(scheduleId);

      const schedule = await prisma.testSchedule.findFirst({
        where: { id: sid, schoolId },
        include: { exam: { select: { name: true, totalQuestions: true, totalMarks: true, duration: true, subject: { select: { name: true } } } } },
      });
      if (!schedule) return reply.status(404).send({ success: false, message: "Schedule not found." });

      // Candidate states
      const states = await prisma.examCandidateState.findMany({ where: { scheduleId: sid, schoolId } });
      const total = schedule.totalEligible || states.length;
      const started    = states.filter(s => s.status !== "NOT_STARTED").length;
      const inProgress = states.filter(s => s.status === "ACTIVE" || s.status === "IDLE").length;
      const submitted  = states.filter(s => s.status === "SUBMITTED").length;
      const absent     = total - started;
      const suspicious = states.filter(s => s.suspicionScore > 25).length;
      const alerts     = await prisma.examIncident.count({ where: { scheduleId: sid, schoolId, isResolved: false } });

      // Time remaining
      const now = new Date();
      const endTime = new Date(schedule.endTime);
      const msLeft = endTime.getTime() - now.getTime();
      const minsLeft = Math.max(0, Math.floor(msLeft / 60000));

      return reply.send({
        success: true,
        data: {
          schedule, minsLeft,
          kpi: { total, started, inProgress, submitted, absent, suspicious, alerts },
        },
      });
    }
  );

  // ── GET /admin/live-monitoring/:scheduleId/candidates ─────
  app.get("/admin/live-monitoring/:scheduleId/candidates",
    { preHandler: [authenticate, requireCapability('onlineExams.liveMonitoring')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { scheduleId } = req.params as { scheduleId: string };
      const q = req.query as { statusFilter?: string; search?: string; classId?: string };
      const sid = parseInt(scheduleId);

      const schedule = await prisma.testSchedule.findFirst({
        where: { id: sid, schoolId },
        select: { applicableClasses: true, specificStudents: true, accessType: true },
      });
      if (!schedule) return reply.status(404).send({ success: false, message: "Not found." });

      // Eligible students
      const studentWhere: any = { schoolId, isActive: true };
      if (schedule.accessType === "ALL_ELIGIBLE" && schedule.applicableClasses.length > 0) {
        studentWhere.classId = { in: schedule.applicableClasses };
      } else if (schedule.specificStudents.length > 0) {
        studentWhere.id = { in: schedule.specificStudents };
      }
      if (q.classId) studentWhere.classId = parseInt(q.classId);
      if (q.search) {
        studentWhere.user = { name: { contains: q.search, mode: "insensitive" } };
      }

      const students = await prisma.student.findMany({
        where: studentWhere,
        include: { user: { select: { id: true, name: true, avatarUrl: true } }, class: { select: { name: true } } },
        orderBy: { rollNumber: "asc" },
      });

      // States
      const states = await prisma.examCandidateState.findMany({ where: { scheduleId: sid, schoolId } });
      const stateMap: Record<number, typeof states[0]> = {};
      states.forEach(s => { stateMap[s.studentId] = s; });

      const candidates = students.map(s => {
        const state = stateMap[s.id];
        return {
          studentId: s.id, name: s.user.name, avatarUrl: s.user.avatarUrl,
          rollNumber: s.rollNumber, class: s.class?.name,
          status:            state?.status            ?? "NOT_STARTED",
          currentQuestion:   state?.currentQuestion   ?? 0,
          questionsAttempted:state?.questionsAttempted ?? 0,
          progressPercent:   Number(state?.progressPercent ?? 0),
          timeRemainingMins: state?.timeRemainingMins  ?? null,
          tabSwitchCount:    state?.tabSwitchCount     ?? 0,
          suspicionScore:    state?.suspicionScore     ?? 0,
          alertLevel:        state?.alertLevel         ?? null,
          isPaused:          state?.isPaused           ?? false,
          isBlocked:         state?.isBlocked          ?? false,
          lastActivityAt:    state?.lastActivityAt     ?? null,
          startedAt:         state?.startedAt          ?? null,
          ipAddress:         state?.ipAddress          ?? null,
          browser:           state?.browser            ?? null,
        };
      });

      const filtered = q.statusFilter
        ? candidates.filter(c => c.status === q.statusFilter || (q.statusFilter === "SUSPICIOUS" && c.suspicionScore > 25))
        : candidates;

      return reply.send({ success: true, data: { candidates: filtered, total: filtered.length } });
    }
  );

  // ── GET /admin/live-monitoring/:scheduleId/candidate/:studentId ──
  app.get("/admin/live-monitoring/:scheduleId/candidate/:studentId",
    { preHandler: [authenticate, requireCapability('onlineExams.liveMonitoring')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { scheduleId, studentId } = req.params as { scheduleId: string; studentId: string };

      const [state, events] = await Promise.all([
        prisma.examCandidateState.findFirst({
          where: { scheduleId: parseInt(scheduleId), studentId: parseInt(studentId), schoolId },
          include: { student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } } },
        }),
        prisma.examActivityEvent.findMany({
          where: { scheduleId: parseInt(scheduleId), studentId: parseInt(studentId) },
          orderBy: { occurredAt: "desc" },
          take: 30,
        }),
      ]);

      return reply.send({ success: true, data: { state, events } });
    }
  );

  // ── POST /admin/live-monitoring/:scheduleId/candidate-state ──
  // Student client pings this to update their state
  app.post("/admin/live-monitoring/:scheduleId/candidate-state",
    { preHandler: [authenticate, requireCapability('onlineExams.liveMonitoring')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { scheduleId } = req.params as { scheduleId: string };
      const body = req.body as {
        studentId: number; status: string;
        currentQuestion?: number; questionsAttempted?: number;
        questionsSkipped?: number; markedForReview?: number;
        progressPercent?: number; timeRemainingMins?: number;
        ipAddress?: string; deviceInfo?: string; browser?: string;
        tabSwitchCount?: number; disconnectCount?: number;
      };

      const { score, level } = computeSuspicion({
        tabSwitchCount: body.tabSwitchCount ?? 0,
        disconnectCount: body.disconnectCount ?? 0,
      });

      const state = await prisma.examCandidateState.upsert({
        where: { scheduleId_studentId: { scheduleId: parseInt(scheduleId), studentId: body.studentId } },
        create: {
          schoolId, scheduleId: parseInt(scheduleId), studentId: body.studentId,
          status: body.status, currentQuestion: body.currentQuestion ?? null,
          questionsAttempted: body.questionsAttempted ?? 0, questionsSkipped: body.questionsSkipped ?? 0,
          markedForReview: body.markedForReview ?? 0, progressPercent: body.progressPercent ?? 0,
          timeRemainingMins: body.timeRemainingMins ?? null,
          ipAddress: body.ipAddress ?? null, deviceInfo: body.deviceInfo ?? null, browser: body.browser ?? null,
          tabSwitchCount: body.tabSwitchCount ?? 0, disconnectCount: body.disconnectCount ?? 0,
          suspicionScore: score, alertLevel: level as any || null,
          startedAt: body.status === "ACTIVE" ? new Date() : null, lastActivityAt: new Date(),
          submittedAt: body.status === "SUBMITTED" ? new Date() : null,
        },
        update: {
          status: body.status,
          currentQuestion: body.currentQuestion ?? undefined,
          questionsAttempted: body.questionsAttempted ?? undefined,
          questionsSkipped: body.questionsSkipped ?? undefined,
          markedForReview: body.markedForReview ?? undefined,
          progressPercent: body.progressPercent ?? undefined,
          timeRemainingMins: body.timeRemainingMins ?? undefined,
          ipAddress: body.ipAddress ?? undefined,
          tabSwitchCount: body.tabSwitchCount ?? undefined,
          disconnectCount: body.disconnectCount ?? undefined,
          suspicionScore: score, alertLevel: level as any || null,
          lastActivityAt: new Date(),
          submittedAt: body.status === "SUBMITTED" ? new Date() : undefined,
        },
      });

      // Auto-generate incident for high suspicion
      if (score >= 50) {
        const existing = await prisma.examIncident.findFirst({
          where: { scheduleId: parseInt(scheduleId), studentId: body.studentId, isResolved: false, incidentType: "TAB_SWITCHING" },
        });
        if (!existing) {
          await prisma.examIncident.create({
            data: {
              schoolId, scheduleId: parseInt(scheduleId), studentId: body.studentId,
              incidentType: "TAB_SWITCHING", severity: level as any || "MEDIUM",
              description: `Suspicion score ${score}% — Tab switches: ${body.tabSwitchCount ?? 0}`,
              isAutoGenerated: true,
            },
          });
        }
      }

      return reply.send({ success: true, data: { suspicionScore: score } });
    }
  );

  // ── POST /admin/live-monitoring/activity ──────────────────
  app.post("/admin/live-monitoring/activity",
    { preHandler: [authenticate, requireCapability('onlineExams.liveMonitoring')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { scheduleId: number; studentId: number; eventType: string; metadata?: any; };

      await prisma.examActivityEvent.create({
        data: {
          schoolId, scheduleId: body.scheduleId, studentId: body.studentId,
          eventType: body.eventType as any, metadata: body.metadata ?? null,
        },
      });

      return reply.send({ success: true });
    }
  );

  // ── GET /admin/live-monitoring/:scheduleId/alerts ─────────
  app.get("/admin/live-monitoring/:scheduleId/alerts",
    { preHandler: [authenticate, requireCapability('onlineExams.liveMonitoring')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { scheduleId } = req.params as { scheduleId: string };

      const [incidents, suspicious] = await Promise.all([
        prisma.examIncident.findMany({
          where: { scheduleId: parseInt(scheduleId), schoolId, isResolved: false },
          orderBy: { occurredAt: "desc" },
          include: { student: { include: { user: { select: { name: true } } } } },
        }),
        prisma.examCandidateState.findMany({
          where: { scheduleId: parseInt(scheduleId), schoolId, suspicionScore: { gt: 25 } },
          orderBy: { suspicionScore: "desc" },
          include: { student: { include: { user: { select: { name: true } } } } },
          take: 10,
        }),
      ]);

      return reply.send({ success: true, data: { incidents, suspicious } });
    }
  );

  // ── POST /admin/live-monitoring/:scheduleId/broadcast ─────
  app.post("/admin/live-monitoring/:scheduleId/broadcast",
    { preHandler: [authenticate, requireCapability('onlineExams.liveMonitoring')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { scheduleId } = req.params as { scheduleId: string };
      const { message, isEmergency } = req.body as { message: string; isEmergency?: boolean };

      if (!message?.trim()) return reply.status(400).send({ success: false, message: "Message required." });

      const broadcast = await prisma.examBroadcast.create({
        data: { schoolId, scheduleId: parseInt(scheduleId), message: message.trim(), isEmergency: isEmergency ?? false, sentById: userId },
      });

      return reply.send({ success: true, message: "Broadcast sent.", data: { broadcastId: broadcast.id } });
    }
  );

  // ── GET /admin/live-monitoring/:scheduleId/broadcasts ─────
  app.get("/admin/live-monitoring/:scheduleId/broadcasts",
    { preHandler: [authenticate, requireCapability('onlineExams.liveMonitoring')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { scheduleId } = req.params as { scheduleId: string };

      const broadcasts = await prisma.examBroadcast.findMany({
        where: { scheduleId: parseInt(scheduleId), schoolId },
        orderBy: { sentAt: "desc" },
        take: 20,
        include: { sentBy: { select: { name: true } } },
      });

      return reply.send({ success: true, data: { broadcasts } });
    }
  );

  // ── POST /admin/live-monitoring/:scheduleId/control ───────
  // Admin actions: extend, pause, resume, force-submit, block
  app.post("/admin/live-monitoring/:scheduleId/control",
    { preHandler: [authenticate, requireCapability('onlineExams.liveMonitoring')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { scheduleId } = req.params as { scheduleId: string };
      const body = req.body as {
        action: "EXTEND" | "PAUSE" | "RESUME" | "FORCE_SUBMIT" | "BLOCK" | "UNBLOCK";
        studentIds: number[]; extendMins?: number; reason?: string;
      };

      const sid = parseInt(scheduleId);
      let message = "";

      switch (body.action) {
        case "EXTEND":
          await prisma.examCandidateState.updateMany({
            where: { scheduleId: sid, studentId: { in: body.studentIds } },
            data: { isExtended: true, extensionMins: { increment: body.extendMins ?? 10 } },
          });
          message = `Time extended by ${body.extendMins ?? 10} mins for ${body.studentIds.length} student(s).`;
          break;
        case "PAUSE":
          await prisma.examCandidateState.updateMany({
            where: { scheduleId: sid, studentId: { in: body.studentIds } },
            data: { isPaused: true, status: "PAUSED" },
          });
          message = `Exam paused for ${body.studentIds.length} student(s).`;
          break;
        case "RESUME":
          await prisma.examCandidateState.updateMany({
            where: { scheduleId: sid, studentId: { in: body.studentIds } },
            data: { isPaused: false, status: "ACTIVE" },
          });
          message = "Exam resumed.";
          break;
        case "FORCE_SUBMIT":
          await prisma.examCandidateState.updateMany({
            where: { scheduleId: sid, studentId: { in: body.studentIds } },
            data: { status: "SUBMITTED", submittedAt: new Date() },
          });
          await prisma.testAttemptRecord.updateMany({
            where: { scheduleId: sid, studentId: { in: body.studentIds }, status: "IN_PROGRESS" },
            data: { status: "SUBMITTED", submittedAt: new Date(), isForceSubmitted: true },
          });
          message = `Force submitted for ${body.studentIds.length} student(s).`;
          break;
        case "BLOCK":
          await prisma.examCandidateState.updateMany({
            where: { scheduleId: sid, studentId: { in: body.studentIds } },
            data: { isBlocked: true, status: "DISCONNECTED" },
          });
          message = `${body.studentIds.length} student(s) blocked.`;
          break;
        case "UNBLOCK":
          await prisma.examCandidateState.updateMany({
            where: { scheduleId: sid, studentId: { in: body.studentIds } },
            data: { isBlocked: false },
          });
          message = "Student(s) unblocked.";
          break;
      }

      // Log activity events
      for (const studentId of body.studentIds) {
        await prisma.examActivityEvent.create({
          data: {
            schoolId, scheduleId: sid, studentId,
            eventType: body.action === "EXTEND" ? "TIME_EXTENDED" : body.action === "PAUSE" ? "EXAM_PAUSED" : body.action === "RESUME" ? "EXAM_RESUMED" : body.action === "FORCE_SUBMIT" ? "FORCE_SUBMITTED" : "EXAM_PAUSED",
            metadata: { action: body.action, reason: body.reason, doneBy: userId },
            isAutoGenerated: false,
          },
        });
      }

      return reply.send({ success: true, message });
    }
  );

  // ── GET /admin/live-monitoring/:scheduleId/analytics ──────
  app.get("/admin/live-monitoring/:scheduleId/analytics",
    { preHandler: [authenticate, requireCapability('onlineExams.liveMonitoring')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { scheduleId } = req.params as { scheduleId: string };
      const sid = parseInt(scheduleId);

      const states = await prisma.examCandidateState.findMany({ where: { scheduleId: sid, schoolId } });

      const statusDist = states.reduce((acc, s) => {
        acc[s.status] = (acc[s.status] ?? 0) + 1; return acc;
      }, {} as Record<string, number>);

      const avgProgress = states.length > 0
        ? Math.round(states.reduce((s, c) => s + Number(c.progressPercent), 0) / states.length * 10) / 10 : 0;

      const submittedStates = states.filter(s => s.status === "SUBMITTED");

      // Submission timeline (last 30 events)
      const timeline = await prisma.examActivityEvent.findMany({
        where: { scheduleId: sid, schoolId },
        orderBy: { occurredAt: "asc" },
        take: 50,
        include: { student: { include: { user: { select: { name: true } } } } },
      });

      // Suspicious students
      const suspicious = states.filter(s => s.suspicionScore > 25)
        .sort((a, b) => b.suspicionScore - a.suspicionScore)
        .slice(0, 5);

      return reply.send({
        success: true,
        data: {
          statusDist,
          avgProgress,
          totalStates: states.length,
          submitted: submittedStates.length,
          inProgress: states.filter(s => s.status === "ACTIVE" || s.status === "IDLE").length,
          suspicious: suspicious.length,
          timeline: timeline.map(t => ({
            eventType: t.eventType, studentName: t.student.user.name,
            occurredAt: t.occurredAt, severity: t.severity,
          })),
          topSuspicious: suspicious,
        },
      });
    }
  );

  // ── POST /admin/live-monitoring/:scheduleId/incident ──────
  app.post("/admin/live-monitoring/:scheduleId/incident",
    { preHandler: [authenticate, requireCapability('onlineExams.liveMonitoring')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { scheduleId } = req.params as { scheduleId: string };
      const body = req.body as {
        studentId?: number; incidentType: string;
        severity: string; description: string; actionTaken?: string;
      };

      const incident = await prisma.examIncident.create({
        data: {
          schoolId, scheduleId: parseInt(scheduleId),
          studentId: body.studentId ?? null,
          incidentType: body.incidentType as any,
          severity: body.severity as any,
          description: body.description,
          actionTaken: body.actionTaken ?? null,
          reportedById: userId,
        },
      });

      return reply.status(201).send({ success: true, message: "Incident reported.", data: { incidentId: incident.id } });
    }
  );

  // ── PATCH /admin/live-monitoring/incident/:id/resolve ─────
  app.patch("/admin/live-monitoring/incident/:id/resolve",
    { preHandler: [authenticate, requireCapability('onlineExams.liveMonitoring')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { actionTaken } = req.body as { actionTaken?: string };

      await prisma.examIncident.updateMany({
        where: { id: parseInt(id), schoolId },
        data: { isResolved: true, resolvedAt: new Date(), ...(actionTaken && { actionTaken }) },
      });
      return reply.send({ success: true, message: "Incident resolved." });
    }
  );
}
