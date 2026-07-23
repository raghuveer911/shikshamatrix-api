// apps/api/src/routes/admin/hostel/hostel-manage-rooms-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// Auto-generate bed codes A, B, C … for a room
async function generateBeds(roomId: number, capacity: number) {
  const codes = Array.from({ length: capacity }, (_, i) => String.fromCharCode(65 + i)); // A, B, C ...
  await prisma.hostelBed.createMany({ data: codes.map(code => ({ roomId, bedCode: code })), skipDuplicates: true });
}

// Sync hostel denormalised counts
async function syncHostelCounts(hostelId: number) {
  const [totalRooms, totalBeds, occupiedBeds] = await Promise.all([
    prisma.hostelRoom.count({ where: { hostelId } }),
    prisma.hostelBed.count({ where: { room: { hostelId } } }),
    prisma.hostelBed.count({ where: { room: { hostelId }, status: "OCCUPIED" } }),
  ]);
  await prisma.hostel.update({ where: { id: hostelId }, data: { totalRooms, totalBeds, occupiedBeds } });
}

export async function adminManageRoomsRoutes(app: FastifyInstance) {
  const P = "/admin/hostel/rooms";

  // List rooms
  app.get(P, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const where: any = { hostel: { schoolId } };
    if (q.hostelId)   where.hostelId    = Number(q.hostelId);
    if (q.floorId)    where.floorId     = Number(q.floorId);
    if (q.roomTypeId) where.roomTypeId  = Number(q.roomTypeId);
    if (q.status)     where.status      = q.status;

    const [rooms, total] = await Promise.all([
      prisma.hostelRoom.findMany({
        where,
        include: {
          hostel:   { select: { name: true, hostelType: true } },
          floor:    { select: { floorName: true, floorNo: true } },
          roomType: { select: { name: true } },
          beds:     { orderBy: { bedCode: "asc" }, include: {
            allocations: { where: { status: "ACTIVE" }, take: 1, include: { student: { include: { user: { select: { name: true, avatarUrl: true } } } } } },
          }},
        },
        orderBy: [{ hostelId: "asc" }, { roomNumber: "asc" }],
        skip: (Number(q.page ?? 1) - 1) * 50,
        take: 50,
      }),
      prisma.hostelRoom.count({ where }),
    ]);
    return rep.send({ rooms, total });
  });

  // Get one room
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const id = Number((req.params as any).id);
    const room = await prisma.hostelRoom.findFirst({
      where: { id },
      include: {
        hostel:   { select: { name: true, hostelType: true } },
        floor:    { select: { floorName: true } },
        roomType: { select: { name: true, capacity: true, amenities: true } },
        beds: { orderBy: { bedCode: "asc" }, include: {
          allocations: { where: { status: "ACTIVE" }, take: 1,
            include: { student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } } },
          },
        }},
      },
    });
    if (!room) return rep.code(404).send({ error: "Room not found" });
    return rep.send({ room });
  });

  // Create room
  app.post(P, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const b = req.body as any;
    let capacity = Number(b.capacity ?? 1);
    // Auto-fetch capacity from room type
    if (b.roomTypeId) {
      const rt = await prisma.roomType.findFirst({ where: { id: Number(b.roomTypeId) } });
      if (rt && !b.capacity) capacity = rt.capacity;
    }
    const room = await prisma.hostelRoom.create({
      data: {
        hostelId:    Number(b.hostelId),
        floorId:     b.floorId    ? Number(b.floorId)    : null,
        roomTypeId:  b.roomTypeId ? Number(b.roomTypeId) : null,
        roomNumber:  b.roomNumber,
        capacity,
        floor_label: b.floor_label ?? null,
      },
    });
    await generateBeds(room.id, capacity);
    await syncHostelCounts(Number(b.hostelId));
    return rep.code(201).send({ room });
  });

  // Bulk create rooms
  app.post(`${P}/bulk`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const b = req.body as any;
    // b.rooms: [{ hostelId, roomNumber, roomTypeId, floorId, capacity }]
    let created = 0;
    for (const r of b.rooms ?? []) {
      let capacity = Number(r.capacity ?? 1);
      if (r.roomTypeId) {
        const rt = await prisma.roomType.findFirst({ where: { id: Number(r.roomTypeId) } });
        if (rt) capacity = rt.capacity;
      }
      const room = await prisma.hostelRoom.create({ data: { hostelId: Number(r.hostelId), floorId: r.floorId ? Number(r.floorId) : null, roomTypeId: r.roomTypeId ? Number(r.roomTypeId) : null, roomNumber: r.roomNumber, capacity, floor_label: r.floor_label ?? null } });
      await generateBeds(room.id, capacity);
      created++;
    }
    if (b.rooms?.[0]?.hostelId) await syncHostelCounts(Number(b.rooms[0].hostelId));
    return rep.code(201).send({ created });
  });

  // Update room
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const room = await prisma.hostelRoom.update({
      where: { id },
      data: { roomNumber: b.roomNumber, roomTypeId: b.roomTypeId ? Number(b.roomTypeId) : undefined, floorId: b.floorId ? Number(b.floorId) : undefined, status: b.status as any, maintenanceNote: b.maintenanceNote, floor_label: b.floor_label },
    });
    return rep.send({ room });
  });

  // Update bed status
  app.put(`${P}/beds/:bedId`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const bedId = Number((req.params as any).bedId);
    const b     = req.body as any;
    const bed   = await prisma.hostelBed.update({ where: { id: bedId }, data: { status: b.status as any, notes: b.notes ?? null } });
    return rep.send({ bed });
  });

  // Floor-wise view
  app.get(`${P}/floor-view/:hostelId`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const hostelId = Number((req.params as any).hostelId);
    const floors = await prisma.hostelFloor.findMany({ where: { hostelId }, orderBy: { floorNo: "asc" } });
    const result = await Promise.all(floors.map(async floor => {
      const rooms = await prisma.hostelRoom.findMany({ where: { hostelId, floorId: floor.id }, include: { roomType: { select: { name: true } }, _count: { select: { beds: true } } }, orderBy: { roomNumber: "asc" } });
      return { ...floor, rooms };
    }));
    // Rooms with no floor
    const noFloor = await prisma.hostelRoom.findMany({ where: { hostelId, floorId: null }, include: { roomType: { select: { name: true } } }, orderBy: { roomNumber: "asc" } });
    return rep.send({ floors: result, unassigned: noFloor });
  });

  // Maintenance flag
  app.post(`${P}/:id/maintenance`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const room = await prisma.hostelRoom.update({ where: { id }, data: { status: "MAINTENANCE", maintenanceNote: b.note ?? "Under maintenance" } });
    return rep.send({ room });
  });

  app.post(`${P}/:id/clear-maintenance`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const id = Number((req.params as any).id);
    const room = await prisma.hostelRoom.findFirst({ where: { id }, include: { beds: true } });
    if (!room) return rep.code(404).send({ error: "Room not found" });
    const anyOccupied = room.beds.some(b => b.status === "OCCUPIED");
    const newStatus: any = anyOccupied ? (room.occupiedCount === room.capacity ? "OCCUPIED" : "PARTIAL") : "AVAILABLE";
    const updated = await prisma.hostelRoom.update({ where: { id }, data: { status: newStatus, maintenanceNote: null } });
    return rep.send({ room: updated });
  });

  app.get(`${P}/stats/:hostelId`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const hostelId = Number((req.params as any).hostelId);
    const byStatus = await prisma.hostelRoom.groupBy({ by: ["status"], where: { hostelId }, _count: { id: true } });
    return rep.send({ byStatus });
  });
}
