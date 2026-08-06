// apps/api/src/routes/admin/academics/subject-assignment.ts
// ─────────────────────────────────────────────────────────────
// Subject Assignment — premium pass.
//
// The core link (subject × class × teacher × weeklyPeriods) is
// unchanged, and every prior route keeps working. Added:
//
//   GET  /overview        → Layer 1 stat rail
//   GET  /matrix           → one call, every class × subject cell for
//                            a session — what the grid renders from
//   GET  /teacher-load     → rebuilt: now cross-references PeriodSlot
//                            so "conflict" means a real overlapping
//                            timetable slot, not just a period-count
//                            guess
//   POST /bulk             → assign / reassign / clear across many
//                            (class, subject) cells at once
//   POST /copy-from-class   → duplicate one class's whole subject list
//                            onto other sections of the same grade
//   POST /auto-assign       → fill every uncovered (class, subject)
//                            cell with the teacher carrying the
//                            lightest load, respecting subject
//                            eligibility (Subject.classNumber)
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminSubjectAssignmentRoutes(app: FastifyInstance) {
  const P = "/admin/subject-assignments";
  const guard = { preHandler: [authenticate, requireCapability("academics.core")] };

  async function currentYear(schoolId: number, override?: string) {
    if (override) {
      const y = await prisma.academicYear.findFirst({ where: { schoolId, id: Number(override) } });
      return y;
    }
    return prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
  }

  // ── GET /admin/subject-assignments ───────────────────────
  app.get(P, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { classId?: string; teacherId?: string; academicYearId?: string; subjectId?: string };

    const assignments = await prisma.subjectAssignment.findMany({
      where: {
        schoolId, isActive: true,
        ...(q.classId ? { classId: parseInt(q.classId) } : {}),
        ...(q.teacherId ? { teacherId: parseInt(q.teacherId) } : {}),
        ...(q.academicYearId ? { academicYearId: parseInt(q.academicYearId) } : {}),
        ...(q.subjectId ? { subjectId: parseInt(q.subjectId) } : {}),
      },
      include: {
        subject: { select: { id: true, name: true, code: true, classNumber: true, isElective: true } },
        class: { select: { id: true, name: true, section: true, classNumber: true } },
        teacher: { include: { user: { select: { name: true, avatarUrl: true } } } },
        academicYear: { select: { id: true, name: true } },
      },
      orderBy: [{ class: { classNumber: "asc" } }, { class: { section: "asc" } }, { subject: { name: "asc" } }],
    });

    return rep.send({ success: true, data: { assignments } });
  });

  // ── GET /admin/subject-assignments/overview ──────────────
  app.get(`${P}/overview`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string };

    const session = await currentYear(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "No academic session found." });

    const [classes, subjects, assignments, periodSlots] = await Promise.all([
      prisma.class.findMany({ where: { schoolId, academicYear: session.name, isActive: true }, select: { id: true, classNumber: true } }),
      prisma.subject.findMany({ where: { schoolId, isActive: true }, select: { id: true, classNumber: true } }),
      prisma.subjectAssignment.findMany({
        where: { schoolId, academicYearId: session.id, isActive: true },
        select: { classId: true, subjectId: true, teacherId: true, weeklyPeriods: true, class: { select: { classNumber: true } } },
      }),
      prisma.periodSlot.groupBy({
        by: ["teacherId", "dayOfWeek", "periodNumber"],
        where: { schoolId, academicYear: session.name, teacherId: { not: null }, isBreak: false },
        _count: { _all: true },
      }),
    ]);

    // Total possible cells = for every class, how many subjects apply to its grade.
    const subjectsByGrade = new Map<string, number>();
    for (const s of subjects) subjectsByGrade.set(s.classNumber, (subjectsByGrade.get(s.classNumber) ?? 0) + 1);
    const totalCells = classes.reduce((sum, c) => sum + (subjectsByGrade.get(c.classNumber) ?? 0), 0);
    const filledCells = assignments.length;

    const teacherLoad = new Map<number, number>();
    for (const a of assignments) teacherLoad.set(a.teacherId, (teacherLoad.get(a.teacherId) ?? 0) + a.weeklyPeriods);
    const loads = [...teacherLoad.values()];
    const avgLoad = loads.length ? Math.round(loads.reduce((a, b) => a + b, 0) / loads.length) : 0;
    const overloaded = loads.filter((l) => l > 30).length; // ~6 periods/day, 5 days
    const underused = [...teacherLoad.entries()].filter(([, l]) => l > 0 && l < 10).length;

    const doubleBooked = periodSlots.filter((p) => p._count._all > 1).length;

    const noSubjects = classes.filter((c) => !assignments.some((a) => a.classId === c.id) && (subjectsByGrade.get(c.classNumber) ?? 0) > 0).length;
    const electiveCount = assignments.filter((a: any) => a.class?.classNumber && subjects.find((s) => s.id === a.subjectId)).length;

    return rep.send({
      success: true,
      data: {
        session: { id: session.id, name: session.name },
        totalCells, filledCells, uncoveredCells: Math.max(0, totalCells - filledCells),
        coveragePct: totalCells > 0 ? Math.round((filledCells / totalCells) * 100) : 0,
        teacherCount: teacherLoad.size,
        avgLoad, overloaded, underused,
        doubleBooked,
        classesWithNothing: noSubjects,
      },
    });
  });

  // ── GET /admin/subject-assignments/matrix ────────────────
  // The whole grid — classes as rows, subjects (deduped across grades)
  // as columns — in one round trip.
  app.get(`${P}/matrix`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string; classNumber?: string };

    const session = await currentYear(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "No academic session found." });

    const [classes, subjects, assignments] = await Promise.all([
      prisma.class.findMany({
        where: { schoolId, academicYear: session.name, isActive: true, ...(q.classNumber ? { classNumber: q.classNumber } : {}) },
        select: { id: true, name: true, classNumber: true, section: true },
        orderBy: [{ classNumber: "asc" }, { section: "asc" }],
      }),
      prisma.subject.findMany({
        where: { schoolId, isActive: true },
        select: { id: true, name: true, code: true, classNumber: true, isElective: true },
        orderBy: [{ classNumber: "asc" }, { name: "asc" }],
      }),
      prisma.subjectAssignment.findMany({
        where: { schoolId, academicYearId: session.id, isActive: true },
        include: { teacher: { include: { user: { select: { id: true, name: true } } } } },
      }),
    ]);

    const cellKey = (classId: number, subjectId: number) => `${classId}:${subjectId}`;
    const cells = new Map(assignments.map((a) => [cellKey(a.classId, a.subjectId), a]));

    const rows = classes.map((c) => ({
      class: c,
      cells: subjects
        .filter((s) => s.classNumber === c.classNumber)
        .map((s) => {
          const a = cells.get(cellKey(c.id, s.id));
          return {
            subjectId: s.id, subjectName: s.name, isElective: s.isElective,
            assignmentId: a?.id ?? null,
            teacherId: a?.teacherId ?? null,
            teacherName: a?.teacher?.user?.name ?? null,
            weeklyPeriods: a?.weeklyPeriods ?? 0,
          };
        }),
    }));

    return rep.send({ success: true, data: { session: { id: session.id, name: session.name }, subjects, rows } });
  });

  // ── GET /admin/subject-assignments/teacher-load ──────────
  app.get(`${P}/teacher-load`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { teacherId, academicYearId } = req.query as { teacherId: string; academicYearId: string };
    if (!teacherId || !academicYearId) return rep.status(400).send({ success: false, message: "Pick a teacher and a session." });

    const session = await prisma.academicYear.findFirst({ where: { schoolId, id: parseInt(academicYearId) } });
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

    const [assignments, slots] = await Promise.all([
      prisma.subjectAssignment.findMany({
        where: { schoolId, teacherId: parseInt(teacherId), academicYearId: parseInt(academicYearId), isActive: true },
        include: { subject: { select: { name: true } }, class: { select: { name: true, section: true } } },
      }),
      prisma.periodSlot.findMany({
        where: { schoolId, teacherId: parseInt(teacherId), academicYear: session.name, isBreak: false },
        include: { class: { select: { name: true } } },
      }),
    ]);

    const totalWeeklyPeriods = assignments.reduce((s, a) => s + a.weeklyPeriods, 0);

    // Real conflicts: the same day+period appearing more than once in
    // this teacher's actual timetable slots.
    const slotMap = new Map<string, { className: string }[]>();
    for (const s of slots) {
      const key = `${s.dayOfWeek}-${s.periodNumber}`;
      (slotMap.get(key) ?? slotMap.set(key, []).get(key)!).push({ className: s.class.name });
    }
    const conflicts = [...slotMap.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([key, classes]) => {
        const [dayOfWeek, periodNumber] = key.split("-").map(Number);
        return { dayOfWeek, periodNumber, classes: classes.map((c) => c.className) };
      });

    return rep.send({
      success: true,
      data: { assignments, totalWeeklyPeriods, scheduledPeriods: slots.length, conflicts },
    });
  });

  // ── POST /admin/subject-assignments ───────────────────────
  app.post(P, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { subjectId: number; classId: number; teacherId: number; academicYearId: number; weeklyPeriods?: number };

    if (!b.subjectId || !b.classId || !b.teacherId || !b.academicYearId) {
      return rep.status(400).send({ success: false, message: "Pick a subject, a class, a teacher and a session." });
    }

    const [subject, cls, teacher] = await Promise.all([
      prisma.subject.findFirst({ where: { id: b.subjectId, schoolId } }),
      prisma.class.findFirst({ where: { id: b.classId, schoolId } }),
      prisma.staff.findFirst({ where: { id: b.teacherId, schoolId } }),
    ]);
    if (!subject) return rep.status(404).send({ success: false, message: "Subject not found." });
    if (!cls) return rep.status(404).send({ success: false, message: "Class not found." });
    if (!teacher) return rep.status(404).send({ success: false, message: "Teacher not found." });
    if (subject.classNumber !== cls.classNumber) {
      return rep.status(400).send({ success: false, message: `"${subject.name}" belongs to Class ${subject.classNumber} — it can't go on ${cls.name}.` });
    }

    const existing = await prisma.subjectAssignment.findFirst({
      where: { subjectId: b.subjectId, classId: b.classId, academicYearId: b.academicYearId },
    });
    if (existing) {
      if (existing.isActive) return rep.status(409).send({ success: false, message: "This subject is already assigned for this class." });
      const reactivated = await prisma.subjectAssignment.update({
        where: { id: existing.id },
        data: { isActive: true, teacherId: b.teacherId, weeklyPeriods: b.weeklyPeriods ?? existing.weeklyPeriods },
      });
      return rep.status(201).send({ success: true, message: "Assignment restored.", data: { assignment: reactivated } });
    }

    const assignment = await prisma.subjectAssignment.create({
      data: {
        schoolId, subjectId: b.subjectId, classId: b.classId, teacherId: b.teacherId,
        academicYearId: b.academicYearId, weeklyPeriods: b.weeklyPeriods ?? 0,
      },
    });
    return rep.status(201).send({ success: true, message: `${subject.name} assigned to ${cls.name}.`, data: { assignment } });
  });

  // ── PUT /admin/subject-assignments/:id ────────────────────
  app.put(`${P}/:id`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { id } = req.params as { id: string };
    const b = req.body as { teacherId?: number; weeklyPeriods?: number };

    const existing = await prisma.subjectAssignment.findFirst({ where: { id: parseInt(id), schoolId } });
    if (!existing) return rep.status(404).send({ success: false, message: "Assignment not found." });

    const assignment = await prisma.subjectAssignment.update({
      where: { id: parseInt(id) },
      data: {
        ...(b.teacherId !== undefined ? { teacherId: b.teacherId } : {}),
        ...(b.weeklyPeriods !== undefined ? { weeklyPeriods: b.weeklyPeriods } : {}),
      },
    });
    return rep.send({ success: true, message: "Assignment updated.", data: { assignment } });
  });

  // ── DELETE /admin/subject-assignments/:id ─────────────────
  app.delete(`${P}/:id`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { id } = req.params as { id: string };
    const existing = await prisma.subjectAssignment.findFirst({ where: { id: parseInt(id), schoolId } });
    if (!existing) return rep.status(404).send({ success: false, message: "Assignment not found." });

    await prisma.subjectAssignment.update({ where: { id: parseInt(id) }, data: { isActive: false } });
    return rep.send({ success: true, message: "Assignment removed." });
  });

  // ── POST /admin/subject-assignments/bulk ──────────────────
  app.post(`${P}/bulk`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as {
      action: "assign" | "clear" | "set-periods";
      academicYearId: number;
      cells: { classId: number; subjectId: number }[];
      teacherId?: number;
      weeklyPeriods?: number;
    };

    if (!b.academicYearId || !b.cells?.length) {
      return rep.status(400).send({ success: false, message: "Select at least one cell." });
    }
    if (b.action === "assign" && !b.teacherId) {
      return rep.status(400).send({ success: false, message: "Pick a teacher to assign." });
    }

    const results: { classId: number; subjectId: number; ok: boolean; reason?: string }[] = [];

    for (const cell of b.cells) {
      try {
        if (b.action === "clear") {
          await prisma.subjectAssignment.updateMany({
            where: { schoolId, academicYearId: b.academicYearId, classId: cell.classId, subjectId: cell.subjectId },
            data: { isActive: false },
          });
        } else {
          const [subject, cls] = await Promise.all([
            prisma.subject.findFirst({ where: { id: cell.subjectId, schoolId } }),
            prisma.class.findFirst({ where: { id: cell.classId, schoolId } }),
          ]);
          if (!subject || !cls) throw new Error("not found");
          if (subject.classNumber !== cls.classNumber) throw new Error("grade mismatch");

          const existing = await prisma.subjectAssignment.findFirst({
            where: { schoolId, academicYearId: b.academicYearId, classId: cell.classId, subjectId: cell.subjectId },
          });
          if (existing) {
            await prisma.subjectAssignment.update({
              where: { id: existing.id },
              data: {
                isActive: true,
                ...(b.teacherId ? { teacherId: b.teacherId } : {}),
                ...(b.weeklyPeriods !== undefined ? { weeklyPeriods: b.weeklyPeriods } : {}),
              },
            });
          } else {
            await prisma.subjectAssignment.create({
              data: {
                schoolId, academicYearId: b.academicYearId, classId: cell.classId, subjectId: cell.subjectId,
                teacherId: b.teacherId!, weeklyPeriods: b.weeklyPeriods ?? 0,
              },
            });
          }
        }
        results.push({ classId: cell.classId, subjectId: cell.subjectId, ok: true });
      } catch (e: any) {
        results.push({ classId: cell.classId, subjectId: cell.subjectId, ok: false, reason: e.message === "grade mismatch" ? "subject doesn't belong to this grade" : "not found" });
      }
    }

    const done = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    return rep.send({
      success: done > 0,
      message: `${done} cell${done === 1 ? "" : "s"} updated${failed ? `, ${failed} skipped` : ""}.`,
      data: { results },
    });
  });

  // ── POST /admin/subject-assignments/copy-from-class ──────
  app.post(`${P}/copy-from-class`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { sourceClassId: number; targetClassIds: number[]; academicYearId: number; keepTeacher?: boolean };

    if (!b.sourceClassId || !b.targetClassIds?.length || !b.academicYearId) {
      return rep.status(400).send({ success: false, message: "Pick a source class and at least one target." });
    }

    const source = await prisma.class.findFirst({ where: { id: b.sourceClassId, schoolId } });
    if (!source) return rep.status(404).send({ success: false, message: "Source class not found." });

    const sourceAssignments = await prisma.subjectAssignment.findMany({
      where: { schoolId, classId: b.sourceClassId, academicYearId: b.academicYearId, isActive: true },
    });
    if (sourceAssignments.length === 0) {
      return rep.status(400).send({ success: false, message: `${source.name} has no subjects assigned to copy.` });
    }

    let copied = 0, skipped = 0;
    for (const targetId of b.targetClassIds) {
      const target = await prisma.class.findFirst({ where: { id: targetId, schoolId } });
      if (!target || target.classNumber !== source.classNumber) { skipped += sourceAssignments.length; continue; }

      for (const a of sourceAssignments) {
        const existing = await prisma.subjectAssignment.findFirst({
          where: { schoolId, academicYearId: b.academicYearId, classId: targetId, subjectId: a.subjectId },
        });
        if (existing?.isActive) { skipped++; continue; }
        if (existing) {
          await prisma.subjectAssignment.update({
            where: { id: existing.id },
            data: { isActive: true, ...(b.keepTeacher ?? true ? { teacherId: a.teacherId } : {}), weeklyPeriods: a.weeklyPeriods },
          });
        } else {
          await prisma.subjectAssignment.create({
            data: {
              schoolId, academicYearId: b.academicYearId, classId: targetId, subjectId: a.subjectId,
              teacherId: a.teacherId, weeklyPeriods: a.weeklyPeriods,
            },
          });
        }
        copied++;
      }
    }

    return rep.status(201).send({
      success: copied > 0,
      message: `${copied} subject assignment(s) copied${skipped ? `, ${skipped} skipped (already set or wrong grade)` : ""}.${b.keepTeacher !== false ? " Same teacher carried over — reassign per section if that's not what you want." : ""}`,
      data: { copied, skipped },
    });
  });

  // ── POST /admin/subject-assignments/auto-assign ───────────
  // Fills every uncovered cell for a grade with whichever eligible
  // teacher currently carries the lightest weekly load — a fast first
  // pass, not a scheduling solver. Nothing already assigned is touched.
  app.post(`${P}/auto-assign`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { academicYearId: number; classNumber?: string; defaultWeeklyPeriods?: number };

    if (!b.academicYearId) return rep.status(400).send({ success: false, message: "Pick a session." });

    const [classes, subjects, allAssignments, staff] = await Promise.all([
      prisma.class.findMany({
        where: { schoolId, isActive: true, ...(b.classNumber ? { classNumber: b.classNumber } : {}) },
        select: { id: true, name: true, classNumber: true },
      }),
      prisma.subject.findMany({ where: { schoolId, isActive: true }, select: { id: true, name: true, classNumber: true } }),
      prisma.subjectAssignment.findMany({ where: { schoolId, academicYearId: b.academicYearId, isActive: true } }),
      prisma.staff.findMany({ where: { schoolId, isActive: true, employeeType: "TEACHING" }, select: { id: true } }),
    ]);

    if (staff.length === 0) return rep.status(400).send({ success: false, message: "No active teaching staff to assign." });

    const load = new Map<number, number>(staff.map((s) => [s.id, 0]));
    for (const a of allAssignments) load.set(a.teacherId, (load.get(a.teacherId) ?? 0) + a.weeklyPeriods);

    const covered = new Set(allAssignments.map((a) => `${a.classId}:${a.subjectId}`));
    const weeklyPeriods = b.defaultWeeklyPeriods ?? 4;

    let placed = 0;
    for (const c of classes) {
      const eligible = subjects.filter((s) => s.classNumber === c.classNumber);
      for (const s of eligible) {
        const key = `${c.id}:${s.id}`;
        if (covered.has(key)) continue;

        // Lightest-loaded eligible teacher, ties broken by id for determinism.
        const [lightest] = [...load.entries()].sort((a, b2) => a[1] - b2[1] || a[0] - b2[0]);
        if (!lightest) continue;

        await prisma.subjectAssignment.create({
          data: { schoolId, academicYearId: b.academicYearId, classId: c.id, subjectId: s.id, teacherId: lightest[0], weeklyPeriods },
        });
        load.set(lightest[0], lightest[1] + weeklyPeriods);
        covered.add(key);
        placed++;
      }
    }

    return rep.send({
      success: placed > 0,
      message: placed > 0
        ? `${placed} cell(s) filled — spread across ${staff.length} teacher(s) by current load. Review before treating it as final.`
        : "Nothing to fill — every eligible cell already has a teacher.",
      data: { placed },
    });
  });
}
