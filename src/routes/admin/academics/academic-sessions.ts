// apps/api/src/routes/admin/academics/academic-sessions.ts
// ─────────────────────────────────────────────────────────────
// Academic Sessions — premium pass.
//
// What changed vs the previous version:
//   • GET /            → deep per-session stats (sections, teachers,
//                        attendance / exam / fee record counts,
//                        promotion status, estimated storage,
//                        created-by, last-modified) + a phase field
//                        (ACTIVE / PREVIOUS / UPCOMING / ARCHIVED)
//   • GET /overview    → the Layer-1 stat rail, computed server side
//   • POST /bulk       → lock / unlock / archive / delete in one call,
//                        each item validated independently so one bad
//                        row never fails the whole batch
//   • POST /merge-preview → dry-run collision report before merging
//   • all writes stamp createdById / updatedAt
//
// Multi-tenant rule is unchanged: every query is scoped by schoolId.
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

/* Rough per-row footprint used for the "storage used" figure on the
   session card. It's an estimate and the UI labels it as one — but
   it's derived from real row counts, not invented. */
const ROW_BYTES = { attendance: 120, exam: 900, invoice: 400, student: 1400, promotion: 220 };

type Phase = "ACTIVE" | "UPCOMING" | "PREVIOUS" | "ARCHIVED";

function phaseOf(s: { isCurrent: boolean; status: string; startDate: Date; endDate: Date }): Phase {
  if (s.status === "CLOSED") return "ARCHIVED";
  if (s.isCurrent) return "ACTIVE";
  const now = Date.now();
  if (new Date(s.startDate).getTime() > now) return "UPCOMING";
  return "PREVIOUS";
}

