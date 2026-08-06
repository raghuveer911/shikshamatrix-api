// apps/api/src/routes/admin/academics/timetable-insights.ts
// ─────────────────────────────────────────────────────────────
// Timetable — the school-wide health layer.
//
// class-timetable.ts (existing, untouched) already does everything
// for ONE class's grid: slot save/delete, copy, auto-generate,
// teacher-availability, stats, export, substitutes. This file adds
// what the hero page needs ACROSS every class:
//
//   GET  /admin/class-timetable/overview   → Layer 1 stat rail
//   GET  /admin/class-timetable/conflicts  → every teacher/room double
//                                            booking in the session,
//                                            school-wide
//   POST /admin/class-timetable/bulk-copy  → copy one class's grid onto
//                                            several others at once
//
// Register alongside adminClassTimetableRoutes:
//   await app.register(adminTimetableInsightRoutes);
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminTimetableInsightRoutes(app: FastifyInstance) {
  const P = "/admin/class-timetable";
  const guard = { preHandler: [authenticate, requireCapability("academics.core")] };

  async function currentSession(schoolId: number, override?: string) {
    if (override) return override;
    const y = await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
    return y?.name;
  }

  // ── GET /admin/class-timetable/overview ──────────────────
  app.get(`${P}/overview`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { sessionName?: string };

    const sessionName = await currentSession(schoolId, q.sessionName);
    if (!sessionName) return rep.status(404).send({ success: false, message: "No academic session found." });

    const [classes, masterPeriods, slots] = await Promise.all([
      prisma.class.findMany({ where: { schoolId, academicYear: sessionName, isActive: true }, select: { id: true, name: true } }),
      prisma.masterPeriod.findMany({ where: { schoolId, sessionName, isActive: true, periodType: { notIn: ["BREAK", "LUNCH", "ASSEMBLY"] } } }),
      prisma.periodSlot.findMany({
        where: { schoolId, academicYear: sessionName },
        select: { classId: true, teacherId: true, subjectId: true, dayOfWeek: true, periodNumber: true, isBreak: true },
      }),
    ]);

    // Teaching periods possible per class = distinct (day, period) pairs
    // among non-break master periods for that day.
    const teachingSlotsPerClass = new Set(masterPeriods.map((p) => `${p.dayOfWeek}-${p.serialNumber}`)).size;
    const totalPossible = classes.length * teachingSlotsPerClass;

    const filled = slots.filter((s) => !s.isBreak && s.subjectId).length;

    const readyClasses = new Set<number>();
    const byClass = new Map<number, number>();
    for (const s of slots) if (!s.isBreak && s.subjectId) byClass.set(s.classId, (byClass.get(s.classId) ?? 0) + 1);
    for (const c of classes) {
      const count = byClass.get(c.id) ?? 0;
      if (teachingSlotsPerClass > 0 && count >= teachingSlotsPerClass * 0.9) readyClasses.add(c.id);
    }

    // Conflicts: same teacher, same day+period, more than one class.
    const teacherKey = new Map<string, Set<number>>();
    for (const s of slots) {
      if (s.isBreak || !s.teacherId) continue;
      const key = `${s.teacherId}-${s.dayOfWeek}-${s.periodNumber}`;
      (teacherKey.get(key) ?? teacherKey.set(key, new Set()).get(key)!).add(s.classId);
    }
    const teacherConflicts = [...teacherKey.values()].filter((set) => set.size > 1).length;

    const roomKey = new Map<string, Set<number>>();
    for (const s of slots as any[]) {
      if (s.isBreak || !s.room) continue;
      const key = `${s.room}-${s.dayOfWeek}-${s.periodNumber}`;
      (roomKey.get(key) ?? roomKey.set(key, new Set()).get(key)!).add(s.classId);
    }
    const roomConflicts = [...roomKey.values()].filter((set) => set.size > 1).length;

    const emptyClasses = classes.filter((c) => (byClass.get(c.id) ?? 0) === 0).length;

    return rep.send({
      success: true,
      data: {
        sessionName,
        classCount: classes.length,
        teachingSlotsPerClass,
        totalPossible,
        filled,
        fillPct: totalPossible > 0 ? Math.round((filled / totalPossible) * 100) : 0,
        readyClasses: readyClasses.size,
        emptyClasses,
        teacherConflicts,
        roomConflicts,
        totalConflicts: teacherConflicts + roomConflicts,
      },
    });
  });

  // ── GET /admin/class-timetable/conflicts ─────────────────
  app.get(`${P}/conflicts`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { sessionName?: string };

    const sessionName = await currentSession(schoolId, q.sessionName);
    if (!sessionName) return rep.status(404).send({ success: false, message: "No academic session found." });

    const slots = await prisma.periodSlot.findMany({
      where: { schoolId, academicYear: sessionName, isBreak: false },
      include: {
        class: { select: { id: true, name: true } },
        teacher: { include: { user: { select: { name: true } } } },
        subject: { select: { name: true } },
      },
    });

    const byTeacherSlot = new Map<string, typeof slots>();
    const byRoomSlot = new Map<string, typeof slots>();
    for (const s of slots) {
      if (s.teacherId) {
        const k = `${s.teacherId}-${s.dayOfWeek}-${s.periodNumber}`;
        (byTeacherSlot.get(k) ?? byTeacherSlot.set(k, []).get(k)!).push(s);
      }
      if (s.room) {
        const k = `${s.room}-${s.dayOfWeek}-${s.periodNumber}`;
        (byRoomSlot.get(k) ?? byRoomSlot.set(k, []).get(k)!).push(s);
      }
    }

    const teacherConflicts = [...byTeacherSlot.values()]
      .filter((group) => new Set(group.map((s) => s.classId)).size > 1)
      .map((group) => ({
        kind: "TEACHER" as const,
        teacherName: group[0].teacher?.user?.name ?? "Unknown",
        dayOfWeek: group[0].dayOfWeek, periodNumber: group[0].periodNumber,
        classes: group.map((s) => ({ id: s.class.id, name: s.class.name, subject: s.subject?.name ?? null })),
      }));

    const roomConflicts = [...byRoomSlot.values()]
      .filter((group) => new Set(group.map((s) => s.classId)).size > 1)
      .map((group) => ({
        kind: "ROOM" as const,
        room: group[0].room,
        dayOfWeek: group[0].dayOfWeek, periodNumber: group[0].periodNumber,
        classes: group.map((s) => ({ id: s.class.id, name: s.class.name, teacher: s.teacher?.user?.name ?? null })),
      }));

    return rep.send({ success: true, data: { conflicts: [...teacherConflicts, ...roomConflicts] } });
  });

  // ── POST /admin/class-timetable/bulk-copy ────────────────
  app.post(`${P}/bulk-copy`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { sourceClassId: number; targetClassIds: number[]; academicYear: string; keepTeacherAndSubject?: boolean };

    if (!b.sourceClassId || !b.targetClassIds?.length || !b.academicYear) {
      return rep.status(400).send({ success: false, message: "Pick a source class and at least one target." });
    }

    const sourceSlots = await prisma.periodSlot.findMany({ where: { classId: b.sourceClassId, schoolId, academicYear: b.academicYear } });
    if (sourceSlots.length === 0) return rep.status(400).send({ success: false, message: "The source class has no timetable to copy." });

    const keep = b.keepTeacherAndSubject ?? false;
    let copied = 0, targetsDone = 0;

    for (const targetId of b.targetClassIds) {
      if (targetId === b.sourceClassId) continue;
      for (const s of sourceSlots) {
        try {
          await prisma.periodSlot.upsert({
            where: {
              classId_dayOfWeek_periodNumber_academicYear: {
                classId: targetId, dayOfWeek: s.dayOfWeek, periodNumber: s.periodNumber, academicYear: b.academicYear,
              },
            },
            create: {
              schoolId, classId: targetId, dayOfWeek: s.dayOfWeek, periodNumber: s.periodNumber,
              startTime: s.startTime, duration: s.duration,
              subjectId: keep ? s.subjectId : null, teacherId: keep ? s.teacherId : null,
              room: null, isBreak: s.isBreak, breakLabel: s.breakLabel, academicYear: b.academicYear,
            },
            update: {
              subjectId: keep ? s.subjectId : null, teacherId: keep ? s.teacherId : null,
              isBreak: s.isBreak, breakLabel: s.breakLabel,
            },
          });
          copied++;
        } catch { /* skip a slot that collides */ }
      }
      targetsDone++;
    }

    return rep.send({
      success: copied > 0,
      message: `Timetable structure copied onto ${targetsDone} class(es)${keep ? " with teacher and subject carried over — check for clashes" : " — teacher and subject left blank to avoid double-booking"}.`,
      data: { copied, targetsDone },
    });
  });
}
