import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

// ── Subject Colors ──────────────────────────────────────────
const SUBJECT_COLORS = [
  "#6366f1","#3b82f6","#10b981","#f59e0b","#ef4444",
  "#8b5cf6","#ec4899","#06b6d4","#84cc16","#f97316",
];

function getSubjectColor(index: number): string {
  return SUBJECT_COLORS[index % SUBJECT_COLORS.length];
}

export async function adminClassTimetableRoutes(app: FastifyInstance) {

  // ── GET /admin/class-timetable/classes ────────────────────
  // All classes for selector
  app.get("/admin/class-timetable/classes",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { sessionName?: string };

      const currentYear = await prisma.academicYear.findFirst({
        where: { schoolId, isCurrent: true },
      });

      const classes = await prisma.class.findMany({
        where: {
          schoolId,
          isActive: true,
          ...(q.sessionName ? { academicYear: q.sessionName } : currentYear ? { academicYear: currentYear.name } : {}),
        },
        orderBy: [{ classNumber: "asc" }, { section: "asc" }],
        include: {
          classTeacher: { include: { user: { select: { name: true } } } },
          // FIXED: Class has no direct `subjects` relation — subjects are
          // linked through SubjectAssignment. This list doesn't need the
          // per-class subject names, so just the count is enough here.
          _count: { select: { students: true, periodSlots: true, subjectAssignments: true } },
        },
      });

      // Group by classNumber
      const grouped: Record<string, typeof classes> = {};
      classes.forEach(cls => {
        if (!grouped[cls.classNumber]) grouped[cls.classNumber] = [];
        grouped[cls.classNumber].push(cls);
      });

      return reply.send({
        success: true,
        data: { classes, grouped, sessionName: q.sessionName ?? currentYear?.name ?? "" },
      });
    }
  );

  // ── GET /admin/class-timetable/:classId ───────────────────
  // Full timetable for a class with master periods
  app.get("/admin/class-timetable/:classId",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { classId } = request.params as { classId: string };
      const q = request.query as { sessionName?: string };

      const classIdInt = parseInt(classId);
      if (isNaN(classIdInt)) return reply.status(400).send({ success: false, message: "Invalid classId." });

      const cls = await prisma.class.findFirst({
        where: { id: classIdInt, schoolId },
        include: {
          // FIXED: was `subjects: {...}` — Class has no such relation.
          // The actual link is subjectAssignments → subject + teacher.
          subjectAssignments: {
            where: { isActive: true },
            include: {
              subject: { select: { id: true, name: true } },
              teacher: { include: { user: { select: { id: true, name: true } } } },
            },
          },
          classTeacher: { include: { user: { select: { name: true } } } },
        },
      });
      if (!cls) return reply.status(404).send({ success: false, message: "Class not found." });

      const sessionName = q.sessionName ?? cls.academicYear;

      // Get master periods for this session
      const masterPeriods = await prisma.masterPeriod.findMany({
        where: { schoolId, sessionName, isActive: true },
        orderBy: [{ dayOfWeek: "asc" }, { serialNumber: "asc" }],
      });

      // Get existing timetable slots
      const slots = await prisma.periodSlot.findMany({
        where: { classId: classIdInt, schoolId, academicYear: sessionName },
        include: {
          subject: { select: { id: true, name: true } },
          teacher: { include: { user: { select: { id: true, name: true } } } },
        },
        orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
      });

      // Get all active staff for teacher assignment
      const staff = await prisma.staff.findMany({
        where: { schoolId, isActive: true },
        include: { user: { select: { id: true, name: true } } },
        orderBy: { user: { name: "asc" } },
      });

      // Flatten subjectAssignments into the subject shape the frontend
      // expects, carrying weeklyPeriods and the assigned teacher along
      // so the cell editor can default to the right teacher.
      const subjectsWithColors = cls.subjectAssignments.map((a, i) => ({
        id: a.subject.id,
        name: a.subject.name,
        weeklyPeriods: a.weeklyPeriods,
        teacher: a.teacher,
        color: getSubjectColor(i),
      }));

      // Subject frequency: how many times each subject appears per week
      const subjectFrequency: Record<number, number> = {};
      slots.forEach(s => {
        if (s.subjectId) {
          subjectFrequency[s.subjectId] = (subjectFrequency[s.subjectId] ?? 0) + 1;
        }
      });

      return reply.send({
        success: true,
        data: {
          class: cls,
          subjects: subjectsWithColors,
          masterPeriods,
          slots,
          staff,
          sessionName,
          subjectFrequency,
        },
      });
    }
  );

  // ── POST /admin/class-timetable/:classId/slot ─────────────
  app.post("/admin/class-timetable/:classId/slot",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { classId } = request.params as { classId: string };
      const body = request.body as {
        dayOfWeek: number;
        periodNumber: number;
        startTime: string;
        duration: number;
        subjectId?: number;
        teacherId?: number;
        room?: string;
        academicYear: string;
        isBreak?: boolean;
        breakLabel?: string;
        masterPeriodId?: number;
        overrideConflict?: boolean;
      };

      const classIdInt = parseInt(classId);

      // Teacher conflict check
      if (body.teacherId && !body.isBreak && !body.overrideConflict) {
        const conflict = await prisma.periodSlot.findFirst({
          where: {
            schoolId,
            teacherId: body.teacherId,
            dayOfWeek: body.dayOfWeek,
            periodNumber: body.periodNumber,
            academicYear: body.academicYear,
            classId: { not: classIdInt },
          },
          include: { class: { select: { name: true } } },
        });

        if (conflict) {
          return reply.status(409).send({
            success: false,
            error: "TEACHER_CONFLICT",
            message: `Teacher is already assigned to Class ${conflict.class.name} during this period.`,
          });
        }
      }

      // Room conflict check — same room, same day/period, another class
      if (body.room?.trim() && !body.isBreak && !body.overrideConflict) {
        const roomConflict = await prisma.periodSlot.findFirst({
          where: {
            schoolId,
            room: body.room.trim(),
            dayOfWeek: body.dayOfWeek,
            periodNumber: body.periodNumber,
            academicYear: body.academicYear,
            classId: { not: classIdInt },
          },
          include: { class: { select: { name: true } } },
        });

        if (roomConflict) {
          return reply.status(409).send({
            success: false,
            error: "ROOM_CONFLICT",
            message: `Room ${body.room} is already booked by Class ${roomConflict.class.name} during this period.`,
          });
        }
      }

      // Upsert slot
      const slot = await prisma.periodSlot.upsert({
        where: {
          classId_dayOfWeek_periodNumber_academicYear: {
            classId: classIdInt,
            dayOfWeek: body.dayOfWeek,
            periodNumber: body.periodNumber,
            academicYear: body.academicYear,
          },
        },
        create: {
          schoolId,
          classId: classIdInt,
          dayOfWeek: body.dayOfWeek,
          periodNumber: body.periodNumber,
          startTime: body.startTime,
          duration: body.duration,
          subjectId: body.subjectId ?? null,
          teacherId: body.teacherId ?? null,
          room: body.room?.trim() || null,
          isBreak: body.isBreak ?? false,
          breakLabel: body.breakLabel ?? null,
          academicYear: body.academicYear,
        },
        update: {
          subjectId: body.subjectId ?? null,
          teacherId: body.teacherId ?? null,
          room: body.room?.trim() || null,
          isBreak: body.isBreak ?? false,
          breakLabel: body.breakLabel ?? null,
          startTime: body.startTime,
          duration: body.duration,
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
  app.delete("/admin/class-timetable/:classId/slot",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { classId } = request.params as { classId: string };
      const body = request.body as { dayOfWeek: number; periodNumber: number; academicYear: string; };

      await prisma.periodSlot.deleteMany({
        where: {
          classId: parseInt(classId),
          schoolId,
          dayOfWeek: body.dayOfWeek,
          periodNumber: body.periodNumber,
          academicYear: body.academicYear,
        },
      });

      return reply.send({ success: true, message: "Slot cleared." });
    }
  );

  // ── POST /admin/class-timetable/:classId/copy ─────────────
  // Copy from another class or another day
  app.post("/admin/class-timetable/:classId/copy",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { classId } = request.params as { classId: string };
      const body = request.body as {
        type: "CLASS" | "DAY";
        fromClassId?: number;
        fromDay?: number;
        toDay?: number;
        academicYear: string;
        clearExisting?: boolean;
      };

      let sourceSlots: any[] = [];

      if (body.type === "CLASS" && body.fromClassId) {
        sourceSlots = await prisma.periodSlot.findMany({
          where: { classId: body.fromClassId, schoolId, academicYear: body.academicYear },
        });
      } else if (body.type === "DAY" && body.fromDay !== undefined && body.toDay !== undefined) {
        sourceSlots = await prisma.periodSlot.findMany({
          where: { classId: parseInt(classId), schoolId, academicYear: body.academicYear, dayOfWeek: body.fromDay },
        });
        sourceSlots = sourceSlots.map(s => ({ ...s, dayOfWeek: body.toDay }));
      }

      if (body.clearExisting) {
        if (body.type === "DAY" && body.toDay !== undefined) {
          await prisma.periodSlot.deleteMany({
            where: { classId: parseInt(classId), schoolId, academicYear: body.academicYear, dayOfWeek: body.toDay },
          });
        } else {
          await prisma.periodSlot.deleteMany({
            where: { classId: parseInt(classId), schoolId, academicYear: body.academicYear },
          });
        }
      }

      let copied = 0;
      for (const s of sourceSlots) {
        try {
          await prisma.periodSlot.upsert({
            where: {
              classId_dayOfWeek_periodNumber_academicYear: {
                classId: parseInt(classId),
                dayOfWeek: s.dayOfWeek,
                periodNumber: s.periodNumber,
                academicYear: body.academicYear,
              },
            },
            create: {
              schoolId, classId: parseInt(classId),
              dayOfWeek: s.dayOfWeek, periodNumber: s.periodNumber,
              startTime: s.startTime, duration: s.duration,
              subjectId: body.type === "CLASS" ? null : s.subjectId, // don't copy subjects across classes
              teacherId: body.type === "CLASS" ? null : s.teacherId,
              isBreak: s.isBreak, breakLabel: s.breakLabel,
              academicYear: body.academicYear,
            },
            update: {
              subjectId: body.type === "CLASS" ? null : s.subjectId,
              teacherId: body.type === "CLASS" ? null : s.teacherId,
              isBreak: s.isBreak, breakLabel: s.breakLabel,
            },
          });
          copied++;
        } catch (e) { /* skip conflicts */ }
      }

      return reply.send({ success: true, message: `${copied} slots copied.` });
    }
  );

  // ── POST /admin/class-timetable/:classId/auto-generate ───
  // Was missing entirely — the frontend's "Auto-generate" button had
  // nothing to call. Spreads each subject's weeklyPeriods (from
  // SubjectAssignment) across the class's non-break master periods,
  // skipping any (day, period) where the teacher is already booked
  // elsewhere. It's a fast first draft, not a real constraint solver —
  // it fills greedily day by day and reports what it couldn't place.
  app.post("/admin/class-timetable/:classId/auto-generate",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { classId } = request.params as { classId: string };
      const body = request.body as { academicYear: string; clearExisting?: boolean };
      const classIdInt = parseInt(classId);

      if (!body.academicYear) {
        return reply.status(400).send({ success: false, message: "academicYear is required." });
      }

      const [assignments, masterPeriods] = await Promise.all([
        prisma.subjectAssignment.findMany({
          where: { schoolId, classId: classIdInt, isActive: true },
        }),
        prisma.masterPeriod.findMany({
          where: { schoolId, sessionName: body.academicYear, isActive: true, periodType: { notIn: ["BREAK", "LUNCH", "ASSEMBLY"] } },
          orderBy: [{ dayOfWeek: "asc" }, { serialNumber: "asc" }],
        }),
      ]);

      if (assignments.length === 0) {
        return reply.status(400).send({
          success: false,
          message: "No subjects are assigned to this class yet — set them up in Subject Assignment first.",
        });
      }
      if (masterPeriods.length === 0) {
        return reply.status(400).send({
          success: false,
          message: "No periods are configured for this session yet — set up the bell schedule in Manage Periods first.",
        });
      }

      if (body.clearExisting) {
        await prisma.periodSlot.deleteMany({
          where: { schoolId, classId: classIdInt, academicYear: body.academicYear, isBreak: false },
        });
      }

      const existingSlots = await prisma.periodSlot.findMany({
        where: { schoolId, classId: classIdInt, academicYear: body.academicYear },
      });
      const takenSlotKeys = new Set(existingSlots.map(s => `${s.dayOfWeek}-${s.periodNumber}`));

      // Free (day, period) slots not already used by this class, grouped
      // round-robin across days so one subject doesn't stack on one day.
      const freeSlots = masterPeriods
        .filter(p => !takenSlotKeys.has(`${p.dayOfWeek}-${p.serialNumber}`))
        .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.serialNumber - b.serialNumber);

      let placed = 0;
      const skipped: string[] = [];
      let cursor = 0;

      for (const a of assignments) {
        let need = a.weeklyPeriods || 0;
        const usedDays = new Set<number>();
        let attempts = 0;

        while (need > 0 && attempts < freeSlots.length) {
          const slot = freeSlots[cursor % freeSlots.length];
          cursor++;
          attempts++;
          const key = `${slot.dayOfWeek}-${slot.serialNumber}`;
          if (takenSlotKeys.has(key)) continue;
          // Prefer spreading across different days before repeating one
          if (usedDays.has(slot.dayOfWeek) && usedDays.size < 5 && attempts < freeSlots.length) continue;

          // Teacher conflict check across other classes at this exact slot
          if (a.teacherId) {
            const conflict = await prisma.periodSlot.findFirst({
              where: {
                schoolId, teacherId: a.teacherId, dayOfWeek: slot.dayOfWeek,
                periodNumber: slot.serialNumber, academicYear: body.academicYear,
                classId: { not: classIdInt },
              },
            });
            if (conflict) continue;
          }

          await prisma.periodSlot.create({
            data: {
              schoolId, classId: classIdInt,
              dayOfWeek: slot.dayOfWeek, periodNumber: slot.serialNumber,
              startTime: slot.startTime, duration: slot.duration,
              subjectId: a.subjectId, teacherId: a.teacherId,
              isBreak: false, academicYear: body.academicYear,
            },
          });
          takenSlotKeys.add(key);
          usedDays.add(slot.dayOfWeek);
          need--;
          placed++;
        }

        if (need > 0) skipped.push(`${need} period(s) for subject #${a.subjectId} — not enough free slots or teacher was busy`);
      }

      return reply.send({
        success: placed > 0,
        message: placed > 0
          ? `${placed} period(s) placed.${skipped.length ? ` ${skipped.length} subject(s) couldn't be fully scheduled — review the grid.` : ""}`
          : "Nothing could be placed — every slot is either full or the assigned teachers are booked elsewhere.",
        data: { placed, skipped },
      });
    }
  );

  // ── GET /admin/class-timetable/teacher-availability ───────
  // Check teacher's schedule for conflict detection
  app.get("/admin/class-timetable/teacher-availability",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { teacherId: string; academicYear: string; dayOfWeek?: string; excludeClassId?: string };

      const slots = await prisma.periodSlot.findMany({
        where: {
          schoolId,
          teacherId: parseInt(q.teacherId),
          academicYear: q.academicYear,
          ...(q.dayOfWeek ? { dayOfWeek: parseInt(q.dayOfWeek) } : {}),
          ...(q.excludeClassId ? { classId: { not: parseInt(q.excludeClassId) } } : {}),
        },
        include: { class: { select: { name: true } } },
      });

      const busySlots = slots.map(s => ({
        dayOfWeek: s.dayOfWeek,
        periodNumber: s.periodNumber,
        className: s.class.name,
      }));

      return reply.send({ success: true, data: { busySlots } });
    }
  );

  // ── GET /admin/class-timetable/stats/:classId ─────────────
  app.get("/admin/class-timetable/stats/:classId",
    { preHandler: [authenticate] },
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
      slots.filter(s => s.subject).forEach(s => {
        subjectFreq[s.subject!.name] = (subjectFreq[s.subject!.name] ?? 0) + 1;
      });

      return reply.send({
        success: true,
        data: { totalSlots, filledSlots, breakSlots, emptySlots, subjectFreq },
      });
    }
  );

  // ── POST /admin/class-timetable/resync-times ──────────────
  // One-time repair tool. Any PeriodSlot saved before the frontend fix
  // (that deduped master periods across days and could pick up a stray
  // dayOfWeek=0 row's time) has the WRONG startTime/duration baked in —
  // teacher and subject assignments on it are fine, only the time is
  // stale. This re-reads each slot's true time from its matching
  // MasterPeriod (by dayOfWeek + periodNumber, Mon–Sat only) and
  // corrects any mismatch. Safe to run repeatedly; touches nothing
  // else on the slot.
  app.post("/admin/class-timetable/resync-times",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = (request.body ?? {}) as { academicYear?: string };

      const slots = await prisma.periodSlot.findMany({
        where: {
          schoolId,
          dayOfWeek: { gte: 1, lte: 6 },
          ...(body.academicYear ? { academicYear: body.academicYear } : {}),
        },
      });
      if (slots.length === 0) {
        return reply.send({ success: true, message: "No period slots to check.", data: { checked: 0, fixed: 0 } });
      }

      const sessionNames = [...new Set(slots.map(s => s.academicYear))];
      const masterPeriods = await prisma.masterPeriod.findMany({
        where: { schoolId, sessionName: { in: sessionNames }, dayOfWeek: { gte: 1, lte: 6 } },
      });
      const byKey = new Map(
        masterPeriods.map(p => [`${p.sessionName}-${p.dayOfWeek}-${p.serialNumber}`, p]),
      );

      let fixed = 0;
      for (const s of slots) {
        const correct = byKey.get(`${s.academicYear}-${s.dayOfWeek}-${s.periodNumber}`);
        if (!correct) continue; // no matching master period defined — leave as is
        if (correct.startTime !== s.startTime || correct.duration !== s.duration) {
          await prisma.periodSlot.update({
            where: { id: s.id },
            data: { startTime: correct.startTime, duration: correct.duration },
          });
          fixed++;
        }
      }

      return reply.send({
        success: true,
        message: fixed > 0 ? `${fixed} period slot(s) had a stale time — corrected.` : "Every slot's time already matches its master period.",
        data: { checked: slots.length, fixed },
      });
    }
  );
}