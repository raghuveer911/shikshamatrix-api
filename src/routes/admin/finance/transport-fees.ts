// apps/api/src/routes/admin/finance/transport-fees.ts
// ─────────────────────────────────────────────────────────────
// Transport Fees — lives in the Fee module (finance.collection
// capability) rather than requiring Transport module access, since
// setting a stop's fee is a finance decision. Route/stop CREATION
// still happens on the existing Transport module endpoints
// (admin/transport/transport-routes-api.ts, now fee-aware) — this
// file adds:
//
//   GET  /admin/finance/transport/routes            → routes+stops
//        with fees, read-only convenience for the Fee module UI
//   PUT  /admin/finance/transport/stops/:id/fee      → set just the
//        fee on a stop, without needing transport.core access
//   GET  /admin/finance/transport/student/:studentId → this
//        student's current assignment + fee status
//   POST /admin/finance/transport/assign             → link a
//        student to a stop AND generate their transport fee
//        installments for the session, in the SAME
//        StudentFeeInstallment table fee-collection.ts already
//        reads — tagged source:"TRANSPORT" so it shows up in the
//        normal dues list, collection flow, and receipt alongside
//        tuition, with no separate system to check.
//   POST /admin/finance/transport/unassign            → end the
//        assignment; any UNPAID future installments are cancelled,
//        already-paid ones are left alone (real money isn't erased)
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

const INSTALLMENTS_PER_YEAR: Record<string, number> = {
  ONE_TIME: 1, MONTHLY: 12, QUARTERLY: 4, HALF_YEARLY: 2, YEARLY: 1,
};

/** Builds the due-date schedule for a stop's fee across the session —
 *  same spirit as how tuition installments are laid out, just
 *  generated on the fly since transport has no shared FeePlan to
 *  borrow dates from. Monthly starts from the academic year's start
 *  date; skips any month that's already in the past relative to
 *  "today" only when generating for a NEW assignment mid-year is not
 *  desired — kept simple: always the full session so a stop's fee is
 *  predictable regardless of when the student joins. */
function buildSchedule(startDate: Date, endDate: Date, frequency: string): { label: string; dueDate: Date }[] {
  const count = INSTALLMENTS_PER_YEAR[frequency] ?? 1;
  if (count === 1) return [{ label: "Transport Fee", dueDate: startDate }];

  const monthsInYear = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / (30 * 86400000)));
  const step = Math.max(1, Math.round(monthsInYear / count));
  const schedule: { label: string; dueDate: Date }[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(startDate);
    d.setMonth(d.getMonth() + i * step);
    schedule.push({ label: `Transport Fee — ${d.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}`, dueDate: d });
  }
  return schedule;
}

