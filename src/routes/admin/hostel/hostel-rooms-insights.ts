// apps/api/src/routes/admin/hostel/hostel-rooms-insights.ts
// ─────────────────────────────────────────────────────────────
// Manage Rooms — the health layer on top of the existing, already
// solid hostel-manage-rooms-api.ts (list/create/bulk-create/update/
// floor-view/maintenance flags all untouched and still work).
//
//   GET  /admin/hostel/rooms/overview        → Layer 1 stat rail,
//                                              school-wide (existing
//                                              /stats/:hostelId was
//                                              per-hostel only)
//   POST /admin/hostel/rooms/bulk-status      → set status (e.g. bulk
//                                              maintenance / clear)
//                                              across many rooms at once
//   GET  /admin/hostel/rooms/floors           → every hostel's floors
//                                              in one call, so "add a
//                                              floor" can live directly
//                                              on the Rooms page
//                                              instead of only being
//                                              reachable from a hostel
//                                              detail drawer elsewhere
//
// Register alongside adminManageRoomsRoutes.
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

async function syncHostelCounts(hostelId: number) {
  const [totalRooms, totalBeds, occupiedBeds] = await Promise.all([
    prisma.hostelRoom.count({ where: { hostelId } }),
    prisma.hostelBed.count({ where: { room: { hostelId } } }),
    prisma.hostelBed.count({ where: { room: { hostelId }, status: "OCCUPIED" } }),
  ]);
  await prisma.hostel.update({ where: { id: hostelId }, data: { totalRooms, totalBeds, occupiedBeds } });
}

