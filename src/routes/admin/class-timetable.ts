import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";

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
          subjects: { where: { isActive: true }, select: { id: true, name: true } },
          _count: { select: { students: true, periodSlots: true } },
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
          subjects: {
            where: { isActive: true },
            include: { teacher: { include: { user: { select: { id: true, name: true } } } } },
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

      // Assign colors to subjects
      const subjectsWithColors = cls.subjects.map((s, i) => ({
        ...s, color: getSubjectColor(i),
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
  // Save single cell (subject + teacher for a period+day)
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
      };

      const classIdInt = parseInt(classId);

      // Teacher conflict check
      if (body.teacherId && !body.isBreak) {
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
          isBreak: body.isBreak ?? false,
          breakLabel: body.breakLabel ?? null,
          academicYear: body.academicYear,
        },
        update: {
          subjectId: body.subjectId ?? null,
          teacherId: body.teacherId ?? null,
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
}
