// apps/api/src/routes/admin/academics/section-transfer-insights.ts
// ─────────────────────────────────────────────────────────────
// Batch & Section Transfer — the health layer on top of the
// existing, already-solid section-transfer.ts (eligible-classes,
// the transfer itself, and history all untouched).
//
//   GET  /admin/section-transfer/overview  → Layer 1 stat rail
//   POST /admin/section-transfer/preview   → dry run: capacity
//                                            headroom + what actually
//                                            carries with the student
//                                            (attendance and fee
//                                            records are keyed by
//                                            studentId, not classId,
//                                            so they follow
//                                            automatically — hostel
//                                            allocation is checked
//                                            explicitly since it's
//                                            worth flagging)
//
// Register alongside adminSectionTransferRoutes:
//   await app.register(adminSectionTransferInsightRoutes);
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminSectionTransferInsightRoutes(app: FastifyInstance) {
  const guard = { preHandler: [authenticate, requireCapability("academics.core")] };

  // ── GET /admin/section-transfer/overview ─────────────────
  app.get("/admin/section-transfer/overview", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;

    const currentYear = await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
    if (!currentYear) return rep.status(404).send({ success: false, message: "No active session." });

    const classes = await prisma.class.findMany({
      where: { schoolId, academicYear: currentYear.name, isActive: true },
      include: { _count: { select: { students: true } } },
    });

    const totalStudents = classes.reduce((a, c) => a + c._count.students, 0);
    const totalCapacity = classes.reduce((a, c) => a + c.capacity, 0);
    const nearFull = classes.filter((c) => c._count.students >= c.capacity * 0.9).length;
    const withRoom = classes.filter((c) => c._count.students < c.capacity).length;

    const recentTransfers = await prisma.promotionHistory.count({
      where: { schoolId, fromSession: currentYear.name, toSession: currentYear.name, isRolledBack: false, status: "PROMOTED" },
    });

    const last30 = new Date();
    last30.setDate(last30.getDate() - 30);
    const transfersLast30 = await prisma.promotionHistory.count({
      where: { schoolId, fromSession: currentYear.name, toSession: currentYear.name, isRolledBack: false, createdAt: { gte: last30 } },
    });

    return rep.send({
      success: true,
      data: {
        session: currentYear.name,
        classCount: classes.length,
        totalStudents,
        totalCapacity,
        seatsFree: Math.max(0, totalCapacity - totalStudents),
        nearFull, withRoom,
        transfersThisSession: recentTransfers,
        transfersLast30,
      },
    });
  });

  // ── POST /admin/section-transfer/preview ─────────────────
  app.post("/admin/section-transfer/preview", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { studentIds: number[]; toClassId: number };

    if (!b.studentIds?.length || !b.toClassId) {
      return rep.status(400).send({ success: false, message: "Pick students and a target class." });
    }

    const [toClass, students] = await Promise.all([
      prisma.class.findFirst({ where: { id: b.toClassId, schoolId }, include: { _count: { select: { students: true } } } }),
      prisma.student.findMany({
        where: { schoolId, id: { in: b.studentIds } },
        include: {
          user: { select: { name: true } },
          class: { select: { id: true, name: true, section: true, classNumber: true, academicYear: true, stream: true } },
        },
      }),
    ]);
    if (!toClass) return rep.status(404).send({ success: false, message: "Target class not found." });

    const seatsFree = Math.max(0, toClass.capacity - toClass._count.students);
    const willExceedCapacity = students.length > seatsFree;

    const [hostelAllocations, pendingFees] = await Promise.all([
      prisma.hostelAllocation.findMany({
        where: { schoolId, studentId: { in: b.studentIds }, status: "ACTIVE" as any },
        select: { studentId: true, hostel: { select: { name: true } } },
      }).catch(() => []),
      prisma.invoice.groupBy({
        by: ["studentId"],
        where: { schoolId, studentId: { in: b.studentIds }, status: { not: "PAID" } },
        _sum: { dueAmount: true },
      }),
    ]);
    const hostelMap = new Map(hostelAllocations.map((h: any) => [h.studentId, h.hostel.name]));
    const feeMap = new Map(pendingFees.map((f) => [f.studentId, Number(f._sum.dueAmount ?? 0)]));

    const rows = students.map((s) => {
      const isStreamChange = s.class && s.class.classNumber === toClass.classNumber && s.class.stream !== toClass.stream;
      const isDifferentSession = s.class && s.class.academicYear !== toClass.academicYear;
      const isDifferentGrade = s.class && s.class.classNumber !== toClass.classNumber;
      return {
        studentId: s.id,
        name: s.user.name,
        fromClass: s.class ? `${s.class.name}-${s.class.section}` : "No class",
        blocked: isDifferentSession ? "different session — use Student Promotion instead" : isDifferentGrade ? "different grade — mark as a stream change to allow this" : null,
        isStreamChange,
        onHostel: hostelMap.get(s.id) ?? null,
        pendingFees: feeMap.get(s.id) ?? 0,
      };
    });

    const blocked = rows.filter((r) => r.blocked);

    return rep.send({
      success: true,
      data: {
        target: { id: toClass.id, name: toClass.name, section: toClass.section, capacity: toClass.capacity, currentCount: toClass._count.students, seatsFree },
        willExceedCapacity,
        movable: {
          attendance: "Full attendance history stays with the student",
          fees: "Fee records and any pending dues stay with the student",
          examResults: "Past exam results and report cards stay with the student",
        },
        watchOut: rows.filter((r) => r.onHostel || r.pendingFees > 0).map((r) => ({
          name: r.name, onHostel: r.onHostel, pendingFees: r.pendingFees,
        })),
        rows,
        eligibleCount: rows.length - blocked.length,
        blockedCount: blocked.length,
      },
    });
  });
}
