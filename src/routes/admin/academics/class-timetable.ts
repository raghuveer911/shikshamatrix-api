// apps/api/src/routes/admin/class-timetable.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

const SUBJECT_COLORS = [
  "#6366f1","#3b82f6","#10b981","#f59e0b","#ef4444",
  "#8b5cf6","#ec4899","#06b6d4","#84cc16","#f97316",
];
function getSubjectColor(index: number): string {
  return SUBJECT_COLORS[index % SUBJECT_COLORS.length];
}

export async function adminClassTimetableRoutes(app: FastifyInstance) {
  const P = "/admin/class-timetable";

  // ── GET /admin/class-timetable/classes ────────────────────
  app.get(`${P}/classes`, { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { sessionName?: string };

      const currentYear = await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });

      const classes = await prisma.class.findMany({
        where: {
          schoolId, isActive: true,
          ...(q.sessionName ? { academicYear: q.sessionName } : currentYear ? { academicYear: currentYear.name } : {}),
        },
        orderBy: [{ classNumber: "asc" }, { section: "asc" }],
        include: {
          classTeacher: { include: { user: { select: { name: true } } } },
          subjectAssignments: { where: { isActive: true }, include: { subject: { select: { id: true, name: true } } } },
          _count: { select: { students: true, periodSlots: true } },
        },
      });

      const grouped: Record<string, typeof classes> = {};
      classes.forEach(cls => {
        if (!grouped[cls.classNumber]) grouped[cls.classNumber] = [];
        grouped[cls.classNumber].push(cls);
      });

      return reply.send({ success: true, data: { classes, grouped, sessionName: q.sessionName ?? currentYear?.name ?? "" } });
    }
  );

  // ── GET /admin/class-timetable/:classId ───────────────────
  app.get(`${P}/:classId`, { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { classId } = request.params as { classId: string };
      const q = request.query as { sessionName?: string };

      const classIdInt = parseInt(classId);
      if (isNaN(classIdInt)) return reply.status(400).send({ success: false, message: "Invalid classId." });

      const cls = await prisma.class.findFirst({
        where: { id: classIdInt, schoolId },
        include: {
          subjectAssignments: {
            where: { isActive: true },
            include: { subject: { select: { id: true, name: true } }, teacher: { include: { user: { select: { id: true, name: true } } } } },
          },
          classTeacher: { include: { user: { select: { name: true } } } },
        },
      });
      if (!cls) return reply.status(404).send({ success: false, message: "Class not found." });

      const sessionName = q.sessionName ?? cls.academicYear;

      const masterPeriods = await prisma.masterPeriod.findMany({
        where: { schoolId, sessionName, isActive: true },
        orderBy: [{ dayOfWeek: "asc" }, { serialNumber: "asc" }],
      });

      const slots = await prisma.periodSlot.findMany({
        where: { classId: classIdInt, schoolId, academicYear: sessionName },
        include: {
          subject: { select: { id: true, name: true } },
          teacher: { include: { user: { select: { id: true, name: true } } } },
        },
        orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
      });

      const staff = await prisma.staff.findMany({
        where: { schoolId, isActive: true },
        include: { user: { select: { id: true, name: true } } },
        orderBy: { user: { name: "asc" } },
      });

      // Each subjectAssignment already tells us which teacher normally
      // takes this subject for this class — a convenient default when
      // filling a slot, and the source for auto-generate below.
      const subjectsWithColors = cls.subjectAssignments.map((a, i) => ({
        id: a.subject.id, name: a.subject.name, teacher: a.teacher,
        weeklyPeriods: a.weeklyPeriods, color: getSubjectColor(i),
      }));

      const subjectFrequency: Record<number, number> = {};
      slots.forEach(s => { if (s.subjectId) subjectFrequency[s.subjectId] = (subjectFrequency[s.subjectId] ?? 0) + 1; });

      return reply.send({
        success: true,
        data: { class: cls, subjects: subjectsWithColors, masterPeriods, slots, staff, sessionName, subjectFrequency },
      });
    }
  );

  // ── POST /admin/class-timetable/:classId/slot ─────────────
  // Save a single cell — checks BOTH teacher clash and classroom clash
  // before writing, so a conflict is caught here instead of silently
  // double-booking a teacher or a room.
  app.post(`${P}/:classId/slot`, { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { classId } = request.params as { classId: string };
      const body = request.body as {
        dayOfWeek: number; periodNumber: number; startTime: string; duration: number;
        subjectId?: number; teacherId?: number; room?: string; academicYear: string;
        isBreak?: boolean; breakLabel?: string; masterPeriodId?: number;
        overrideConflict?: boolean;
      };

      const classIdInt = parseInt(classId);

      if (body.teacherId && !body.isBreak) {
        const conflict = await prisma.periodSlot.findFirst({
          where: {
            schoolId, teacherId: body.teacherId, dayOfWeek: body.dayOfWeek,
            periodNumber: body.periodNumber, academicYear: body.academicYear, classId: { not: classIdInt },
          },
          include: { class: { select: { name: true } } },
        });
        if (conflict && !body.overrideConflict) {
          return reply.status(409).send({
            success: false, error: "TEACHER_CONFLICT",
            message: `Teacher is already assigned to Class ${conflict.class.name} during this period.`,
          });
        }
      }

      if (body.room?.trim() && !body.isBreak) {
        const roomConflict = await prisma.periodSlot.findFirst({
          where: {
            schoolId, room: body.room.trim(), dayOfWeek: body.dayOfWeek,
            periodNumber: body.periodNumber, academicYear: body.academicYear, classId: { not: classIdInt },
          },
          include: { class: { select: { name: true } } },
        });
        if (roomConflict && !body.overrideConflict) {
          return reply.status(409).send({
            success: false, error: "ROOM_CONFLICT",
            message: `Room ${body.room} is already booked by Class ${roomConflict.class.name} during this period.`,
          });
        }
      }

      const slot = await prisma.periodSlot.upsert({
        where: {
          classId_dayOfWeek_periodNumber_academicYear: {
            classId: classIdInt, dayOfWeek: body.dayOfWeek, periodNumber: body.periodNumber, academicYear: body.academicYear,
          },
        },
        create: {
          schoolId, classId: classIdInt, dayOfWeek: body.dayOfWeek, periodNumber: body.periodNumber,
          startTime: body.startTime, duration: body.duration,
          subjectId: body.subjectId ?? null, teacherId: body.teacherId ?? null, room: body.room?.trim() || null,
          isBreak: body.isBreak ?? false, breakLabel: body.breakLabel ?? null, academicYear: body.academicYear,
        },
        update: {
          subjectId: body.subjectId ?? null, teacherId: body.teacherId ?? null, room: body.room?.trim() || null,
          isBreak: body.isBreak ?? false, breakLabel: body.breakLabel ?? null,
          startTime: body.startTime, duration: body.duration,
        },
        include: {
          subject: { select: { id: true, name: true } },
          teacher: { include: { user: { select: { id: true, name: true } } } },
        },
      });

      return reply.status(201).send({ success: true, message: "Slot saved.", data: { slot } });
    }
  );

  // ── DELETE /admin/class-timetable/:classId/slot ───────────
  app.delete(`${P}/:classId/slot`, { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { classId } = request.params as { classId: string };
      const body = request.body as { dayOfWeek: number; periodNumber: number; academicYear: string };

      await prisma.periodSlot.deleteMany({
        where: { classId: parseInt(classId), schoolId, dayOfWeek: body.dayOfWeek, periodNumber: body.periodNumber, academicYear: body.academicYear },
      });
      return reply.send({ success: true, message: "Slot cleared." });
    }
  );

  // ── POST /admin/class-timetable/:classId/copy ─────────────
  app.post(`${P}/:classId/copy`, { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { classId } = request.params as { classId: string };
      const body = request.body as {
        type: "CLASS" | "DAY"; fromClassId?: number; fromDay?: number; toDay?: number;
        academicYear: string; clearExisting?: boolean;
      };

      let sourceSlots: any[] = [];
      if (body.type === "CLASS" && body.fromClassId) {
        sourceSlots = await prisma.periodSlot.findMany({ where: { classId: body.fromClassId, schoolId, academicYear: body.academicYear } });
      } else if (body.type === "DAY" && body.fromDay !== undefined && body.toDay !== undefined) {
        sourceSlots = await prisma.periodSlot.findMany({ where: { classId: parseInt(classId), schoolId, academicYear: body.academicYear, dayOfWeek: body.fromDay } });
        sourceSlots = sourceSlots.map(s => ({ ...s, dayOfWeek: body.toDay }));
      }

      if (body.clearExisting) {
        if (body.type === "DAY" && body.toDay !== undefined) {
          await prisma.periodSlot.deleteMany({ where: { classId: parseInt(classId), schoolId, academicYear: body.academicYear, dayOfWeek: body.toDay } });
        } else {
          await prisma.periodSlot.deleteMany({ where: { classId: parseInt(classId), schoolId, academicYear: body.academicYear } });
        }
      }

      let copied = 0;
      for (const s of sourceSlots) {
        try {
          await prisma.periodSlot.upsert({
            where: { classId_dayOfWeek_periodNumber_academicYear: { classId: parseInt(classId), dayOfWeek: s.dayOfWeek, periodNumber: s.periodNumber, academicYear: body.academicYear } },
            create: {
              schoolId, classId: parseInt(classId), dayOfWeek: s.dayOfWeek, periodNumber: s.periodNumber,
              startTime: s.startTime, duration: s.duration,
              subjectId: body.type === "CLASS" ? null : s.subjectId,
              teacherId: body.type === "CLASS" ? null : s.teacherId,
              room: body.type === "CLASS" ? null : s.room,
              isBreak: s.isBreak, breakLabel: s.breakLabel, academicYear: body.academicYear,
            },
            update: {
              subjectId: body.type === "CLASS" ? null : s.subjectId,
              teacherId: body.type === "CLASS" ? null : s.teacherId,
              room: body.type === "CLASS" ? null : s.room,
              isBreak: s.isBreak, breakLabel: s.breakLabel,
            },
          });
          copied++;
        } catch { /* skip conflicts */ }
      }
      return reply.send({ success: true, message: `${copied} slots copied.` });
    }
  );

  // ── POST /admin/class-timetable/:classId/auto-generate ───
  // Greedy fill: for every subject assigned to this class, spread its
  // weeklyPeriods count across empty slots — skipping any slot where
  // the teacher or the class already has something, and never
  // double-booking that teacher elsewhere at the same day+period.
  // Not a scheduling solver — a fast first draft the admin then
  // adjusts by hand, which is what most schools actually want.
  app.post(`${P}/:classId/auto-generate`, { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { classId } = request.params as { classId: string };
      const body = request.body as { academicYear: string; clearExisting?: boolean };
      const classIdInt = parseInt(classId);

      const [cls, session, masterPeriods, existingSlots] = await Promise.all([
        prisma.class.findFirst({ where: { id: classIdInt, schoolId } }),
        prisma.academicYear.findFirst({ where: { schoolId, name: body.academicYear } }),
        prisma.masterPeriod.findMany({ where: { schoolId, sessionName: body.academicYear, isActive: true }, orderBy: [{ dayOfWeek: "asc" }, { serialNumber: "asc" }] }),
        prisma.periodSlot.findMany({ where: { schoolId, academicYear: body.academicYear } }),
      ]);
      if (!cls) return reply.status(404).send({ success: false, message: "Class not found." });
      if (!session) return reply.status(404).send({ success: false, message: "Session not found." });

      const assignments = await prisma.subjectAssignment.findMany({
        where: { schoolId, classId: classIdInt, academicYearId: session.id, isActive: true },
      });
      if (assignments.length === 0) return reply.status(400).send({ success: false, message: "No subjects are assigned to this class yet — assign subjects first." });
      if (masterPeriods.length === 0) return reply.status(400).send({ success: false, message: "No periods configured for this session — set up Manage Periods first." });

      if (body.clearExisting) {
        await prisma.periodSlot.deleteMany({ where: { classId: classIdInt, schoolId, academicYear: body.academicYear } });
      }

      // Teacher busy-map across the WHOLE school for this session, so
      // auto-fill never books a teacher into two classes at once.
      const teacherBusy = new Set(
        existingSlots.filter(s => s.classId !== classIdInt || body.clearExisting)
          .map(s => `${s.teacherId}-${s.dayOfWeek}-${s.periodNumber}`)
      );
      const classFilled = new Set(
        (body.clearExisting ? [] : existingSlots.filter(s => s.classId === classIdInt))
          .map(s => `${s.dayOfWeek}-${s.periodNumber}`)
      );

      const teachingPeriods = masterPeriods.filter(p => !p.isBreak);
      let placed = 0, skipped = 0;

      for (const a of assignments) {
        let remaining = a.weeklyPeriods;
        for (const p of teachingPeriods) {
          if (remaining <= 0) break;
          const slotKey = `${p.dayOfWeek}-${p.serialNumber}`;
          if (classFilled.has(slotKey)) continue;
          const teacherKey = `${a.teacherId}-${p.dayOfWeek}-${p.serialNumber}`;
          if (teacherBusy.has(teacherKey)) continue;

          await prisma.periodSlot.create({
            data: {
              schoolId, classId: classIdInt, dayOfWeek: p.dayOfWeek, periodNumber: p.serialNumber,
              startTime: p.name, duration: 40, subjectId: a.subjectId, teacherId: a.teacherId,
              academicYear: body.academicYear,
            },
          });
          classFilled.add(slotKey);
          teacherBusy.add(teacherKey);
          remaining--;
          placed++;
        }
        if (remaining > 0) skipped += remaining;
      }

      return reply.send({
        success: true,
        message: `${placed} period(s) placed${skipped > 0 ? `, ${skipped} couldn't be fit — add more periods or adjust weekly-period counts` : ""}.`,
        data: { placed, skipped },
      });
    }
  );

  // ── GET /admin/class-timetable/teacher-availability ───────
  app.get(`${P}/teacher-availability`, { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { teacherId: string; academicYear: string; dayOfWeek?: string; excludeClassId?: string };

      const slots = await prisma.periodSlot.findMany({
        where: {
          schoolId, teacherId: parseInt(q.teacherId), academicYear: q.academicYear,
          ...(q.dayOfWeek ? { dayOfWeek: parseInt(q.dayOfWeek) } : {}),
          ...(q.excludeClassId ? { classId: { not: parseInt(q.excludeClassId) } } : {}),
        },
        include: { class: { select: { name: true } } },
      });

      const busySlots = slots.map(s => ({ dayOfWeek: s.dayOfWeek, periodNumber: s.periodNumber, className: s.class.name }));
      return reply.send({ success: true, data: { busySlots } });
    }
  );

  // ── GET /admin/class-timetable/stats/:classId ─────────────
  app.get(`${P}/stats/:classId`, { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { classId } = request.params as { classId: string };
      const q = request.query as { academicYear?: string };

      const slots = await prisma.periodSlot.findMany({
        where: { classId: parseInt(classId), schoolId, ...(q.academicYear ? { academicYear: q.academicYear } : {}) },
        include: { subject: { select: { name: true } } },
      });

      const totalSlots = slots.length;
      const filledSlots = slots.filter(s => !s.isBreak && s.subjectId).length;
      const breakSlots = slots.filter(s => s.isBreak).length;
      const emptySlots = slots.filter(s => !s.isBreak && !s.subjectId).length;

      const subjectFreq: Record<string, number> = {};
      slots.filter(s => s.subject).forEach(s => { subjectFreq[s.subject!.name] = (subjectFreq[s.subject!.name] ?? 0) + 1; });

      return reply.send({ success: true, data: { totalSlots, filledSlots, breakSlots, emptySlots, subjectFreq } });
    }
  );

  // ── GET /admin/class-timetable/:classId/export ────────────
  // Structured grid data for PDF/print rendering on the frontend.
  app.get(`${P}/:classId/export`, { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { classId } = request.params as { classId: string };
      const q = request.query as { academicYear: string };

      const cls = await prisma.class.findFirst({ where: { id: parseInt(classId), schoolId } });
      if (!cls) return reply.status(404).send({ success: false, message: "Class not found." });

      const [slots, masterPeriods] = await Promise.all([
        prisma.periodSlot.findMany({
          where: { classId: parseInt(classId), schoolId, academicYear: q.academicYear },
          include: { subject: { select: { name: true } }, teacher: { include: { user: { select: { name: true } } } } },
          orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
        }),
        prisma.masterPeriod.findMany({ where: { schoolId, sessionName: q.academicYear, isActive: true }, orderBy: [{ dayOfWeek: "asc" }, { serialNumber: "asc" }] }),
      ]);

      const grid: Record<number, Record<number, any>> = {};
      for (const s of slots) {
        if (!grid[s.dayOfWeek]) grid[s.dayOfWeek] = {};
        grid[s.dayOfWeek][s.periodNumber] = {
          subject: s.subject?.name ?? (s.isBreak ? s.breakLabel : null),
          teacher: s.teacher?.user?.name ?? null,
          room: s.room, startTime: s.startTime, isBreak: s.isBreak,
        };
      }

      return reply.send({
        success: true,
        data: { className: `${cls.name}`, section: cls.section, academicYear: q.academicYear, masterPeriods, grid },
      });
    }
  );

  // ─────────────────────────────────────────
  // SUBSTITUTE TEACHER
  // ─────────────────────────────────────────

  // ── GET /admin/class-timetable/substitutes ────────────────
  app.get(`${P}/substitutes`, { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { date: string; teacherId?: string };
      if (!q.date) return reply.status(400).send({ success: false, message: "date is required." });

      const subs = await prisma.substituteAssignment.findMany({
        where: {
          schoolId, date: new Date(q.date),
          ...(q.teacherId ? { OR: [{ originalTeacherId: parseInt(q.teacherId) }, { substituteId: parseInt(q.teacherId) }] } : {}),
        },
        include: {
          periodSlot: { include: { class: { select: { name: true, section: true } }, subject: { select: { name: true } } } },
          originalTeacher: { include: { user: { select: { name: true } } } },
          substitute: { include: { user: { select: { name: true } } } },
        },
      });
      return reply.send({ success: true, data: { substitutes: subs } });
    }
  );

  // ── POST /admin/class-timetable/substitutes ───────────────
  // A one-off cover for a single date — doesn't touch the recurring
  // PeriodSlot, so the regular teacher is back next week automatically.
  app.post(`${P}/substitutes`, { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const b = request.body as { periodSlotId: number; date: string; substituteId: number; reason?: string };

      if (!b.periodSlotId || !b.date || !b.substituteId) {
        return reply.status(400).send({ success: false, message: "periodSlotId, date and substituteId are required." });
      }
      const slot = await prisma.periodSlot.findFirst({ where: { id: b.periodSlotId, schoolId } });
      if (!slot) return reply.status(404).send({ success: false, message: "Period slot not found." });
      if (!slot.teacherId) return reply.status(400).send({ success: false, message: "This period has no regular teacher to substitute for." });
      if (slot.teacherId === b.substituteId) return reply.status(400).send({ success: false, message: "The substitute can't be the same as the regular teacher." });

      const targetDate = new Date(b.date);
      // Don't double-book the substitute elsewhere at the same day+period.
      const dayOfWeek = targetDate.getDay();
      const clash = await prisma.periodSlot.findFirst({
        where: { schoolId, teacherId: b.substituteId, dayOfWeek, periodNumber: slot.periodNumber, academicYear: slot.academicYear, classId: { not: slot.classId } },
      });
      if (clash) return reply.status(409).send({ success: false, message: "This teacher already has a class at that period." });

      const sub = await prisma.substituteAssignment.upsert({
        where: { periodSlotId_date: { periodSlotId: b.periodSlotId, date: targetDate } },
        create: { schoolId, periodSlotId: b.periodSlotId, date: targetDate, originalTeacherId: slot.teacherId, substituteId: b.substituteId, reason: b.reason ?? null, createdById: userId },
        update: { substituteId: b.substituteId, reason: b.reason ?? null },
        include: { substitute: { include: { user: { select: { name: true } } } } },
      });
      return reply.status(201).send({ success: true, message: "Substitute assigned.", data: { substitute: sub } });
    }
  );

  // ── DELETE /admin/class-timetable/substitutes/:id ─────────
  app.delete(`${P}/substitutes/:id`, { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const existing = await prisma.substituteAssignment.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return reply.status(404).send({ success: false, message: "Not found." });

      await prisma.substituteAssignment.delete({ where: { id: parseInt(id) } });
      return reply.send({ success: true, message: "Substitute removed — regular teacher restored for that date." });
    }
  );
}
