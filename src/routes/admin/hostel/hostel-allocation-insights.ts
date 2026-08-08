// apps/api/src/routes/admin/hostel/hostel-allocation-insights.ts
// ─────────────────────────────────────────────────────────────
// Student Allocation — the health layer on top of the existing,
// already-solid hostel-student-allocation-api.ts (the 4-step
// allocate flow, transfer, vacate, history, and reports/summary all
// untouched and still work).
//
//   GET  /admin/hostel/allocations/overview        → Layer 1 stat rail
//   POST /admin/hostel/allocations/:id/transfer-preview
//        → dry run before a transfer: does the target room have room,
//          what carries with the student. Nothing is written.
//   POST /admin/hostel/allocations/bulk-vacate      → vacate many
//        students at once (e.g. end of session, or a whole room
//        being decommissioned)
//
// Register alongside adminHostelAllocationRoutes.
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

async function syncRoomCounts(roomId: number) {
  const occupied = await prisma.hostelBed.count({ where: { roomId, status: "OCCUPIED" } });
  const room = await prisma.hostelRoom.findFirst({ where: { id: roomId }, select: { capacity: true, hostelId: true } });
  const cap = room?.capacity ?? 1;
  const status: any = occupied === 0 ? "AVAILABLE" : occupied >= cap ? "OCCUPIED" : "PARTIAL";
  await prisma.hostelRoom.update({ where: { id: roomId }, data: { occupiedCount: occupied, status } });
  if (room?.hostelId) {
    const [totalBeds, occupiedBeds] = await Promise.all([
      prisma.hostelBed.count({ where: { room: { hostelId: room.hostelId } } }),
      prisma.hostelBed.count({ where: { room: { hostelId: room.hostelId }, status: "OCCUPIED" } }),
    ]);
    await prisma.hostel.update({ where: { id: room.hostelId }, data: { totalBeds, occupiedBeds } });
  }
}

