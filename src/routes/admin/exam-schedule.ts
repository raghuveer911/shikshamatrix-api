import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── Helpers ──────────────────────────────────────────────────
function timeToMins(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function calcDuration(start: string, end: string): number {
  return timeToMins(end) - timeToMins(start);
}
function getDayOfWeek(date: Date): number {
  const d = date.getDay();
  return d === 0 ? 7 : d; // Sun=7, Mon=1...
}
function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function isSunday(date: Date): boolean {
  return date.getDay() === 0;
}

export async function adminExamScheduleRoutes(app: FastifyInstance) {

  // ── GET /admin/exam-schedule/meta ─────────────────────────
  app.get("/admin/exam-schedule/meta",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const [examConfigs, classes, staff, holidays, stats] = await Promise.all([
        prisma.examConfig.findMany({
          where: { schoolId, status: { in: ["ACTIVE", "PUBLISHED"] } },
          orderBy: { createdAt: "desc" },
          select: {
            id: true, name: true, sessionName: true, category: true,
            classes: {
              include: {
                class: { select: { id: true, name: true } },
                subjects: { include: { subject: { select: { id: true, name: true } } } },
              },
            },
          },
        }),
        prisma.class.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          select: { id: true, name: true, classNumber: true, section: true,
            subjects: { where: { isActive: true }, select: { id: true, name: true } } },
        }),
        prisma.staff.findMany({
          where: { schoolId, isActive: true },
          include: { user: { select: { id: true, name: true } } },
          orderBy: { user: { name: "asc" } },
        }),
        prisma.holiday.findMany({
          where: { schoolId, date: { gte: new Date() } },
          select: { date: true, name: true },
          orderBy: { date: "asc" },
        }),
        // Stats
        (async () => {
          const [total, published, pending, conflicts] = await Promise.all([
            prisma.examSchedule.count({ where: { schoolId } }),
            prisma.examSchedule.count({ where: { schoolId, status: "PUBLISHED" } }),
            prisma.examSlot.count({ where: { schoolId, isPublished: false } }),
            prisma.examSlot.count({ where: { schoolId, hasConflict: true } }),
          ]);
          return { total, published, pending, conflicts };
        })(),
      ]);

      return reply.send({ success: true, data: { examConfigs, classes, staff, holidays, stats } });
    }
  );

  // ── GET /admin/exam-schedule ──────────────────────────────
  app.get("/admin/exam-schedule",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { page?: string; status?: string; examConfigId?: string; };

      const page = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 12;

      const where: any = { schoolId };
      if (q.status) where.status = q.status;
      if (q.examConfigId) where.examConfigId = parseInt(q.examConfigId);

      const [schedules, total] = await Promise.all([
        prisma.examSchedule.findMany({
          where, skip: (page-1)*limit, take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            examConfig: { select: { name: true, category: true } },
            createdBy: { select: { name: true } },
            _count: { select: { slots: true } },
          },
        }),
        prisma.examSchedule.count({ where }),
      ]);

      // Stats refresh
      const [totalCount, published, pending, conflicts] = await Promise.all([
        prisma.examSchedule.count({ where: { schoolId } }),
        prisma.examSchedule.count({ where: { schoolId, status: "PUBLISHED" } }),
        prisma.examSlot.count({ where: { schoolId, isPublished: false } }),
        prisma.examSlot.count({ where: { schoolId, hasConflict: true } }),
      ]);

      return reply.send({
        success: true,
        data: {
          schedules, total, totalPages: Math.ceil(total / limit),
          stats: { total: totalCount, published, pending, conflicts },
        },
      });
    }
  );

  // ── GET /admin/exam-schedule/:id ──────────────────────────
  app.get("/admin/exam-schedule/:id",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const schedule = await prisma.examSchedule.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          examConfig: { select: { id: true, name: true, category: true } },
          createdBy: { select: { name: true } },
          slots: {
            orderBy: [{ examDate: "asc" }, { startTime: "asc" }],
            include: {
              subject: { select: { id: true, name: true } },
              class: { select: { id: true, name: true } },
              invigilator: { include: { user: { select: { id: true, name: true } } } },
            },
          },
        },
      });

      if (!schedule) return reply.status(404).send({ success: false, message: "Schedule not found." });
      return reply.send({ success: true, data: { schedule } });
    }
  );

  // ── POST /admin/exam-schedule ─────────────────────────────
  app.post("/admin/exam-schedule",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        examConfigId: number;
        title: string;
        sessionName: string;
        defaultStartTime?: string;
        defaultEndTime?: string;
        minGapDays?: number;
      };

      if (!body.examConfigId || !body.title) {
        return reply.status(400).send({ success: false, message: "examConfigId and title required." });
      }

      const schedule = await prisma.examSchedule.create({
        data: {
          schoolId,
          examConfigId: body.examConfigId,
          title: body.title.trim(),
          sessionName: body.sessionName,
          status: "DRAFT",
          defaultStartTime: body.defaultStartTime ?? "10:00",
          defaultEndTime: body.defaultEndTime ?? "13:00",
          minGapDays: body.minGapDays ?? 1,
          createdById: userId,
        },
      });

      return reply.status(201).send({ success: true, message: "Schedule created.", data: { scheduleId: schedule.id } });
    }
  );

  // ── POST /admin/exam-schedule/:id/slot ────────────────────
  app.post("/admin/exam-schedule/:id/slot",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as {
        examDate: string;
        subjectId: number;
        classId: number;
        slotType?: string;
        startTime: string;
        endTime: string;
        roomNumber?: string;
        roomCapacity?: number;
        invigilatorId?: number;
        backupInvigilatorId?: number;
        instructions?: string;
      };

      const schedule = await prisma.examSchedule.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!schedule) return reply.status(404).send({ success: false, message: "Schedule not found." });

      const examDate = new Date(body.examDate);
      examDate.setHours(0, 0, 0, 0);
      const duration = calcDuration(body.startTime, body.endTime);
      const dayOfWeek = getDayOfWeek(examDate);

      // Check Sunday
      if (isSunday(examDate)) {
        return reply.status(400).send({ success: false, message: "Cannot schedule exam on Sunday." });
      }

      // Check holiday
      const holiday = await prisma.holiday.findFirst({
        where: { schoolId, date: { gte: examDate, lte: new Date(examDate.getTime() + 86399999) } },
      });
      if (holiday) {
        return reply.status(400).send({ success: false, message: `${holiday.name} is a holiday on this date.` });
      }

      // Conflict detection
      let hasConflict = false;
      const conflicts: string[] = [];

      // Same class same date
      const classConflict = await prisma.examSlot.findFirst({
        where: { schoolId, scheduleId: parseInt(id), classId: body.classId, examDate },
        include: { subject: { select: { name: true } } },
      });
      if (classConflict) {
        conflicts.push(`Class already has ${classConflict.subject.name} exam on this date`);
        hasConflict = true;
      }

      // Same subject duplicate in this schedule
      const subjectDuplicate = await prisma.examSlot.findFirst({
        where: { schoolId, scheduleId: parseInt(id), subjectId: body.subjectId, classId: body.classId },
      });
      if (subjectDuplicate) {
        return reply.status(409).send({ success: false, error: "DUPLICATE_SUBJECT", message: "This subject is already scheduled for this class." });
      }

      // Invigilator conflict
      if (body.invigilatorId) {
        const invilConflict = await prisma.examSlot.findFirst({
          where: {
            schoolId, invigilatorId: body.invigilatorId,
            examDate,
            startTime: { lte: body.endTime },
            endTime: { gte: body.startTime },
          },
          include: { class: { select: { name: true } } },
        });
        if (invilConflict) {
          conflicts.push(`Invigilator already assigned to Class ${invilConflict.class.name}`);
          hasConflict = true;
        }
      }

      // Room conflict
      if (body.roomNumber) {
        const roomConflict = await prisma.examSlot.findFirst({
          where: {
            schoolId, roomNumber: body.roomNumber,
            examDate,
            startTime: { lte: body.endTime },
            endTime: { gte: body.startTime },
          },
        });
        if (roomConflict) {
          conflicts.push(`Room ${body.roomNumber} is already booked at this time`);
          hasConflict = true;
        }
      }

      const slot = await prisma.examSlot.create({
        data: {
          scheduleId: parseInt(id),
          schoolId,
          examDate,
          dayOfWeek,
          subjectId: body.subjectId,
          classId: body.classId,
          slotType: body.slotType as any ?? "THEORY",
          startTime: body.startTime,
          endTime: body.endTime,
          duration,
          roomNumber: body.roomNumber ?? null,
          roomCapacity: body.roomCapacity ?? null,
          invigilatorId: body.invigilatorId ?? null,
          backupInvigilatorId: body.backupInvigilatorId ?? null,
          instructions: body.instructions ?? null,
          hasConflict,
        },
        include: {
          subject: { select: { id: true, name: true } },
          class: { select: { id: true, name: true } },
        },
      });

      return reply.status(201).send({
        success: true,
        message: conflicts.length ? `Slot added with ${conflicts.length} conflict(s).` : "Slot added.",
        data: { slot, conflicts },
        hasConflict,
      });
    }
  );

  // ── PUT /admin/exam-schedule/:id/slot/:slotId ─────────────
  app.put("/admin/exam-schedule/:id/slot/:slotId",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id, slotId } = request.params as { id: string; slotId: string };
      const body = request.body as any;

      const slot = await prisma.examSlot.findFirst({ where: { id: parseInt(slotId), schoolId, scheduleId: parseInt(id) } });
      if (!slot) return reply.status(404).send({ success: false, message: "Slot not found." });

      const updated = await prisma.examSlot.update({
        where: { id: parseInt(slotId) },
        data: {
          ...(body.examDate && { examDate: new Date(body.examDate), dayOfWeek: getDayOfWeek(new Date(body.examDate)) }),
          ...(body.startTime && { startTime: body.startTime }),
          ...(body.endTime && { endTime: body.endTime }),
          ...(body.startTime && body.endTime && { duration: calcDuration(body.startTime, body.endTime) }),
          ...(body.roomNumber !== undefined && { roomNumber: body.roomNumber }),
          ...(body.invigilatorId !== undefined && { invigilatorId: body.invigilatorId }),
          ...(body.instructions !== undefined && { instructions: body.instructions }),
          ...(body.slotType && { slotType: body.slotType }),
        },
        include: {
          subject: { select: { id: true, name: true } },
          class: { select: { id: true, name: true } },
        },
      });

      return reply.send({ success: true, message: "Slot updated.", data: { slot: updated } });
    }
  );

  // ── DELETE /admin/exam-schedule/:id/slot/:slotId ──────────
  app.delete("/admin/exam-schedule/:id/slot/:slotId",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id, slotId } = request.params as { id: string; slotId: string };

      await prisma.examSlot.deleteMany({ where: { id: parseInt(slotId), schoolId, scheduleId: parseInt(id) } });
      return reply.send({ success: true, message: "Slot removed." });
    }
  );

  // ── POST /admin/exam-schedule/:id/auto-generate ───────────
  app.post("/admin/exam-schedule/:id/auto-generate",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as {
        startDate: string;
        classIds: number[];
        subjectIds?: number[];
        minGapDays?: number;
      };

      const schedule = await prisma.examSchedule.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          examConfig: {
            include: {
              classes: {
                include: { subjects: { include: { subject: { select: { id: true, name: true } } } } },
              },
            },
          },
        },
      });
      if (!schedule) return reply.status(404).send({ success: false, message: "Schedule not found." });

      // Fetch holidays for conflict avoidance
      const holidays = await prisma.holiday.findMany({
        where: { schoolId },
        select: { date: true },
      });
      const holidayDates = new Set(holidays.map(h => h.date.toISOString().split("T")[0]));

      const minGap = body.minGapDays ?? schedule.minGapDays ?? 1;
      let currentDate = new Date(body.startDate);
      let slotsCreated = 0;

      // Get subjects for selected classes
      const subjectsToSchedule: { subjectId: number; subjectName: string; classId: number; className: string }[] = [];
      for (const cls of schedule.examConfig.classes) {
        if (body.classIds.includes(cls.classId)) {
          for (const sub of cls.subjects) {
            if (!body.subjectIds || body.subjectIds.includes(sub.subjectId)) {
              subjectsToSchedule.push({ subjectId: sub.subjectId, subjectName: sub.subject.name, classId: cls.classId, className: cls.class?.name ?? "" });
            }
          }
        }
      }

      // Find unique dates needed
      const usedDates: string[] = [];
      const createdSlots = [];

      for (const sub of subjectsToSchedule) {
        // Find next valid date
        let tries = 0;
        while (tries < 60) {
          const dateStr = currentDate.toISOString().split("T")[0];
          const isHoliday = holidayDates.has(dateStr);
          const isSun = isSunday(currentDate);

          if (!isHoliday && !isSun) {
            // Check if this class already has exam on this date
            const existing = await prisma.examSlot.findFirst({
              where: { schoolId, scheduleId: parseInt(id), classId: sub.classId, examDate: currentDate },
            });

            if (!existing) {
              const slot = await prisma.examSlot.create({
                data: {
                  scheduleId: parseInt(id), schoolId,
                  examDate: new Date(currentDate), dayOfWeek: getDayOfWeek(currentDate),
                  subjectId: sub.subjectId, classId: sub.classId,
                  slotType: "THEORY",
                  startTime: schedule.defaultStartTime ?? "10:00",
                  endTime: schedule.defaultEndTime ?? "13:00",
                  duration: calcDuration(schedule.defaultStartTime ?? "10:00", schedule.defaultEndTime ?? "13:00"),
                  hasConflict: false,
                },
              });
              createdSlots.push(slot);
              slotsCreated++;

              // Advance date by gap
              for (let g = 0; g < minGap; g++) {
                currentDate = addDays(currentDate, 1);
                while (isSunday(currentDate) || holidayDates.has(currentDate.toISOString().split("T")[0])) {
                  currentDate = addDays(currentDate, 1);
                }
              }
              break;
            }
          }
          currentDate = addDays(currentDate, 1);
          tries++;
        }
      }

      return reply.send({
        success: true,
        message: `${slotsCreated} exam slots auto-generated.`,
        data: { slotsCreated },
      });
    }
  );

  // ── PATCH /admin/exam-schedule/:id/publish ────────────────
  app.patch("/admin/exam-schedule/:id/publish",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as { teacherVisible?: boolean; studentVisible?: boolean; parentVisible?: boolean };

      const schedule = await prisma.examSchedule.findFirst({
        where: { id: parseInt(id), schoolId },
        include: { _count: { select: { slots: true } } },
      });
      if (!schedule) return reply.status(404).send({ success: false, message: "Not found." });
      if ((schedule as any)._count.slots === 0) return reply.status(400).send({ success: false, message: "No exam slots to publish." });

      // Check for unresolved conflicts
      const conflictCount = await prisma.examSlot.count({
        where: { scheduleId: parseInt(id), hasConflict: true },
      });

      await prisma.$transaction([
        prisma.examSchedule.update({
          where: { id: parseInt(id) },
          data: {
            status: "PUBLISHED",
            publishedAt: new Date(),
            teacherVisible: body.teacherVisible ?? true,
            studentVisible: body.studentVisible ?? false,
            parentVisible: body.parentVisible ?? false,
          },
        }),
        prisma.examSlot.updateMany({
          where: { scheduleId: parseInt(id) },
          data: { isPublished: true },
        }),
      ]);

      return reply.send({
        success: true,
        message: conflictCount > 0 ? `Published with ${conflictCount} conflict(s). Review recommended.` : "Schedule published successfully.",
        warnings: conflictCount > 0 ? [`${conflictCount} conflict(s) exist in schedule`] : [],
      });
    }
  );

  // ── POST /admin/exam-schedule/:id/clone ───────────────────
  app.post("/admin/exam-schedule/:id/clone",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const { id } = request.params as { id: string };
      const { title, offsetDays } = request.body as { title?: string; offsetDays?: number };

      const source = await prisma.examSchedule.findFirst({
        where: { id: parseInt(id), schoolId },
        include: { slots: true },
      });
      if (!source) return reply.status(404).send({ success: false, message: "Not found." });

      const offset = offsetDays ?? 365; // default 1 year shift
      const newSchedule = await prisma.$transaction(async (tx) => {
        const ns = await tx.examSchedule.create({
          data: {
            schoolId, examConfigId: source.examConfigId, createdById: userId,
            title: title ?? `${source.title} (Copy)`,
            sessionName: source.sessionName, status: "DRAFT",
            defaultStartTime: source.defaultStartTime, defaultEndTime: source.defaultEndTime,
            minGapDays: source.minGapDays,
          },
        });

        for (const slot of source.slots) {
          const newDate = addDays(slot.examDate, offset);
          await tx.examSlot.create({
            data: {
              scheduleId: ns.id, schoolId,
              examDate: newDate, dayOfWeek: getDayOfWeek(newDate),
              subjectId: slot.subjectId, classId: slot.classId,
              slotType: slot.slotType, startTime: slot.startTime, endTime: slot.endTime,
              duration: slot.duration, roomNumber: slot.roomNumber,
              instructions: slot.instructions,
              hasConflict: false, isPublished: false,
            },
          });
        }
        return ns;
      });

      return reply.status(201).send({ success: true, message: "Schedule cloned.", data: { scheduleId: newSchedule.id } });
    }
  );

  // ── GET /admin/exam-schedule/:id/conflicts ────────────────
  app.get("/admin/exam-schedule/:id/conflicts",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const conflictSlots = await prisma.examSlot.findMany({
        where: { scheduleId: parseInt(id), schoolId, hasConflict: true },
        include: {
          subject: { select: { name: true } },
          class: { select: { name: true } },
        },
      });

      return reply.send({ success: true, data: { conflicts: conflictSlots, count: conflictSlots.length } });
    }
  );

  // ── DELETE /admin/exam-schedule/:id ───────────────────────
  app.delete("/admin/exam-schedule/:id",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const schedule = await prisma.examSchedule.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!schedule) return reply.status(404).send({ success: false, message: "Not found." });
      if (schedule.status === "PUBLISHED") return reply.status(400).send({ success: false, message: "Cannot delete a published schedule." });

      await prisma.examSchedule.delete({ where: { id: parseInt(id) } });
      return reply.send({ success: true, message: "Schedule deleted." });
    }
  );
}