export async function adminHostelRoomsInsightRoutes(app: FastifyInstance) {
  const P = "/admin/hostel/rooms";
  const guard = { preHandler: [authenticate, requireCapability("hostel.core")] };

  // ── GET /admin/hostel/rooms/overview ─────────────────────
  app.get(`${P}/overview`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { hostelId?: string };
    const where: any = { hostel: { schoolId }, ...(q.hostelId ? { hostelId: Number(q.hostelId) } : {}) };

    const [byStatus, totalBeds, occupiedBeds, floorsCount, noFloorCount, hostels] = await Promise.all([
      prisma.hostelRoom.groupBy({ by: ["status"], where, _count: { id: true } }),
      prisma.hostelBed.count({ where: { room: where } }),
      prisma.hostelBed.count({ where: { room: where, status: "OCCUPIED" } }),
      prisma.hostelFloor.count({ where: { hostel: { schoolId, ...(q.hostelId ? { id: Number(q.hostelId) } : {}) } } }),
      prisma.hostelRoom.count({ where: { ...where, floorId: null } }),
      prisma.hostel.findMany({ where: { schoolId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);

    const statusMap: Record<string, number> = {};
    byStatus.forEach((s) => { statusMap[s.status] = s._count.id; });
    const totalRooms = Object.values(statusMap).reduce((a, b) => a + b, 0);

    return rep.send({
      success: true,
      data: {
        totalRooms,
        totalBeds,
        occupiedBeds,
        availableBeds: totalBeds - occupiedBeds,
        occupancyPct: totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0,
        byStatus: {
          AVAILABLE: statusMap.AVAILABLE ?? 0,
          PARTIAL: statusMap.PARTIAL ?? 0,
          OCCUPIED: statusMap.OCCUPIED ?? 0,
          MAINTENANCE: statusMap.MAINTENANCE ?? 0,
          BLOCKED: statusMap.BLOCKED ?? 0,
        },
        floorsCount,
        roomsWithoutFloor: noFloorCount,
        hostels,
      },
    });
  });

  // ── GET /admin/hostel/rooms/floors ───────────────────────
  // Every hostel's floors, in one call — so a "Manage Floors" panel
  // can live right here on the Rooms page instead of only being
  // reachable by drilling into a hostel's own detail drawer.
  app.get(`${P}/floors`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const hostels = await prisma.hostel.findMany({
      where: { schoolId, isActive: true },
      select: {
        id: true, name: true, hostelType: true,
        floors: { orderBy: { floorNo: "asc" }, include: { _count: { select: { rooms: true } } } },
      },
      orderBy: { name: "asc" },
    });
    return rep.send({ success: true, data: { hostels } });
  });

  // ── POST /admin/hostel/rooms/floors ──────────────────────
  // Thin duplicate of the existing hostels/:id/floors endpoint,
  // exposed under /rooms too purely so "add a floor" is reachable
  // from wherever the admin is actually looking at rooms.
  app.post(`${P}/floors`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { hostelId: number; floorName: string };
    if (!b.hostelId || !b.floorName?.trim()) {
      return rep.status(400).send({ success: false, message: "Pick a hostel and name the floor." });
    }
    const hostel = await prisma.hostel.findFirst({ where: { id: b.hostelId, schoolId } });
    if (!hostel) return rep.status(404).send({ success: false, message: "Hostel not found." });

    const maxFloor = await prisma.hostelFloor.findFirst({ where: { hostelId: b.hostelId }, orderBy: { floorNo: "desc" } });
    const floor = await prisma.hostelFloor.create({
      data: { hostelId: b.hostelId, floorNo: (maxFloor?.floorNo ?? -1) + 1, floorName: b.floorName.trim() },
    });
    return rep.status(201).send({ success: true, message: `"${floor.floorName}" added to ${hostel.name}.`, data: { floor } });
  });

  // ── POST /admin/hostel/rooms/floors/bulk ─────────────────
  // "Add floors Ground through 4th in one go" — the tedious part of
  // setting up a new hostel, done once instead of floor-by-floor.
  app.post(`${P}/floors/bulk`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { hostelId: number; floorNames: string[] };
    if (!b.hostelId || !b.floorNames?.length) {
      return rep.status(400).send({ success: false, message: "Pick a hostel and at least one floor name." });
    }
    const hostel = await prisma.hostel.findFirst({ where: { id: b.hostelId, schoolId } });
    if (!hostel) return rep.status(404).send({ success: false, message: "Hostel not found." });

    const maxFloor = await prisma.hostelFloor.findFirst({ where: { hostelId: b.hostelId }, orderBy: { floorNo: "desc" } });
    let next = (maxFloor?.floorNo ?? -1) + 1;
    let created = 0;
    for (const name of b.floorNames) {
      if (!name.trim()) continue;
      await prisma.hostelFloor.create({ data: { hostelId: b.hostelId, floorNo: next, floorName: name.trim() } });
      next++; created++;
    }
    return rep.status(201).send({ success: true, message: `${created} floor(s) added to ${hostel.name}.`, data: { created } });
  });

  // ── DELETE /admin/hostel/rooms/floors/:id ────────────────
  app.delete(`${P}/floors/:id`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { id } = req.params as { id: string };
    const floor = await prisma.hostelFloor.findFirst({ where: { id: Number(id), hostel: { schoolId } }, include: { _count: { select: { rooms: true } } } });
    if (!floor) return rep.status(404).send({ success: false, message: "Floor not found." });
    if (floor._count.rooms > 0) {
      return rep.status(400).send({ success: false, message: `${floor._count.rooms} room(s) are on this floor — move or delete them first.` });
    }
    await prisma.hostelFloor.delete({ where: { id: Number(id) } });
    return rep.send({ success: true, message: `"${floor.floorName}" removed.` });
  });

  // ── POST /admin/hostel/rooms/bulk-status ─────────────────
  // Flip many rooms to MAINTENANCE / BLOCKED at once, or clear them
  // back to their occupancy-derived status — the single-room versions
  // already existed, this just applies them across a selection.
  app.post(`${P}/bulk-status`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { roomIds: number[]; action: "maintenance" | "block" | "clear"; note?: string };
    if (!b.roomIds?.length) return rep.status(400).send({ success: false, message: "Select at least one room." });

    const rooms = await prisma.hostelRoom.findMany({
      where: { id: { in: b.roomIds }, hostel: { schoolId } },
      include: { beds: true },
    });

    const results: { id: number; roomNumber: string; ok: boolean; reason?: string }[] = [];
    const touchedHostels = new Set<number>();

    for (const room of rooms) {
      try {
        if (b.action === "clear") {
          const occupied = room.beds.filter((bd) => bd.status === "OCCUPIED").length;
          const status: any = occupied === 0 ? "AVAILABLE" : occupied >= room.capacity ? "OCCUPIED" : "PARTIAL";
          await prisma.hostelRoom.update({ where: { id: room.id }, data: { status, maintenanceNote: null } });
        } else {
          if (room.beds.some((bd) => bd.status === "OCCUPIED")) {
            throw new Error("has residents — vacate first");
          }
          await prisma.hostelRoom.update({
            where: { id: room.id },
            data: { status: b.action === "maintenance" ? "MAINTENANCE" : "BLOCKED", maintenanceNote: b.note ?? null },
          });
        }
        touchedHostels.add(room.hostelId);
        results.push({ id: room.id, roomNumber: room.roomNumber, ok: true });
      } catch (e: any) {
        results.push({ id: room.id, roomNumber: room.roomNumber, ok: false, reason: e.message ?? "Failed" });
      }
    }

    await Promise.all([...touchedHostels].map(syncHostelCounts));

    const done = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    return rep.send({
      success: done > 0,
      message: failed.length === 0
        ? `${done} room(s) updated.`
        : `${done} updated, ${failed.length} skipped — ${failed.map((f) => `${f.roomNumber}: ${f.reason}`).join("; ")}.`,
      data: { results },
    });
  });

  // ── POST /admin/hostel/rooms/bulk-create-with-beds ───────
  // Same shape as the existing /bulk endpoint's intent, but generates
  // a numeric range in one call ("Room 101 to 120") instead of the
  // caller having to build the array client-side — kept as an addition
  // rather than changing the existing /bulk endpoint's contract.
  app.post(`${P}/bulk-range`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as {
      hostelId: number; floorId?: number | null; roomTypeId?: number | null;
      fromNumber: number; toNumber: number; prefix?: string; capacity?: number;
    };
    if (!b.hostelId || b.fromNumber === undefined || b.toNumber === undefined || b.toNumber < b.fromNumber) {
      return rep.status(400).send({ success: false, message: "Pick a hostel and a valid room number range." });
    }
    if (b.toNumber - b.fromNumber > 200) {
      return rep.status(400).send({ success: false, message: "That's over 200 rooms in one go — split it into smaller batches." });
    }
    const hostel = await prisma.hostel.findFirst({ where: { id: b.hostelId, schoolId } });
    if (!hostel) return rep.status(404).send({ success: false, message: "Hostel not found." });

    let capacity = b.capacity ?? 1;
    if (b.roomTypeId) {
      const rt = await prisma.roomType.findFirst({ where: { id: b.roomTypeId, schoolId } });
      if (rt && !b.capacity) capacity = rt.capacity;
    }

    const existing = await prisma.hostelRoom.findMany({ where: { hostelId: b.hostelId }, select: { roomNumber: true } });
    const have = new Set(existing.map((r) => r.roomNumber));

    let created = 0, skipped = 0;
    for (let n = b.fromNumber; n <= b.toNumber; n++) {
      const roomNumber = `${b.prefix ?? ""}${n}`;
      if (have.has(roomNumber)) { skipped++; continue; }
      const room = await prisma.hostelRoom.create({
        data: { hostelId: b.hostelId, floorId: b.floorId ?? null, roomTypeId: b.roomTypeId ?? null, roomNumber, capacity },
      });
      const codes = Array.from({ length: capacity }, (_, i) => String.fromCharCode(65 + i));
      await prisma.hostelBed.createMany({ data: codes.map((code) => ({ roomId: room.id, bedCode: code })), skipDuplicates: true });
      created++;
    }
    await syncHostelCounts(b.hostelId);

    return rep.status(201).send({
      success: created > 0,
      message: `${created} room(s) created${skipped ? `, ${skipped} already existed` : ""}.`,
      data: { created, skipped },
    });
  });
}