export async function adminHostelAllocationInsightRoutes(app: FastifyInstance) {
  const P = "/admin/hostel/allocations";
  const guard = { preHandler: [authenticate, requireCapability("hostel.core")] };

  // ── GET /admin/hostel/allocations/overview ───────────────
  app.get(`${P}/overview`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;

    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const [
      activeCount, vacatedThisMonth, transferredThisMonth, newThisMonth,
      genderSplit, hostelsAgg, unallocatedEligible,
    ] = await Promise.all([
      prisma.hostelAllocation.count({ where: { schoolId, status: "ACTIVE" } }),
      prisma.hostelAllocation.count({ where: { schoolId, status: "VACATED", vacateDate: { gte: monthStart } } }),
      prisma.hostelAllocation.count({ where: { schoolId, status: "TRANSFERRED", updatedAt: { gte: monthStart } } }),
      prisma.hostelAllocation.count({ where: { schoolId, status: "ACTIVE", allocationDate: { gte: monthStart } } }),
      prisma.hostelAllocation.findMany({
        where: { schoolId, status: "ACTIVE" },
        select: { student: { select: { user: { select: { gender: true } } } } },
      }),
      prisma.hostel.findMany({
        where: { schoolId, isActive: true },
        select: { id: true, name: true, totalBeds: true, occupiedBeds: true },
      }),
      // Students who look like boarders (have a hostel fee-ish signal is
      // hard to infer generically) — kept simple: just total active
      // students not currently allocated, as a rough "could be a
      // waitlist candidate" signal, not a hard rule.
      prisma.student.count({
        where: { schoolId, isActive: true, hostelAllocations: { none: { status: "ACTIVE" } } },
      }).catch(() => 0),
    ]);

    let boys = 0, girls = 0, other = 0;
    for (const a of genderSplit) {
      const g = a.student.user.gender;
      if (g === "MALE") boys++; else if (g === "FEMALE") girls++; else other++;
    }

    const nearFullHostels = hostelsAgg.filter((h) => h.totalBeds > 0 && h.occupiedBeds / h.totalBeds >= 0.9).length;
    const totalBeds = hostelsAgg.reduce((s, h) => s + h.totalBeds, 0);
    const occupiedBeds = hostelsAgg.reduce((s, h) => s + h.occupiedBeds, 0);

    return rep.send({
      success: true,
      data: {
        activeCount,
        vacatedThisMonth,
        transferredThisMonth,
        newThisMonth,
        boys, girls, other,
        totalBeds, occupiedBeds,
        occupancyPct: totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0,
        nearFullHostels,
        unallocatedStudents: unallocatedEligible,
      },
    });
  });

  // ── POST /admin/hostel/allocations/:id/transfer-preview ──
  // Dry run before committing a transfer — the existing /transfer
  // endpoint just executes; this lets the admin see the outcome first,
  // same pattern as Academics' Batch & Section Transfer preview.
  app.post(`${P}/:id/transfer-preview`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { id } = req.params as { id: string };
    const b = req.body as { newBedId: number };

    const [current, newBed] = await Promise.all([
      prisma.hostelAllocation.findFirst({
        where: { id: Number(id), schoolId, status: "ACTIVE" },
        include: {
          student: { include: { user: { select: { name: true } } } },
          hostel: { select: { name: true } }, room: { select: { roomNumber: true, capacity: true } }, bed: { select: { bedCode: true } },
        },
      }),
      prisma.hostelBed.findFirst({
        where: { id: b.newBedId },
        include: { room: { include: { hostel: { select: { id: true, name: true, hostelType: true } }, roomType: { select: { name: true } } } } },
      }),
    ]);

    if (!current) return rep.status(404).send({ success: false, message: "Active allocation not found." });
    if (!newBed) return rep.status(404).send({ success: false, message: "Target bed not found." });

    const issues: string[] = [];
    if (newBed.status !== "AVAILABLE") issues.push(`Bed ${newBed.bedCode} is currently ${newBed.status.toLowerCase()}, not available.`);
    if (newBed.roomId === current.roomId) issues.push("That's the student's current room.");

    return rep.send({
      success: true,
      data: {
        student: { id: current.studentId, name: current.student.user.name },
        from: { hostel: current.hostel.name, room: current.room.roomNumber, bed: current.bed.bedCode },
        to: {
          hostel: newBed.room.hostel.name, hostelType: newBed.room.hostel.hostelType,
          room: newBed.room.roomNumber, bed: newBed.bedCode, roomType: newBed.room.roomType?.name ?? null,
        },
        canProceed: issues.length === 0,
        issues,
      },
    });
  });

  // ── POST /admin/hostel/allocations/bulk-vacate ───────────
  app.post(`${P}/bulk-vacate`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { allocationIds: number[]; reason: string; note?: string };
    if (!b.allocationIds?.length) return rep.status(400).send({ success: false, message: "Select at least one student." });
    if (!b.reason) return rep.status(400).send({ success: false, message: "Pick a reason." });

    const allocations = await prisma.hostelAllocation.findMany({
      where: { id: { in: b.allocationIds }, schoolId, status: "ACTIVE" },
      include: { student: { include: { user: { select: { name: true } } } } },
    });

    const touchedRooms = new Set<number>();
    for (const a of allocations) {
      await prisma.hostelAllocation.update({
        where: { id: a.id },
        data: { status: "VACATED", vacateDate: new Date(), vacateReason: b.reason as any, vacateNote: b.note ?? null },
      });
      await prisma.hostelBed.update({ where: { id: a.bedId }, data: { status: "AVAILABLE" } });
      touchedRooms.add(a.roomId);
    }
    await Promise.all([...touchedRooms].map(syncRoomCounts));

    return rep.send({
      success: allocations.length > 0,
      message: `${allocations.length} student(s) vacated.`,
      data: { vacated: allocations.length, names: allocations.map((a) => a.student.user.name) },
    });
  });
}