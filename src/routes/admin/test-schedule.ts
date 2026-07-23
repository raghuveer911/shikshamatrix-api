import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

export async function adminTestSchedulingRoutes(app: FastifyInstance) {

  // ── GET /admin/test-schedule/meta ─────────────────────────
  app.get("/admin/test-schedule/meta",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [exams, classes, dashStats] = await Promise.all([
        prisma.onlineExam.findMany({
          where: { schoolId, status: { in: ["PUBLISHED","READY","SCHEDULED"] } },
          orderBy: { createdAt: "desc" },
          select: {
            id: true, name: true, examCode: true, totalQuestions: true,
            totalMarks: true, duration: true, category: true,
            applicableClasses: true,
            subject: { select: { name: true } },
          },
        }),
        prisma.class.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          select: { id: true, name: true, classNumber: true, section: true },
        }),
        (async () => {
          const now = new Date();
          const [total, upcoming, live, completed, draft, expired] = await Promise.all([
            prisma.testSchedule.count({ where: { schoolId } }),
            prisma.testSchedule.count({ where: { schoolId, status: "PUBLISHED", startTime: { gt: now } } }),
            prisma.testSchedule.count({ where: { schoolId, status: "LIVE" } }),
            prisma.testSchedule.count({ where: { schoolId, status: "COMPLETED" } }),
            prisma.testSchedule.count({ where: { schoolId, status: "DRAFT" } }),
            prisma.testSchedule.count({ where: { schoolId, status: "EXPIRED" } }),
          ]);
          return { total, upcoming, live, completed, draft, expired };
        })(),
      ]);

      return reply.send({ success: true, data: { exams, classes, dashStats } });
    }
  );

  // ── GET /admin/test-schedule ──────────────────────────────
  app.get("/admin/test-schedule",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as {
        page?: string; status?: string; examId?: string;
        classId?: string; search?: string;
        from?: string; to?: string;
      };

      const page  = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 15;
      const where: any = { schoolId };

      if (q.status)  where.status  = q.status;
      if (q.examId)  where.examId  = parseInt(q.examId);
      if (q.from || q.to) {
        where.startTime = {};
        if (q.from) where.startTime.gte = new Date(q.from);
        if (q.to)   where.startTime.lte = new Date(q.to);
      }
      if (q.search) {
        const exams = await prisma.onlineExam.findMany({
          where: { schoolId, name: { contains: q.search, mode: "insensitive" } },
          select: { id: true },
        });
        where.examId = { in: exams.map(e => e.id) };
      }

      const [schedules, total] = await Promise.all([
        prisma.testSchedule.findMany({
          where, skip: (page-1)*limit, take: limit,
          orderBy: { startTime: "asc" },
          include: {
            exam: { select: { name: true, examCode: true, totalMarks: true, duration: true, subject: { select: { name: true } } } },
            createdBy: { select: { name: true } },
            _count: { select: { attempts: true } },
          },
        }),
        prisma.testSchedule.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: { schedules, total, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  // ── GET /admin/test-schedule/calendar ─────────────────────
  app.get("/admin/test-schedule/calendar",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { year: string; month: string };

      const year  = parseInt(q.year  ?? String(new Date().getFullYear()));
      const month = parseInt(q.month ?? String(new Date().getMonth() + 1));
      const start = new Date(year, month - 1, 1);
      const end   = new Date(year, month, 0, 23, 59, 59);

      const schedules = await prisma.testSchedule.findMany({
        where: { schoolId, startTime: { gte: start, lte: end }, status: { notIn: ["CANCELLED"] } },
        orderBy: { startTime: "asc" },
        include: { exam: { select: { name: true, subject: { select: { name: true } } } } },
      });

      // Group by date
      const calendarMap: Record<string, any[]> = {};
      schedules.forEach(s => {
        const key = s.startTime.toISOString().split("T")[0];
        if (!calendarMap[key]) calendarMap[key] = [];
        calendarMap[key].push({
          id: s.id, name: s.exam.name, subjectName: s.exam.subject?.name,
          startTime: s.startTime, endTime: s.endTime,
          status: s.status, durationMins: s.durationMins,
        });
      });

      return reply.send({ success: true, data: { calendar: calendarMap, total: schedules.length } });
    }
  );

  // ── GET /admin/test-schedule/:id ──────────────────────────
  app.get("/admin/test-schedule/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const schedule = await prisma.testSchedule.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          exam: {
            select: {
              id: true, name: true, examCode: true, totalMarks: true,
              totalQuestions: true, duration: true, category: true,
              subject: { select: { name: true } },
            },
          },
          createdBy: { select: { name: true } },
          attempts: {
            take: 20,
            orderBy: { startedAt: "desc" },
            include: {
              student: { include: { user: { select: { name: true } } } },
            },
          },
          _count: { select: { attempts: true } },
        },
      });

      if (!schedule) return reply.status(404).send({ success: false, message: "Schedule not found." });

      // Eligible students count
      let eligibleCount = 0;
      if (schedule.accessType === "ALL_ELIGIBLE" && schedule.applicableClasses.length > 0) {
        eligibleCount = await prisma.student.count({
          where: { schoolId, classId: { in: schedule.applicableClasses }, isActive: true },
        });
      } else if (schedule.specificStudents.length > 0) {
        eligibleCount = schedule.specificStudents.length;
      }

      return reply.send({ success: true, data: { schedule, eligibleCount } });
    }
  );

  // ── POST /admin/test-schedule ─────────────────────────────
  app.post("/admin/test-schedule",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        examId: number;
        applicableClasses: number[]; applicableSections?: string[];
        specificStudents?: number[]; accessType?: string;
        startTime: string; endTime: string; durationMins: number;
        isFlexibleWindow?: boolean; isFixedStart?: boolean; bufferMins?: number;
        recurringType?: string; recurringEndDate?: string;
        maxAttempts?: number; allowReattempt?: boolean;
        allowResume?: boolean; allowPause?: boolean; deviceRestriction?: string;
        resultVisibility?: string; showAnswers?: string;
        showExplanations?: boolean; showRank?: boolean; showLeaderboard?: boolean;
        notifyStudents?: boolean; notifyParents?: boolean; notifyTeachers?: boolean;
        reminder1Day?: boolean; reminder1Hour?: boolean; reminder15Min?: boolean;
        fullScreenMode?: boolean; tabSwitchDetect?: boolean; maxTabSwitches?: number;
        refreshDetect?: boolean; preventMultiLogin?: boolean; singleDeviceOnly?: boolean;
        rightClickDisable?: boolean; copyPasteRestrict?: boolean;
      };

      if (!body.examId || !body.startTime || !body.endTime) {
        return reply.status(400).send({ success: false, message: "examId, startTime and endTime required." });
      }

      const startDt = new Date(body.startTime);
      const endDt   = new Date(body.endTime);

      if (endDt <= startDt) {
        return reply.status(400).send({ success: false, message: "End time must be after start time." });
      }

      // Clash detection
      const clash = await prisma.testSchedule.findFirst({
        where: {
          schoolId, status: { notIn: ["CANCELLED","EXPIRED"] },
          applicableClasses: { hasSome: body.applicableClasses },
          OR: [
            { startTime: { gte: startDt, lt: endDt } },
            { endTime:   { gt: startDt, lte: endDt } },
            { startTime: { lte: startDt }, endTime: { gte: endDt } },
          ],
        },
        include: { exam: { select: { name: true } } },
      });

      const schedule = await prisma.testSchedule.create({
        data: {
          schoolId, createdById: userId,
          examId: body.examId,
          applicableClasses: body.applicableClasses ?? [],
          applicableSections: body.applicableSections ?? [],
          specificStudents: body.specificStudents ?? [],
          accessType: body.accessType as any ?? "ALL_ELIGIBLE",
          startTime: startDt, endTime: endDt,
          durationMins: body.durationMins,
          isFlexibleWindow: body.isFlexibleWindow ?? false,
          isFixedStart:     body.isFixedStart     ?? false,
          bufferMins:       body.bufferMins        ?? 0,
          recurringType:    body.recurringType as any ?? "NONE",
          recurringEndDate: body.recurringEndDate ? new Date(body.recurringEndDate) : null,
          maxAttempts:      body.maxAttempts       ?? 1,
          allowReattempt:   body.allowReattempt    ?? false,
          allowResume:      body.allowResume       ?? false,
          allowPause:       body.allowPause        ?? false,
          deviceRestriction: body.deviceRestriction as any ?? "ANY",
          resultVisibility:  body.resultVisibility as any  ?? "AFTER_SUBMISSION",
          showAnswers:       body.showAnswers as any       ?? "AFTER_EXAM_ENDS",
          showExplanations:  body.showExplanations  ?? true,
          showRank:          body.showRank           ?? true,
          showLeaderboard:   body.showLeaderboard    ?? false,
          notifyStudents:    body.notifyStudents     ?? true,
          notifyParents:     body.notifyParents      ?? false,
          notifyTeachers:    body.notifyTeachers     ?? true,
          reminder1Day:      body.reminder1Day       ?? true,
          reminder1Hour:     body.reminder1Hour      ?? true,
          reminder15Min:     body.reminder15Min      ?? false,
          fullScreenMode:    body.fullScreenMode     ?? false,
          tabSwitchDetect:   body.tabSwitchDetect    ?? false,
          maxTabSwitches:    body.maxTabSwitches      ?? 3,
          refreshDetect:     body.refreshDetect      ?? false,
          preventMultiLogin: body.preventMultiLogin  ?? false,
          singleDeviceOnly:  body.singleDeviceOnly   ?? false,
          rightClickDisable: body.rightClickDisable  ?? false,
          copyPasteRestrict: body.copyPasteRestrict  ?? false,
          status: "DRAFT",
        },
      });

      return reply.status(201).send({
        success: true,
        message: "Schedule created.",
        data: { scheduleId: schedule.id, clash: clash ? { examName: clash.exam.name } : null },
      });
    }
  );

  // ── PUT /admin/test-schedule/:id ──────────────────────────
  app.put("/admin/test-schedule/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const body = req.body as any;

      const s = await prisma.testSchedule.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!s) return reply.status(404).send({ success: false, message: "Not found." });
      if (s.status === "LIVE" || s.status === "COMPLETED") {
        return reply.status(400).send({ success: false, message: "Cannot edit a live or completed schedule." });
      }

      await prisma.testSchedule.update({ where: { id: parseInt(id) }, data: {
        ...(body.applicableClasses && { applicableClasses: body.applicableClasses }),
        ...(body.applicableSections && { applicableSections: body.applicableSections }),
        ...(body.specificStudents && { specificStudents: body.specificStudents }),
        ...(body.accessType && { accessType: body.accessType }),
        ...(body.startTime && { startTime: new Date(body.startTime) }),
        ...(body.endTime   && { endTime:   new Date(body.endTime) }),
        ...(body.durationMins !== undefined && { durationMins: body.durationMins }),
        ...(body.isFlexibleWindow !== undefined && { isFlexibleWindow: body.isFlexibleWindow }),
        ...(body.isFixedStart     !== undefined && { isFixedStart:     body.isFixedStart }),
        ...(body.maxAttempts      !== undefined && { maxAttempts:      body.maxAttempts }),
        ...(body.allowResume      !== undefined && { allowResume:      body.allowResume }),
        ...(body.allowPause       !== undefined && { allowPause:       body.allowPause }),
        ...(body.deviceRestriction && { deviceRestriction: body.deviceRestriction }),
        ...(body.resultVisibility  && { resultVisibility:  body.resultVisibility }),
        ...(body.showAnswers       && { showAnswers:       body.showAnswers }),
        ...(body.showExplanations  !== undefined && { showExplanations:  body.showExplanations }),
        ...(body.showRank          !== undefined && { showRank:          body.showRank }),
        ...(body.showLeaderboard   !== undefined && { showLeaderboard:   body.showLeaderboard }),
        ...(body.notifyStudents    !== undefined && { notifyStudents:    body.notifyStudents }),
        ...(body.notifyParents     !== undefined && { notifyParents:     body.notifyParents }),
        ...(body.notifyTeachers    !== undefined && { notifyTeachers:    body.notifyTeachers }),
        ...(body.fullScreenMode    !== undefined && { fullScreenMode:    body.fullScreenMode }),
        ...(body.tabSwitchDetect   !== undefined && { tabSwitchDetect:   body.tabSwitchDetect }),
        ...(body.maxTabSwitches    !== undefined && { maxTabSwitches:    body.maxTabSwitches }),
        ...(body.refreshDetect     !== undefined && { refreshDetect:     body.refreshDetect }),
        ...(body.preventMultiLogin !== undefined && { preventMultiLogin: body.preventMultiLogin }),
        ...(body.singleDeviceOnly  !== undefined && { singleDeviceOnly:  body.singleDeviceOnly }),
        ...(body.rightClickDisable !== undefined && { rightClickDisable: body.rightClickDisable }),
        ...(body.copyPasteRestrict !== undefined && { copyPasteRestrict: body.copyPasteRestrict }),
        ...(body.status            && { status: body.status }),
      }});

      return reply.send({ success: true, message: "Schedule updated." });
    }
  );

  // ── PATCH /admin/test-schedule/:id/publish ────────────────
  app.patch("/admin/test-schedule/:id/publish",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const s = await prisma.testSchedule.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!s) return reply.status(404).send({ success: false, message: "Not found." });
      if (s.applicableClasses.length === 0 && s.specificStudents.length === 0) {
        return reply.status(400).send({ success: false, message: "Assign classes or students before publishing." });
      }

      // Count eligible
      let eligible = 0;
      if (s.accessType === "ALL_ELIGIBLE" && s.applicableClasses.length > 0) {
        eligible = await prisma.student.count({ where: { schoolId, classId: { in: s.applicableClasses }, isActive: true } });
      } else {
        eligible = s.specificStudents.length;
      }

      await prisma.testSchedule.update({
        where: { id: parseInt(id) },
        data: { status: "PUBLISHED", publishedAt: new Date(), totalEligible: eligible },
      });

      return reply.send({ success: true, message: "Schedule published.", data: { eligible } });
    }
  );

  // ── PATCH /admin/test-schedule/:id/cancel ─────────────────
  app.patch("/admin/test-schedule/:id/cancel",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason?: string };

      await prisma.testSchedule.updateMany({
        where: { id: parseInt(id), schoolId },
        data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason ?? "Cancelled by admin" },
      });
      return reply.send({ success: true, message: "Schedule cancelled." });
    }
  );

  // ── PATCH /admin/test-schedule/:id/extend ─────────────────
  app.patch("/admin/test-schedule/:id/extend",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { mins } = req.body as { mins: number };

      const s = await prisma.testSchedule.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!s) return reply.status(404).send({ success: false, message: "Not found." });

      const newEnd = new Date(s.endTime.getTime() + mins * 60 * 1000);
      await prisma.testSchedule.update({
        where: { id: parseInt(id) },
        data: { endTime: newEnd, isExtended: true, extendedByMins: s.extendedByMins + mins },
      });

      return reply.send({ success: true, message: `Extended by ${mins} minutes.` });
    }
  );

  // ── PATCH /admin/test-schedule/:id/go-live ────────────────
  app.patch("/admin/test-schedule/:id/go-live",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      await prisma.testSchedule.updateMany({
        where: { id: parseInt(id), schoolId, status: "PUBLISHED" },
        data: { status: "LIVE" },
      });
      return reply.send({ success: true, message: "Exam is now LIVE." });
    }
  );

  // ── PATCH /admin/test-schedule/:id/complete ───────────────
  app.patch("/admin/test-schedule/:id/complete",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const s = await prisma.testSchedule.findFirst({ where: { id: parseInt(id), schoolId }, include: { _count: { select: { attempts: true } } } });
      if (!s) return reply.status(404).send({ success: false, message: "Not found." });

      const submitted = await prisma.testAttemptRecord.count({ where: { scheduleId: parseInt(id), status: "SUBMITTED" } });
      const missed    = s.totalEligible - submitted;

      await prisma.testSchedule.update({
        where: { id: parseInt(id) },
        data: { status: "COMPLETED", totalSubmitted: submitted, totalMissed: Math.max(0, missed) },
      });
      return reply.send({ success: true, message: "Exam completed." });
    }
  );

  // ── POST /admin/test-schedule/:id/clone ───────────────────
  app.post("/admin/test-schedule/:id/clone",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { newStart, newEnd } = req.body as { newStart: string; newEnd: string };

      const src = await prisma.testSchedule.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!src) return reply.status(404).send({ success: false, message: "Not found." });

      const cloned = await prisma.testSchedule.create({
        data: {
          schoolId, createdById: userId,
          examId: src.examId,
          applicableClasses: src.applicableClasses, applicableSections: src.applicableSections,
          specificStudents: src.specificStudents, accessType: src.accessType,
          startTime: new Date(newStart), endTime: new Date(newEnd),
          durationMins: src.durationMins, isFlexibleWindow: src.isFlexibleWindow,
          isFixedStart: src.isFixedStart, bufferMins: src.bufferMins,
          maxAttempts: src.maxAttempts, allowReattempt: src.allowReattempt,
          allowResume: src.allowResume, allowPause: src.allowPause,
          deviceRestriction: src.deviceRestriction,
          resultVisibility: src.resultVisibility, showAnswers: src.showAnswers,
          showExplanations: src.showExplanations, showRank: src.showRank, showLeaderboard: src.showLeaderboard,
          notifyStudents: src.notifyStudents, notifyParents: src.notifyParents, notifyTeachers: src.notifyTeachers,
          fullScreenMode: src.fullScreenMode, tabSwitchDetect: src.tabSwitchDetect,
          maxTabSwitches: src.maxTabSwitches, refreshDetect: src.refreshDetect,
          preventMultiLogin: src.preventMultiLogin, singleDeviceOnly: src.singleDeviceOnly,
          rightClickDisable: src.rightClickDisable, copyPasteRestrict: src.copyPasteRestrict,
          status: "DRAFT",
        },
      });

      return reply.status(201).send({ success: true, message: "Schedule cloned.", data: { scheduleId: cloned.id } });
    }
  );

  // ── DELETE /admin/test-schedule/:id ───────────────────────
  app.delete("/admin/test-schedule/:id",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const s = await prisma.testSchedule.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!s) return reply.status(404).send({ success: false, message: "Not found." });
      if (s.status === "LIVE") return reply.status(400).send({ success: false, message: "Cannot delete a live schedule." });

      await prisma.testSchedule.delete({ where: { id: parseInt(id) } });
      return reply.send({ success: true, message: "Schedule deleted." });
    }
  );

  // ── GET /admin/test-schedule/live ─────────────────────────
  app.get("/admin/test-schedule/live",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const liveSchedules = await prisma.testSchedule.findMany({
        where: { schoolId, status: { in: ["LIVE","PUBLISHED"] } },
        include: {
          exam: { select: { name: true, subject: { select: { name: true } } } },
          _count: { select: { attempts: true } },
        },
        orderBy: { startTime: "asc" },
      });

      const liveWithStats = await Promise.all(liveSchedules.map(async s => {
        const [inProgress, submitted] = await Promise.all([
          prisma.testAttemptRecord.count({ where: { scheduleId: s.id, status: "IN_PROGRESS" } }),
          prisma.testAttemptRecord.count({ where: { scheduleId: s.id, status: "SUBMITTED" } }),
        ]);
        return { ...s, inProgress, submitted, remaining: Math.max(0, s.totalEligible - inProgress - submitted) };
      }));

      return reply.send({ success: true, data: { live: liveWithStats } });
    }
  );

  // ── GET /admin/test-schedule/analytics ────────────────────
  app.get("/admin/test-schedule/analytics",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { scheduleId?: string };

      if (q.scheduleId) {
        const attempts = await prisma.testAttemptRecord.findMany({
          where: { scheduleId: parseInt(q.scheduleId) },
          select: {
            status: true, percentage: true, timeTakenSecs: true, rank: true,
            student: { include: { user: { select: { name: true } } } },
          },
          orderBy: { percentage: "desc" },
        });

        const submitted = attempts.filter(a => a.status === "SUBMITTED");
        const pcts = submitted.map(a => Number(a.percentage ?? 0));
        const avg  = pcts.length ? Math.round(pcts.reduce((s,c)=>s+c,0)/pcts.length*10)/10 : 0;
        const avgTime = submitted.filter(a=>a.timeTakenSecs).reduce((s,a)=>s+(a.timeTakenSecs??0),0) / Math.max(1,submitted.filter(a=>a.timeTakenSecs).length);

        return reply.send({
          success: true,
          data: {
            total: attempts.length, submitted: submitted.length,
            inProgress: attempts.filter(a=>a.status==="IN_PROGRESS").length,
            missed: attempts.filter(a=>a.status==="NOT_STARTED").length,
            avg, avgTimeSecs: Math.round(avgTime),
            topStudents: submitted.slice(0,5).map(a=>({ name:a.student.user.name, pct:Number(a.percentage??0) })),
          },
        });
      }

      // General analytics
      const [byStatus, recentActivity] = await Promise.all([
        prisma.testSchedule.groupBy({ by: ["status"], where: { schoolId }, _count: true }),
        prisma.testSchedule.findMany({
          where: { schoolId },
          orderBy: { updatedAt: "desc" }, take: 10,
          include: { exam: { select: { name: true } } },
        }),
      ]);

      return reply.send({
        success: true,
        data: {
          byStatus: byStatus.map(b => ({ status: b.status, count: b._count })),
          recent: recentActivity.map(s => ({ id: s.id, name: s.exam.name, status: s.status, start: s.startTime })),
        },
      });
    }
  );
}