export async function adminAcademicSessionRoutes(app: FastifyInstance) {
  const P = "/admin/academic-sessions";
  const guard = { preHandler: [authenticate, requireCapability("academics.core")] };

  /* ── Shared stat builder ─────────────────────────────────
     One place that knows how to describe a session, so the list,
     the detail view and the drawer never drift apart. */
  async function buildStats(schoolId: number, s: { id: number; name: string }) {
    const [
      classRows, students, staff, teacherAssignments, subjectAssignments,
      attendanceRecords, examRecords, invoiceAgg, feeStructures,
      promotedOut, promotedIn, holidays, calendarEvents,
    ] = await Promise.all([
      prisma.class.findMany({
        where: { schoolId, academicYear: s.name, isActive: true },
        select: { id: true, classNumber: true, section: true, capacity: true, _count: { select: { students: true } } },
      }),
      prisma.student.count({ where: { schoolId, class: { academicYear: s.name } } }),
      prisma.staff.count({ where: { schoolId, isActive: true } }),
      prisma.classTeacherAssignment.count({ where: { schoolId, academicYearId: s.id } }),
      prisma.subjectAssignment.count({ where: { schoolId, academicYearId: s.id } }),
      prisma.attendance.count({ where: { schoolId, class: { academicYear: s.name } } }),
      prisma.examConfig.count({ where: { schoolId, sessionName: s.name } }),
      prisma.invoice.aggregate({
        where: { schoolId, academicYearId: s.id },
        _sum: { totalAmount: true, paidAmount: true },
        _count: true,
      }),
      prisma.feeStructure.count({ where: { schoolId, academicYearId: s.id } }),
      prisma.promotionHistory.count({ where: { schoolId, fromSession: s.name, isRolledBack: false } }),
      prisma.promotionHistory.count({ where: { schoolId, toSession: s.name, isRolledBack: false } }),
      prisma.holiday.count({ where: { schoolId, academicYearId: s.id } }),
      prisma.calendarEvent.count({ where: { schoolId, academicYearId: s.id } }),
    ]);

    const sections = classRows.length;
    const classes = new Set(classRows.map((c) => c.classNumber)).size;
    const capacity = classRows.reduce((a, c) => a + (c.capacity ?? 0), 0);
    const classesWithStudents = classRows.filter((c) => c._count.students > 0).length;

    const storageKb = Math.round(
      (attendanceRecords * ROW_BYTES.attendance +
        examRecords * ROW_BYTES.exam +
        invoiceAgg._count * ROW_BYTES.invoice +
        students * ROW_BYTES.student +
        (promotedOut + promotedIn) * ROW_BYTES.promotion) / 1024,
    );

    // Promotion status is a share, not a flag — "how much of this
    // session has been moved forward yet".
    const promotionPct = students > 0 ? Math.round((promotedOut / students) * 100) : 0;
    const promotionStatus =
      promotedOut === 0 ? "NOT_STARTED" : promotionPct >= 95 ? "COMPLETED" : "IN_PROGRESS";

    return {
      classes, sections, students, staff, capacity, classesWithStudents,
      occupancyPct: capacity > 0 ? Math.round((students / capacity) * 100) : 0,
      teachers: teacherAssignments,
      subjectAssignments,
      attendanceRecords,
      examRecords,
      feeRecords: invoiceAgg._count,
      feeStructures,
      totalFees: Number(invoiceAgg._sum.totalAmount ?? 0),
      collectedFees: Number(invoiceAgg._sum.paidAmount ?? 0),
      holidays,
      calendarEvents,
      promotedOut, promotedIn, promotionPct, promotionStatus,
      storageKb,
    };
  }

  function progressOf(startDate: Date, endDate: Date) {
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    const now = Date.now();
    const totalDays = Math.max(1, Math.ceil((end - start) / 86400000));
    const elapsedDays = now <= start ? 0 : Math.min(Math.ceil((now - start) / 86400000), totalDays);
    return {
      totalDays,
      elapsedDays,
      remainingDays: Math.max(0, totalDays - elapsedDays),
      progress: Math.round((elapsedDays / totalDays) * 100),
    };
  }

  // ── GET /admin/academic-sessions ─────────────────────────
  app.get(P, guard, async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId } = request.user as any;
    const q = request.query as { includeStats?: string };
    const withStats = q.includeStats !== "false";

    const sessions = await prisma.academicYear.findMany({
      where: { schoolId },
      orderBy: { startDate: "desc" },
      include: {
        clonedFrom: { select: { id: true, name: true } },
        // createdBy exists after the schema addition; the optional chain
        // below keeps this route working before the migration lands.
        ...( { createdBy: { select: { id: true, name: true } } } as any ),
      },
    }).catch(() =>
      prisma.academicYear.findMany({
        where: { schoolId },
        orderBy: { startDate: "desc" },
        include: { clonedFrom: { select: { id: true, name: true } } },
      }),
    );

    const enriched = await Promise.all(
      sessions.map(async (s: any) => {
        const timing = progressOf(s.startDate, s.endDate);
        const stats = withStats
          ? await buildStats(schoolId, s)
          : null;
        return {
          ...s,
          phase: phaseOf(s),
          createdByName: s.createdBy?.name ?? null,
          lastModified: s.updatedAt ?? s.archivedAt ?? s.lockedAt ?? s.activatedAt ?? s.createdAt,
          stats: stats ? { ...stats, ...timing } : timing,
        };
      }),
    );

    return reply.send({ success: true, data: { sessions: enriched } });
  });

  // ── GET /admin/academic-sessions/overview ────────────────
  // Layer 1 of the page: counts by phase + school-wide totals.
  app.get(`${P}/overview`, guard, async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId } = request.user as any;

    const sessions = await prisma.academicYear.findMany({
      where: { schoolId },
      orderBy: { startDate: "desc" },
      select: { id: true, name: true, startDate: true, endDate: true, isCurrent: true, status: true },
    });

    const active = sessions.find((s) => s.isCurrent) ?? null;
    const byPhase = sessions.reduce<Record<Phase, number>>(
      (acc, s) => { acc[phaseOf(s)]++; return acc; },
      { ACTIVE: 0, UPCOMING: 0, PREVIOUS: 0, ARCHIVED: 0 },
    );

    const previous = sessions.filter((s) => phaseOf(s) === "PREVIOUS")[0] ?? null;
    const upcoming = [...sessions].reverse().find((s) => phaseOf(s) === "UPCOMING") ?? null;

    const activeStats = active ? await buildStats(schoolId, active) : null;
    const activeTiming = active ? progressOf(active.startDate, active.endDate) : null;

    return reply.send({
      success: true,
      data: {
        counts: byPhase,
        total: sessions.length,
        active: active ? { ...active, stats: { ...activeStats, ...activeTiming } } : null,
        previous, upcoming,
      },
    });
  });

  // ── GET /admin/academic-sessions/:id ─────────────────────
  app.get(`${P}/:id`, guard, async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId } = request.user as any;
    const { id } = request.params as { id: string };

    const session = await prisma.academicYear.findFirst({
      where: { id: parseInt(id), schoolId },
      include: {
        clonedFrom: { select: { id: true, name: true } },
        clonedInto: { select: { id: true, name: true } },
      },
    });
    if (!session) return reply.status(404).send({ success: false, message: "Session not found." });

    const [classes, stats] = await Promise.all([
      prisma.class.findMany({
        where: { schoolId, academicYear: session.name, isActive: true },
        include: { _count: { select: { students: true } } },
        orderBy: [{ classNumber: "asc" }, { section: "asc" }],
      }),
      buildStats(schoolId, session),
    ]);

    return reply.send({
      success: true,
      data: {
        session: { ...session, phase: phaseOf(session) },
        details: { classes, ...stats, ...progressOf(session.startDate, session.endDate) },
      },
    });
  });

  // ── GET /admin/academic-sessions/:id/timeline ────────────
  app.get(`${P}/:id/timeline`, guard, async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId } = request.user as any;
    const { id } = request.params as { id: string };

    const session = await prisma.academicYear.findFirst({
      where: { id: parseInt(id), schoolId },
      include: { clonedFrom: { select: { id: true, name: true } }, clonedInto: { select: { id: true, name: true } } },
    });
    if (!session) return reply.status(404).send({ success: false, message: "Session not found." });

    const events: { date: Date; label: string; detail?: string; tone?: string }[] = [
      {
        date: session.createdAt,
        label: session.clonedFrom ? `Created by cloning ${session.clonedFrom.name}` : "Session created",
        tone: "indigo",
      },
    ];
    if (session.activatedAt) events.push({ date: session.activatedAt, label: "Set as the active session", tone: "emerald" });
    if (session.lockedAt) events.push({ date: session.lockedAt, label: "Locked — records frozen", tone: "amber" });
    if (session.archivedAt) events.push({ date: session.archivedAt, label: "Archived", tone: "slate" });
    for (const child of session.clonedInto ?? []) {
      events.push({ date: session.createdAt, label: `Cloned forward into ${child.name}`, tone: "violet" });
    }
    events.push({ date: session.startDate, label: "Session starts", tone: "sky" });
    events.push({ date: session.endDate, label: "Session ends", tone: "sky" });

    // First and last real academic activity, so the timeline reflects
    // what the school actually did, not just admin button presses.
    const [firstAttendance, lastAttendance] = await Promise.all([
      prisma.attendance.findFirst({
        where: { schoolId, class: { academicYear: session.name } },
        orderBy: { date: "asc" }, select: { date: true },
      }),
      prisma.attendance.findFirst({
        where: { schoolId, class: { academicYear: session.name } },
        orderBy: { date: "desc" }, select: { date: true },
      }),
    ]);
    if (firstAttendance) events.push({ date: firstAttendance.date, label: "First attendance marked", tone: "teal" });
    if (lastAttendance && lastAttendance.date.getTime() !== firstAttendance?.date.getTime()) {
      events.push({ date: lastAttendance.date, label: "Most recent attendance marked", tone: "teal" });
    }

    events.sort((a, b) => a.date.getTime() - b.date.getTime());
    return reply.send({ success: true, data: { timeline: events } });
  });

  // ── POST /admin/academic-sessions ────────────────────────
  app.post(P, guard, async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId, userId } = request.user as any;
    const body = request.body as { name: string; startDate: string; endDate: string; setAsCurrent?: boolean };

    if (!body.name?.trim() || !body.startDate || !body.endDate) {
      return reply.status(400).send({ success: false, message: "Name, start date and end date are all required." });
    }
    const start = new Date(body.startDate);
    const end = new Date(body.endDate);
    if (start >= end) return reply.status(400).send({ success: false, message: "End date must fall after the start date." });

    const existing = await prisma.academicYear.findFirst({ where: { schoolId, name: body.name.trim() } });
    if (existing) return reply.status(409).send({ success: false, message: `Session "${body.name}" already exists.` });

    // Overlap check — two live sessions covering the same dates makes
    // attendance and fee reporting ambiguous later.
    const overlap = await prisma.academicYear.findFirst({
      where: { schoolId, status: { not: "CLOSED" }, startDate: { lte: end }, endDate: { gte: start } },
      select: { name: true },
    });

    if (body.setAsCurrent) {
      await prisma.academicYear.updateMany({ where: { schoolId }, data: { isCurrent: false } });
    }

    const session = await prisma.academicYear.create({
      data: {
        schoolId,
        name: body.name.trim(),
        startDate: start,
        endDate: end,
        isCurrent: body.setAsCurrent ?? false,
        status: body.setAsCurrent ? "OPEN" : "DRAFT",
        activatedAt: body.setAsCurrent ? new Date() : null,
        ...( { createdById: userId } as any ),
      },
    });

    return reply.status(201).send({
      success: true,
      message: overlap
        ? `Session "${session.name}" created. Heads up: its dates overlap "${overlap.name}".`
        : `Session "${session.name}" created.`,
      data: { session, overlapsWith: overlap?.name ?? null },
    });
  });

  // ── POST /admin/academic-sessions/:id/clone ──────────────
  app.post(`${P}/:id/clone`, guard, async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId, userId } = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as {
      name: string; startDate: string; endDate: string;
      cloneClasses?: boolean; cloneSubjectAssignments?: boolean;
      cloneClassTeachers?: boolean; clonePolicies?: boolean; cloneWorkingDays?: boolean;
    };

    const source = await prisma.academicYear.findFirst({ where: { id: parseInt(id), schoolId } });
    if (!source) return reply.status(404).send({ success: false, message: "Source session not found." });
    if (!body.name?.trim() || !body.startDate || !body.endDate) {
      return reply.status(400).send({ success: false, message: "Name, start date and end date are all required." });
    }
    const existing = await prisma.academicYear.findFirst({ where: { schoolId, name: body.name.trim() } });
    if (existing) return reply.status(409).send({ success: false, message: `Session "${body.name}" already exists.` });

    const newSession = await prisma.academicYear.create({
      data: {
        schoolId, name: body.name.trim(),
        startDate: new Date(body.startDate), endDate: new Date(body.endDate),
        status: "DRAFT", clonedFromId: source.id,
        ...( { createdById: userId } as any ),
      },
    });

    const copied = { classes: 0, classTeachers: 0, subjectAssignments: 0, policies: 0, workingDays: 0 };
    const classIdMap = new Map<number, number>();

    if (body.cloneClasses ?? true) {
      const sourceClasses = await prisma.class.findMany({
        where: { schoolId, academicYear: source.name, isActive: true },
      });
      for (const c of sourceClasses) {
        const dupe = await prisma.class.findFirst({ where: { schoolId, name: c.name, academicYear: newSession.name } });
        if (dupe) { classIdMap.set(c.id, dupe.id); continue; }
        const created = await prisma.class.create({
          data: {
            schoolId, name: c.name, classNumber: c.classNumber, section: c.section,
            stream: c.stream, room: c.room, shift: c.shift, capacity: c.capacity,
            academicYear: newSession.name,
          },
        });
        classIdMap.set(c.id, created.id);
        copied.classes++;
      }
    }

    // Subject assignments carry the teaching plan forward — the single
    // biggest time sink when a school opens a new year.
    if (body.cloneSubjectAssignments && classIdMap.size > 0) {
      const assignments = await prisma.subjectAssignment.findMany({
        where: { schoolId, academicYearId: source.id },
      });
      for (const a of assignments) {
        const targetClassId = classIdMap.get(a.classId);
        if (!targetClassId) continue;
        const dupe = await prisma.subjectAssignment.findFirst({
          where: { schoolId, academicYearId: newSession.id, classId: targetClassId, subjectId: a.subjectId },
        });
        if (dupe) continue;
        await prisma.subjectAssignment.create({
          data: {
            schoolId, academicYearId: newSession.id, classId: targetClassId,
            subjectId: a.subjectId, teacherId: a.teacherId,
          },
        });
        copied.subjectAssignments++;
      }
    }

    if (body.cloneClassTeachers && classIdMap.size > 0) {
      const cts = await prisma.classTeacherAssignment.findMany({
        where: { schoolId, academicYearId: source.id },
      });
      for (const ct of cts) {
        const targetClassId = classIdMap.get(ct.classId);
        if (!targetClassId) continue;
        const dupe = await prisma.classTeacherAssignment.findFirst({
          where: { schoolId, academicYearId: newSession.id, classId: targetClassId, staffId: ct.staffId },
        });
        if (dupe) continue;
        await prisma.classTeacherAssignment.create({
          data: {
            schoolId, academicYearId: newSession.id, classId: targetClassId,
            staffId: ct.staffId, role: ct.role,
          },
        });
        copied.classTeachers++;
      }
    }

    if (body.clonePolicies) {
      const policy = await prisma.academicPolicy.findUnique({ where: { academicYearId: source.id } });
      if (policy) {
        const { id: _drop, academicYearId: _drop2, updatedAt: _drop3, ...rest } = policy as any;
        await prisma.academicPolicy.create({ data: { ...rest, academicYearId: newSession.id } });
        copied.policies = 1;
      }
    }

    if (body.cloneWorkingDays) {
      const wd = await prisma.workingDayConfig.findUnique({ where: { academicYearId: source.id } });
      if (wd) {
        await prisma.workingDayConfig.create({
          data: {
            schoolId, academicYearId: newSession.id,
            workingDays: wd.workingDays as any,
            saturdayPattern: wd.saturdayPattern,
            sundayOff: wd.sundayOff,
          },
        });
        copied.workingDays = 1;
      }
    }

    const parts = Object.entries(copied).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
    return reply.status(201).send({
      success: true,
      message: `Session "${newSession.name}" created from "${source.name}"${parts.length ? ` — copied ${parts.join(", ")}` : ""}.`,
      data: { session: newSession, copied },
    });
  });

  // ── PUT /admin/academic-sessions/:id ─────────────────────
  app.put(`${P}/:id`, guard, async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId } = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; startDate?: string; endDate?: string };

    const session = await prisma.academicYear.findFirst({ where: { id: parseInt(id), schoolId } });
    if (!session) return reply.status(404).send({ success: false, message: "Session not found." });
    if (session.status === "LOCKED") {
      return reply.status(400).send({ success: false, message: "This session is locked. Unlock it to make changes." });
    }
    if (body.name && body.name !== session.name) {
      const dup = await prisma.academicYear.findFirst({
        where: { schoolId, name: body.name.trim(), id: { not: parseInt(id) } },
      });
      if (dup) return reply.status(409).send({ success: false, message: `Session "${body.name}" already exists.` });

      // Class rows key off the session *name*, so a rename has to
      // carry them along or the whole year silently detaches.
      await prisma.class.updateMany({
        where: { schoolId, academicYear: session.name },
        data: { academicYear: body.name.trim() },
      });
    }

    const updated = await prisma.academicYear.update({
      where: { id: parseInt(id) },
      data: {
        ...(body.name && { name: body.name.trim() }),
        ...(body.startDate && { startDate: new Date(body.startDate) }),
        ...(body.endDate && { endDate: new Date(body.endDate) }),
      },
    });
    return reply.send({ success: true, message: "Session updated.", data: { session: updated } });
  });

  // ── PATCH /:id/activate ──────────────────────────────────
  app.patch(`${P}/:id/activate`, guard, async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId } = request.user as any;
    const { id } = request.params as { id: string };

    const session = await prisma.academicYear.findFirst({ where: { id: parseInt(id), schoolId } });
    if (!session) return reply.status(404).send({ success: false, message: "Session not found." });
    if (session.status === "LOCKED" || session.status === "CLOSED") {
      return reply.status(400).send({
        success: false,
        message: `A ${session.status.toLowerCase()} session can't be activated. Unlock or restore it first.`,
      });
    }

    await prisma.academicYear.updateMany({ where: { schoolId }, data: { isCurrent: false } });
    const updated = await prisma.academicYear.update({
      where: { id: parseInt(id) },
      data: { isCurrent: true, status: "OPEN", activatedAt: new Date() },
    });

    return reply.send({ success: true, message: `"${updated.name}" is now the active session.`, data: { session: updated } });
  });

  // ── PATCH /:id/lock ──────────────────────────────────────
  app.patch(`${P}/:id/lock`, guard, async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId } = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as { locked: boolean };

    const session = await prisma.academicYear.findFirst({ where: { id: parseInt(id), schoolId } });
    if (!session) return reply.status(404).send({ success: false, message: "Session not found." });
    if (session.isCurrent && body.locked) {
      return reply.status(400).send({ success: false, message: "The active session can't be locked. Activate another session first." });
    }

    const updated = await prisma.academicYear.update({
      where: { id: parseInt(id) },
      data: body.locked
        ? { status: "LOCKED", lockedAt: new Date() }
        : { status: session.archivedAt ? "CLOSED" : "DRAFT", lockedAt: null },
    });

    return reply.send({
      success: true,
      message: body.locked ? `"${session.name}" locked.` : `"${session.name}" unlocked.`,
      data: { session: updated },
    });
  });

  // ── PATCH /:id/archive ───────────────────────────────────
  app.patch(`${P}/:id/archive`, guard, async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId } = request.user as any;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { restore?: boolean };

    const session = await prisma.academicYear.findFirst({ where: { id: parseInt(id), schoolId } });
    if (!session) return reply.status(404).send({ success: false, message: "Session not found." });

    if (body.restore) {
      const updated = await prisma.academicYear.update({
        where: { id: parseInt(id) },
        data: { status: "DRAFT", archivedAt: null },
      });
      return reply.send({ success: true, message: `"${session.name}" restored to draft.`, data: { session: updated } });
    }

    if (session.isCurrent) {
      return reply.status(400).send({ success: false, message: "The active session can't be archived. Activate another session first." });
    }

    const updated = await prisma.academicYear.update({
      where: { id: parseInt(id) },
      data: { status: "CLOSED", archivedAt: new Date() },
    });
    return reply.send({ success: true, message: `"${session.name}" archived.`, data: { session: updated } });
  });

  // ── DELETE /:id ──────────────────────────────────────────
  app.delete(`${P}/:id`, guard, async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId } = request.user as any;
    const { id } = request.params as { id: string };

    const session = await prisma.academicYear.findFirst({ where: { id: parseInt(id), schoolId } });
    if (!session) return reply.status(404).send({ success: false, message: "Session not found." });
    if (session.isCurrent) return reply.status(400).send({ success: false, message: "The active session can't be deleted." });
    if (session.status === "LOCKED") return reply.status(400).send({ success: false, message: "Unlock this session before deleting it." });

    const classCount = await prisma.class.count({ where: { schoolId, academicYear: session.name } });
    if (classCount > 0) {
      return reply.status(400).send({
        success: false,
        message: `${classCount} class(es) belong to this session. Archive it instead of deleting.`,
      });
    }

    await prisma.academicYear.delete({ where: { id: parseInt(id) } });
    return reply.send({ success: true, message: `"${session.name}" deleted.` });
  });

  // ── POST /admin/academic-sessions/bulk ───────────────────
  // Each id is validated on its own, so a batch returns a per-row
  // result instead of failing whole because one session was locked.
  app.post(`${P}/bulk`, guard, async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId } = request.user as any;
    const body = request.body as { action: "lock" | "unlock" | "archive" | "restore" | "delete"; ids: number[] };

    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return reply.status(400).send({ success: false, message: "Select at least one session." });
    }

    const sessions = await prisma.academicYear.findMany({ where: { schoolId, id: { in: body.ids } } });
    const results: { id: number; name: string; ok: boolean; reason?: string }[] = [];

    for (const s of sessions) {
      try {
        if (body.action === "lock") {
          if (s.isCurrent) throw new Error("It's the active session");
          await prisma.academicYear.update({ where: { id: s.id }, data: { status: "LOCKED", lockedAt: new Date() } });
        } else if (body.action === "unlock") {
          await prisma.academicYear.update({
            where: { id: s.id },
            data: { status: s.archivedAt ? "CLOSED" : "DRAFT", lockedAt: null },
          });
        } else if (body.action === "archive") {
          if (s.isCurrent) throw new Error("It's the active session");
          await prisma.academicYear.update({ where: { id: s.id }, data: { status: "CLOSED", archivedAt: new Date() } });
        } else if (body.action === "restore") {
          await prisma.academicYear.update({ where: { id: s.id }, data: { status: "DRAFT", archivedAt: null } });
        } else if (body.action === "delete") {
          if (s.isCurrent) throw new Error("It's the active session");
          if (s.status === "LOCKED") throw new Error("It's locked");
          const classCount = await prisma.class.count({ where: { schoolId, academicYear: s.name } });
          if (classCount > 0) throw new Error(`${classCount} class(es) still attached`);
          await prisma.academicYear.delete({ where: { id: s.id } });
        }
        results.push({ id: s.id, name: s.name, ok: true });
      } catch (e: any) {
        results.push({ id: s.id, name: s.name, ok: false, reason: e.message ?? "Failed" });
      }
    }

    const done = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    return reply.send({
      success: done > 0,
      message:
        failed.length === 0
          ? `${done} session${done === 1 ? "" : "s"} updated.`
          : `${done} updated, ${failed.length} skipped — ${failed.map((f) => `${f.name}: ${f.reason}`).join("; ")}.`,
      data: { results },
    });
  });

  // ── POST /admin/academic-sessions/merge-preview ──────────
  // Merging sessions rewrites history, so this only reports what
  // would collide. Nothing is written until the admin confirms via
  // the normal per-record tools.
  app.post(`${P}/merge-preview`, guard, async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId } = request.user as any;
    const body = request.body as { sourceId: number; targetId: number };

    const [source, target] = await Promise.all([
      prisma.academicYear.findFirst({ where: { id: body.sourceId, schoolId } }),
      prisma.academicYear.findFirst({ where: { id: body.targetId, schoolId } }),
    ]);
    if (!source || !target) return reply.status(404).send({ success: false, message: "Both sessions must exist." });
    if (source.id === target.id) return reply.status(400).send({ success: false, message: "Pick two different sessions." });

    const [sourceClasses, targetClasses] = await Promise.all([
      prisma.class.findMany({ where: { schoolId, academicYear: source.name }, select: { name: true, _count: { select: { students: true } } } }),
      prisma.class.findMany({ where: { schoolId, academicYear: target.name }, select: { name: true } }),
    ]);

    const targetNames = new Set(targetClasses.map((c) => c.name));
    const collisions = sourceClasses.filter((c) => targetNames.has(c.name));
    const movable = sourceClasses.filter((c) => !targetNames.has(c.name));

    return reply.send({
      success: true,
      data: {
        source: { id: source.id, name: source.name },
        target: { id: target.id, name: target.name },
        movableClasses: movable.map((c) => c.name),
        collidingClasses: collisions.map((c) => ({ name: c.name, students: c._count.students })),
        studentsAffected: sourceClasses.reduce((a, c) => a + c._count.students, 0),
        safe: collisions.length === 0,
      },
    });
  });
}