export async function adminTransportFeesRoutes(app: FastifyInstance) {
  const guard = { preHandler: [authenticate, requireCapability("finance.collection")] };

  // ── GET /admin/finance/transport/routes ──────────────────
  app.get("/admin/finance/transport/routes", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const routes = await prisma.transportRoute.findMany({
      where: { schoolId, isActive: true },
      include: {
        stops: { where: { isActive: true }, orderBy: { sequence: "asc" }, include: { _count: { select: { studentAssignments: { where: { isActive: true } } } } } },
        vehicle: { select: { vehicleNumber: true } },
      },
      orderBy: { routeName: "asc" },
    });

    const stopsWithoutFee = routes.reduce((s, r) => s + r.stops.filter((st) => st.feeAmount === null).length, 0);
    const totalStops = routes.reduce((s, r) => s + r.stops.length, 0);
    const totalAssigned = routes.reduce((s, r) => s + r.stops.reduce((s2, st) => s2 + st._count.studentAssignments, 0), 0);

    return rep.send({
      success: true,
      data: {
        routes,
        overview: { totalRoutes: routes.length, totalStops, stopsWithoutFee, totalAssigned },
      },
    });
  });

  // ── PUT /admin/finance/transport/stops/:id/fee ───────────
  app.put("/admin/finance/transport/stops/:id/fee", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { id } = req.params as { id: string };
    const b = req.body as { feeAmount: number; feeFrequency?: string };

    if (b.feeAmount === undefined || b.feeAmount === null || b.feeAmount < 0) {
      return rep.status(400).send({ success: false, message: "Enter a valid fee amount." });
    }

    const stop = await prisma.transportStop.findFirst({ where: { id: Number(id), route: { schoolId } }, include: { route: true } });
    if (!stop) return rep.status(404).send({ success: false, message: "Stop not found." });

    const updated = await prisma.transportStop.update({
      where: { id: Number(id) },
      data: { feeAmount: b.feeAmount, feeFrequency: (b.feeFrequency as any) ?? stop.feeFrequency ?? "MONTHLY" },
    });

    return rep.send({ success: true, message: `Fee set for ${stop.stopName}.`, data: { stop: updated } });
  });

  // ── GET /admin/finance/transport/student/:studentId ──────
  app.get("/admin/finance/transport/student/:studentId", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { studentId } = req.params as { studentId: string };

    const assignment = await prisma.studentTransportAssignment.findFirst({
      where: { schoolId, studentId: Number(studentId), isActive: true },
      include: {
        route: { select: { id: true, routeName: true, routeCode: true } },
        stop: { select: { id: true, stopName: true, feeAmount: true, feeFrequency: true } },
        installments: { orderBy: { dueDate: "asc" } },
      },
    });

    return rep.send({ success: true, data: { assignment } });
  });

  // ── POST /admin/finance/transport/assign ─────────────────
  app.post("/admin/finance/transport/assign", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { studentId: number; routeId: number; stopId: number; academicYearId?: number };

    if (!b.studentId || !b.routeId || !b.stopId) {
      return rep.status(400).send({ success: false, message: "Pick a student, route and stop." });
    }

    const [student, stop, academicYear, existing] = await Promise.all([
      prisma.student.findFirst({ where: { id: b.studentId, schoolId } }),
      prisma.transportStop.findFirst({ where: { id: b.stopId, routeId: b.routeId, route: { schoolId } } }),
      b.academicYearId
        ? prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } })
        : prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } }),
      prisma.studentTransportAssignment.findFirst({ where: { schoolId, studentId: b.studentId, isActive: true } }),
    ]);

    if (!student) return rep.status(404).send({ success: false, message: "Student not found." });
    if (!stop) return rep.status(404).send({ success: false, message: "Stop not found on that route." });
    if (!academicYear) return rep.status(404).send({ success: false, message: "No active academic session found." });

    const result = await prisma.$transaction(async (tx) => {
      // Moving stops mid-year: close out the old assignment first and
      // cancel any of its unpaid future installments — already-paid
      // ones stay on the record, they're real money already collected.
      if (existing) {
        await tx.studentTransportAssignment.update({ where: { id: existing.id }, data: { isActive: false, removedAt: new Date() } });
        await tx.studentFeeInstallment.updateMany({
          where: { transportAssignmentId: existing.id, status: { in: ["PENDING", "PARTIAL"] } },
          data: { status: "WAIVED" },
        });
      }

      const assignment = await tx.studentTransportAssignment.create({
        data: { schoolId, studentId: b.studentId, routeId: b.routeId, stopId: b.stopId, academicYearId: academicYear.id },
      });

      let installmentsCreated = 0;
      if (stop.feeAmount && Number(stop.feeAmount) > 0) {
        const schedule = buildSchedule(academicYear.startDate, academicYear.endDate, stop.feeFrequency);
        await tx.studentFeeInstallment.createMany({
          data: schedule.map((s) => ({
            schoolId, studentId: b.studentId, source: "TRANSPORT" as any,
            transportAssignmentId: assignment.id, label: s.label,
            dueAmount: stop.feeAmount!, paidAmount: 0, fineAmount: 0, discountAmount: 0,
            dueDate: s.dueDate, status: "PENDING" as any,
          })),
        });
        installmentsCreated = schedule.length;
      }

      return { assignment, installmentsCreated };
    });

    return rep.status(201).send({
      success: true,
      message: stop.feeAmount
        ? `${student.firstName ?? "Student"} assigned to ${stop.stopName} — ${result.installmentsCreated} fee installment(s) added.`
        : `${student.firstName ?? "Student"} assigned to ${stop.stopName}. This stop has no fee set yet, so nothing was charged.`,
      data: result,
    });
  });

  // ── POST /admin/finance/transport/unassign ───────────────
  app.post("/admin/finance/transport/unassign", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { studentId: number };

    const existing = await prisma.studentTransportAssignment.findFirst({ where: { schoolId, studentId: b.studentId, isActive: true } });
    if (!existing) return rep.status(404).send({ success: false, message: "This student isn't on transport." });

    await prisma.$transaction(async (tx) => {
      await tx.studentTransportAssignment.update({ where: { id: existing.id }, data: { isActive: false, removedAt: new Date() } });
      await tx.studentFeeInstallment.updateMany({
        where: { transportAssignmentId: existing.id, status: { in: ["PENDING", "PARTIAL"] } },
        data: { status: "WAIVED" },
      });
    });

    return rep.send({ success: true, message: "Removed from transport. Unpaid transport dues were waived; anything already paid stays on record." });
  });
}