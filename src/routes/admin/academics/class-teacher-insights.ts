// apps/api/src/routes/admin/academics/class-teacher-insights.ts
// ─────────────────────────────────────────────────────────────
// Class Teacher Assignment — the health layer on top of the
// existing class-teacher-assignment.ts (get/create/delete/staff-load
// all untouched — PRIMARY still syncs to Class.classTeacherId).
//
//   GET  /admin/class-teacher-assignments/overview → Layer 1 stat rail
//   POST /admin/class-teacher-assignments/bulk-assign → assign PRIMARY
//        across many classes in one call
//   POST /admin/class-teacher-assignments/swap → swap two teachers'
//        PRIMARY assignments between their classes in one transaction
//
// Register alongside adminClassTeacherAssignmentRoutes:
//   await app.register(adminClassTeacherInsightRoutes);
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminClassTeacherInsightRoutes(app: FastifyInstance) {
  const P = "/admin/class-teacher-assignments";
  const guard = { preHandler: [authenticate, requireCapability("academics.core")] };

  async function currentYear(schoolId: number, override?: string) {
    if (override) return prisma.academicYear.findFirst({ where: { schoolId, id: Number(override) } });
    return prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
  }

  // ── GET /admin/class-teacher-assignments/overview ────────
  app.get(`${P}/overview`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string };

    const session = await currentYear(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "No academic session found." });

    const [classes, assignments] = await Promise.all([
      prisma.class.findMany({
        where: { schoolId, academicYear: session.name, isActive: true },
        select: { id: true, name: true, capacity: true, _count: { select: { students: true } } },
      }),
      prisma.classTeacherAssignment.findMany({
        where: { schoolId, academicYearId: session.id },
        include: { staff: { select: { id: true } } },
      }),
    ]);

    const withPrimary = new Set(assignments.filter((a) => a.role === "PRIMARY").map((a) => a.classId));
    const withAssistant = new Set(assignments.filter((a) => a.role === "ASSISTANT").map((a) => a.classId));
    const withCoordinator = new Set(assignments.filter((a) => a.role === "COORDINATOR").map((a) => a.classId));

    const noPrimary = classes.filter((c) => !withPrimary.has(c.id));

    const loadByStaff = new Map<number, number>();
    for (const a of assignments.filter((x) => x.role === "PRIMARY")) {
      loadByStaff.set(a.staffId, (loadByStaff.get(a.staffId) ?? 0) + 1);
    }
    const multiClassPrimaries = [...loadByStaff.values()].filter((n) => n > 1).length;

    return rep.send({
      success: true,
      data: {
        session: { id: session.id, name: session.name },
        totalClasses: classes.length,
        withPrimary: withPrimary.size,
        withoutPrimary: noPrimary.length,
        withoutPrimaryIds: noPrimary.map((c) => c.id),
        withAssistant: withAssistant.size,
        withCoordinator: withCoordinator.size,
        totalTeachersInRole: loadByStaff.size,
        multiClassPrimaries,
        coveragePct: classes.length > 0 ? Math.round((withPrimary.size / classes.length) * 100) : 0,
      },
    });
  });

  // ── POST /admin/class-teacher-assignments/bulk-assign ────
  app.post(`${P}/bulk-assign`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { academicYearId: number; assignments: { classId: number; staffId: number; role?: string }[] };

    if (!b.academicYearId || !b.assignments?.length) {
      return rep.status(400).send({ success: false, message: "Pick at least one class and teacher." });
    }

    const session = await prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } });
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });
    if (session.status === "LOCKED") return rep.status(400).send({ success: false, message: "This session is locked." });

    let done = 0;
    const failed: string[] = [];

    for (const a of b.assignments) {
      try {
        const role = (a.role as any) ?? "PRIMARY";
        const assignment = await prisma.classTeacherAssignment.upsert({
          where: { classId_role_academicYearId: { classId: a.classId, role, academicYearId: b.academicYearId } },
          create: { schoolId, classId: a.classId, staffId: a.staffId, role, academicYearId: b.academicYearId },
          update: { staffId: a.staffId },
        });
        if (role === "PRIMARY" && session.isCurrent) {
          await prisma.class.update({ where: { id: a.classId }, data: { classTeacherId: a.staffId } });
        }
        done++;
      } catch {
        failed.push(String(a.classId));
      }
    }

    return rep.send({
      success: done > 0,
      message: `${done} assignment${done === 1 ? "" : "s"} saved${failed.length ? `, ${failed.length} skipped` : ""}.`,
      data: { done, failed },
    });
  });

  // ── POST /admin/class-teacher-assignments/swap ────────────
  // Swaps two teachers' PRIMARY class in one transaction, so there's
  // never a moment where a class has no class teacher at all.
  app.post(`${P}/swap`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { academicYearId: number; assignmentAId: number; assignmentBId: number };

    if (!b.academicYearId || !b.assignmentAId || !b.assignmentBId) {
      return rep.status(400).send({ success: false, message: "Pick two assignments to swap." });
    }

    const [a, bb] = await Promise.all([
      prisma.classTeacherAssignment.findFirst({ where: { id: b.assignmentAId, schoolId } }),
      prisma.classTeacherAssignment.findFirst({ where: { id: b.assignmentBId, schoolId } }),
    ]);
    if (!a || !bb) return rep.status(404).send({ success: false, message: "One of those assignments no longer exists." });

    const session = await prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } });
    if (session?.status === "LOCKED") return rep.status(400).send({ success: false, message: "This session is locked." });

    await prisma.$transaction(async (tx) => {
      await tx.classTeacherAssignment.update({ where: { id: a.id }, data: { staffId: bb.staffId } });
      await tx.classTeacherAssignment.update({ where: { id: bb.id }, data: { staffId: a.staffId } });
      if (a.role === "PRIMARY" && session?.isCurrent) {
        await tx.class.update({ where: { id: a.classId }, data: { classTeacherId: bb.staffId } });
      }
      if (bb.role === "PRIMARY" && session?.isCurrent) {
        await tx.class.update({ where: { id: bb.classId }, data: { classTeacherId: a.staffId } });
      }
    });

    return rep.send({ success: true, message: "Teachers swapped." });
  });
}
