// apps/api/src/routes/admin/academics/classes-insights.ts
// ─────────────────────────────────────────────────────────────
// Classes & Sections — the health layer.
//
// This file is ADDITIVE. The existing classes.ts keeps all its CRUD;
// this adds what the premium card and drawer need on top:
//
//   GET  /admin/classes/overview   → Layer 1 stat rail
//   GET  /admin/classes/insights   → one call, health for every class
//                                    (attendance %, fees pending,
//                                     timetable readiness, subject
//                                     coverage, gender split)
//   GET  /admin/classes/:id/health → the same, deep, for one class
//   POST /admin/classes/bulk       → archive / restore / shift / delete
//   POST /admin/classes/bulk-create→ add many classes × sections at once
//   POST /admin/classes/:id/duplicate
//
// Register it next to adminClassRoutes:
//   await app.register(adminClassInsightRoutes);
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

const ATTENDANCE_WINDOW_DAYS = 30;

export async function adminClassInsightRoutes(app: FastifyInstance) {
  const P = "/admin/classes";
  const guard = { preHandler: [authenticate, requireCapability("academics.core")] };

  async function currentYear(schoolId: number, override?: string) {
    if (override) return override;
    const y = await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
    return y?.name;
  }

  /* ── Bulk health for every class in a session ───────────
     One round of grouped queries instead of N queries per class —
     this is what keeps the page fast at 200+ sections. */
  async function healthMap(schoolId: number, academicYear: string) {
    const classes = await prisma.class.findMany({
      where: { schoolId, academicYear },
      select: { id: true, capacity: true },
    });
    const ids = classes.map((c) => c.id);
    if (ids.length === 0) return {};

    const since = new Date();
    since.setDate(since.getDate() - ATTENDANCE_WINDOW_DAYS);

    const [attendance, slots, subjects, students, invoices] = await Promise.all([
      prisma.attendance.groupBy({
        by: ["classId", "status"],
        where: { schoolId, classId: { in: ids }, date: { gte: since } },
        _count: { _all: true },
      }),
      prisma.periodSlot.groupBy({
        by: ["classId"],
        where: { schoolId, classId: { in: ids }, academicYear, isBreak: false },
        _count: { _all: true },
      }),
      prisma.subjectAssignment.groupBy({
        by: ["classId"],
        where: { schoolId, classId: { in: ids }, isActive: true },
        _count: { _all: true },
      }),
      prisma.student.groupBy({
        by: ["classId", "gender"],
        where: { schoolId, classId: { in: ids } },
        _count: { _all: true },
      }),
      prisma.invoice.findMany({
        where: { schoolId, status: { not: "PAID" }, student: { classId: { in: ids } } },
        select: { dueAmount: true, status: true, dueDate: true, student: { select: { classId: true } } },
      }),
    ]);

    const out: Record<number, any> = {};
    for (const c of classes) {
      out[c.id] = {
        attendancePct: null as number | null,
        attendanceSample: 0,
        periodsScheduled: 0,
        timetableReady: false,
        subjectsAssigned: 0,
        boys: 0, girls: 0, other: 0,
        feePendingAmount: 0,
        feePendingCount: 0,
        feeOverdueCount: 0,
      };
    }

    const present: Record<number, number> = {};
    const totalMarked: Record<number, number> = {};
    for (const a of attendance) {
      totalMarked[a.classId] = (totalMarked[a.classId] ?? 0) + a._count._all;
      if (a.status === "PRESENT" || a.status === "LATE") {
        present[a.classId] = (present[a.classId] ?? 0) + a._count._all;
      }
    }
    for (const id of ids) {
      const total = totalMarked[id] ?? 0;
      out[id].attendanceSample = total;
      out[id].attendancePct = total > 0 ? Math.round(((present[id] ?? 0) / total) * 100) : null;
    }

    for (const s of slots) {
      out[s.classId].periodsScheduled = s._count._all;
      // A week is considered planned once there's at least one period on
      // most working days — the UI shows the raw count either way.
      out[s.classId].timetableReady = s._count._all >= 20;
    }
    for (const s of subjects) out[s.classId].subjectsAssigned = s._count._all;

    for (const s of students) {
      if (s.classId === null) continue;
      const bucket = s.gender === "MALE" ? "boys" : s.gender === "FEMALE" ? "girls" : "other";
      out[s.classId][bucket] += s._count._all;
    }

    const today = new Date();
    for (const inv of invoices) {
      const cid = inv.student.classId;
      if (cid === null || !out[cid]) continue;
      out[cid].feePendingAmount += Number(inv.dueAmount);
      out[cid].feePendingCount++;
      if (new Date(inv.dueDate) < today) out[cid].feeOverdueCount++;
    }

    return out;
  }

  // ── GET /admin/classes/insights ──────────────────────────
  app.get(`${P}/insights`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYear?: string };

    const year = await currentYear(schoolId, q.academicYear);
    if (!year) return rep.status(404).send({ success: false, message: "No academic session found." });

    const health = await healthMap(schoolId, year);
    return rep.send({ success: true, data: { academicYear: year, health } });
  });

  // ── GET /admin/classes/overview ──────────────────────────
  app.get(`${P}/overview`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYear?: string };

    const year = await currentYear(schoolId, q.academicYear);
    if (!year) return rep.status(404).send({ success: false, message: "No academic session found." });

    const classes = await prisma.class.findMany({
      where: { schoolId, academicYear: year, isActive: true },
      select: { id: true, classNumber: true, capacity: true, classTeacherId: true, shift: true, room: true,
                _count: { select: { students: true } } },
    });

    const health = await healthMap(schoolId, year);

    const sections = classes.length;
    const grades = new Set(classes.map((c) => c.classNumber)).size;
    const capacity = classes.reduce((a, c) => a + c.capacity, 0);
    const enrolled = classes.reduce((a, c) => a + c._count.students, 0);

    const withoutTeacher = classes.filter((c) => !c.classTeacherId).length;
    const withoutRoom = classes.filter((c) => !c.room).length;
    const overCapacity = classes.filter((c) => c._count.students > c.capacity);
    const empty = classes.filter((c) => c._count.students === 0).length;
    const timetableMissing = classes.filter((c) => !health[c.id]?.timetableReady).length;

    const attPcts = classes.map((c) => health[c.id]?.attendancePct).filter((v): v is number => v !== null && v !== undefined);
    const avgAttendance = attPcts.length ? Math.round(attPcts.reduce((a, b) => a + b, 0) / attPcts.length) : null;

    const feePending = classes.reduce((a, c) => a + (health[c.id]?.feePendingAmount ?? 0), 0);

    const byShift: Record<string, number> = {};
    for (const c of classes) byShift[c.shift] = (byShift[c.shift] ?? 0) + 1;

    return rep.send({
      success: true,
      data: {
        academicYear: year,
        sections, grades, capacity, enrolled,
        seatsFree: Math.max(0, capacity - enrolled),
        occupancyPct: capacity > 0 ? Math.round((enrolled / capacity) * 100) : 0,
        avgAttendance,
        feePending: Math.round(feePending),
        gaps: {
          withoutTeacher, withoutRoom, empty, timetableMissing,
          overCapacity: overCapacity.length,
          overCapacityIds: overCapacity.map((c) => c.id),
        },
        byShift,
      },
    });
  });

  // ── GET /admin/classes/:id/health ────────────────────────
  app.get(`${P}/:id/health`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { id } = req.params as { id: string };

    const cls = await prisma.class.findFirst({
      where: { id: parseInt(id), schoolId },
      include: {
        classTeacher: { include: { user: { select: { name: true, avatarUrl: true } } } },
        subjectAssignments: {
          where: { isActive: true },
          include: {
            subject: { select: { id: true, name: true, code: true } },
            teacher: { include: { user: { select: { name: true } } } },
          },
        },
        _count: { select: { students: true, attendance: true, periodSlots: true } },
      },
    });
    if (!cls) return rep.status(404).send({ success: false, message: "Class not found." });

    const since = new Date();
    since.setDate(since.getDate() - ATTENDANCE_WINDOW_DAYS);

    const [attendance, dailyRows, invoices, siblings] = await Promise.all([
      prisma.attendance.groupBy({
        by: ["status"],
        where: { schoolId, classId: cls.id, date: { gte: since } },
        _count: { _all: true },
      }),
      prisma.attendance.groupBy({
        by: ["date"],
        where: { schoolId, classId: cls.id, date: { gte: since }, status: "PRESENT" },
        _count: { _all: true },
        orderBy: { date: "asc" },
      }),
      prisma.invoice.findMany({
        where: { schoolId, student: { classId: cls.id } },
        select: { totalAmount: true, paidAmount: true, dueAmount: true, status: true, dueDate: true },
      }),
      prisma.class.findMany({
        where: { schoolId, academicYear: cls.academicYear, classNumber: cls.classNumber, id: { not: cls.id } },
        select: { id: true, name: true, capacity: true, _count: { select: { students: true } } },
      }),
    ]);

    const marked = attendance.reduce((a, r) => a + r._count._all, 0);
    const presentish = attendance
      .filter((r) => r.status === "PRESENT" || r.status === "LATE")
      .reduce((a, r) => a + r._count._all, 0);

    const billed = invoices.reduce((a, i) => a + Number(i.totalAmount), 0);
    const collected = invoices.reduce((a, i) => a + Number(i.paidAmount), 0);
    const pending = invoices.filter((i) => i.status !== "PAID");

    return rep.send({
      success: true,
      data: {
        class: cls,
        attendance: {
          windowDays: ATTENDANCE_WINDOW_DAYS,
          marked,
          pct: marked > 0 ? Math.round((presentish / marked) * 100) : null,
          byStatus: Object.fromEntries(attendance.map((r) => [r.status, r._count._all])),
          trend: dailyRows.map((d) => ({
            date: d.date.toISOString().slice(0, 10),
            present: d._count._all,
          })),
        },
        fees: {
          billed: Math.round(billed),
          collected: Math.round(collected),
          pending: Math.round(pending.reduce((a, i) => a + Number(i.dueAmount), 0)),
          pendingCount: pending.length,
          overdueCount: pending.filter((i) => new Date(i.dueDate) < new Date()).length,
          collectionPct: billed > 0 ? Math.round((collected / billed) * 100) : 0,
        },
        timetable: {
          periods: cls._count.periodSlots,
          ready: cls._count.periodSlots >= 20,
        },
        siblingSections: siblings.map((s) => ({
          id: s.id, name: s.name, students: s._count.students, capacity: s.capacity,
          free: Math.max(0, s.capacity - s._count.students),
        })),
      },
    });
  });

  // ── POST /admin/classes/bulk ─────────────────────────────
  app.post(`${P}/bulk`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as {
      action: "archive" | "restore" | "delete" | "set-shift" | "set-capacity" | "set-medium" | "set-teacher";
      ids: number[];
      shift?: string;
      capacity?: number;
      medium?: string;
      classTeacherId?: number | null;
    };

    if (!Array.isArray(b.ids) || b.ids.length === 0) {
      return rep.status(400).send({ success: false, message: "Select at least one class." });
    }

    const classes = await prisma.class.findMany({
      where: { schoolId, id: { in: b.ids } },
      include: { _count: { select: { students: true } } },
    });

    const results: { id: number; name: string; ok: boolean; reason?: string }[] = [];

    for (const c of classes) {
      try {
        switch (b.action) {
          case "archive":
            if (c._count.students > 0) throw new Error(`${c._count.students} student(s) still in it`);
            await prisma.class.update({ where: { id: c.id }, data: { isActive: false } });
            break;
          case "restore":
            await prisma.class.update({ where: { id: c.id }, data: { isActive: true } });
            break;
          case "delete": {
            if (c._count.students > 0) throw new Error(`${c._count.students} student(s) still in it`);
            const [att, slots] = await Promise.all([
              prisma.attendance.count({ where: { classId: c.id } }),
              prisma.periodSlot.count({ where: { classId: c.id } }),
            ]);
            if (att > 0) throw new Error("it has attendance history — archive instead");
            if (slots > 0) await prisma.periodSlot.deleteMany({ where: { classId: c.id } });
            await prisma.subjectAssignment.deleteMany({ where: { classId: c.id } });
            await prisma.classTeacherAssignment.deleteMany({ where: { classId: c.id } });
            await prisma.class.delete({ where: { id: c.id } });
            break;
          }
          case "set-shift":
            if (!b.shift) throw new Error("no shift given");
            await prisma.class.update({ where: { id: c.id }, data: { shift: b.shift as any } });
            break;
          case "set-capacity":
            if (!b.capacity || b.capacity < 1) throw new Error("capacity must be at least 1");
            if (b.capacity < c._count.students) throw new Error(`${c._count.students} students already enrolled`);
            await prisma.class.update({ where: { id: c.id }, data: { capacity: b.capacity } });
            break;
          case "set-medium":
            await prisma.class.update({ where: { id: c.id }, data: { medium: b.medium ?? null } });
            break;
          case "set-teacher":
            await prisma.class.update({ where: { id: c.id }, data: { classTeacherId: b.classTeacherId ?? null } });
            break;
        }
        results.push({ id: c.id, name: c.name, ok: true });
      } catch (e: any) {
        results.push({ id: c.id, name: c.name, ok: false, reason: e.message });
      }
    }

    const done = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    return rep.send({
      success: done > 0,
      message:
        failed.length === 0
          ? `${done} class${done === 1 ? "" : "es"} updated.`
          : `${done} updated, ${failed.length} skipped — ${failed.map((f) => `${f.name}: ${f.reason}`).join("; ")}.`,
      data: { results },
    });
  });

  // ── POST /admin/classes/bulk-create ──────────────────────
  // "Class 1 to 5, sections A–C" in one go — the single most tedious
  // task when a school onboards.
  app.post(`${P}/bulk-create`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as {
      academicYear: string;
      classNumbers: string[];
      sections: string[];
      capacity?: number;
      medium?: string;
      shift?: string;
      stream?: string;
    };

    if (!b.academicYear || !b.classNumbers?.length || !b.sections?.length) {
      return rep.status(400).send({ success: false, message: "Pick at least one class level and one section." });
    }
    if (b.classNumbers.length * b.sections.length > 200) {
      return rep.status(400).send({ success: false, message: "That's over 200 sections in one go. Split it into smaller batches." });
    }

    const session = await prisma.academicYear.findFirst({ where: { schoolId, name: b.academicYear } });
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });
    if (session.status === "LOCKED") return rep.status(400).send({ success: false, message: "This session is locked." });

    const existing = await prisma.class.findMany({
      where: { schoolId, academicYear: b.academicYear },
      select: { name: true, sortOrder: true },
    });
    const have = new Set(existing.map((c) => c.name));
    let sortOrder = existing.reduce((m, c) => Math.max(m, c.sortOrder), 0);

    const created: string[] = [];
    const skipped: string[] = [];

    for (const num of b.classNumbers) {
      for (const sec of b.sections) {
        const name = `${num}-${sec}`;
        if (have.has(name)) { skipped.push(name); continue; }
        sortOrder++;
        await prisma.class.create({
          data: {
            schoolId, name, classNumber: num, section: sec,
            academicYear: b.academicYear,
            capacity: b.capacity ?? 40,
            medium: b.medium ?? null,
            shift: (b.shift as any) ?? "MORNING",
            stream: ["11", "12"].includes(num) ? b.stream ?? null : null,
            sortOrder,
          },
        });
        created.push(name);
      }
    }

    return rep.status(201).send({
      success: created.length > 0,
      message: `${created.length} section${created.length === 1 ? "" : "s"} created${skipped.length ? `, ${skipped.length} already existed` : ""}.`,
      data: { created, skipped },
    });
  });

  // ── POST /admin/classes/:id/duplicate ────────────────────
  app.post(`${P}/:id/duplicate`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { section?: string; copySubjects?: boolean; copyTimetable?: boolean };

    const source = await prisma.class.findFirst({ where: { id: parseInt(id), schoolId } });
    if (!source) return rep.status(404).send({ success: false, message: "Class not found." });

    // Next free section letter, unless one was given
    let section = b.section;
    if (!section) {
      const siblings = await prisma.class.findMany({
        where: { schoolId, academicYear: source.academicYear, classNumber: source.classNumber },
        select: { section: true },
      });
      const taken = new Set(siblings.map((s) => s.section.toUpperCase()));
      section = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").find((l) => !taken.has(l));
      if (!section) return rep.status(400).send({ success: false, message: "Every section letter A–Z is taken for this class." });
    }

    const name = `${source.classNumber}-${section}`;
    const dupe = await prisma.class.findFirst({ where: { schoolId, name, academicYear: source.academicYear } });
    if (dupe) return rep.status(409).send({ success: false, message: `${name} already exists.` });

    const created = await prisma.class.create({
      data: {
        schoolId, name, classNumber: source.classNumber, section,
        stream: source.stream, medium: source.medium, room: null,
        shift: source.shift, capacity: source.capacity,
        academicYear: source.academicYear, sortOrder: source.sortOrder,
      },
    });

    let copiedSubjects = 0;
    if (b.copySubjects ?? true) {
      const assignments = await prisma.subjectAssignment.findMany({
        where: { schoolId, classId: source.id, isActive: true },
      });
      for (const a of assignments) {
        await prisma.subjectAssignment.create({
          data: {
            schoolId, classId: created.id, subjectId: a.subjectId,
            teacherId: a.teacherId, academicYearId: a.academicYearId,
          },
        });
        copiedSubjects++;
      }
    }

    let copiedPeriods = 0;
    if (b.copyTimetable) {
      const slots = await prisma.periodSlot.findMany({ where: { schoolId, classId: source.id } });
      for (const s of slots) {
        await prisma.periodSlot.create({
          data: {
            schoolId, classId: created.id, academicYear: s.academicYear,
            dayOfWeek: s.dayOfWeek, periodNumber: s.periodNumber,
            startTime: s.startTime, duration: s.duration,
            isBreak: s.isBreak, breakLabel: s.breakLabel,
            subjectId: s.subjectId, teacherId: null, room: null,
          },
        });
        copiedPeriods++;
      }
    }

    return rep.status(201).send({
      success: true,
      message: `${name} created from ${source.name}${copiedSubjects ? ` with ${copiedSubjects} subject(s)` : ""}${copiedPeriods ? ` and ${copiedPeriods} period(s)` : ""}. Teachers were left unassigned — pick them per section.`,
      data: { class: created, copiedSubjects, copiedPeriods },
    });
  });
}
