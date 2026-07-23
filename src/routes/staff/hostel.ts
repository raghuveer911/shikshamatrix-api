import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { requireCapability } from "../../middleware/checkCapability.js";

async function syncRoomAndHostelCounts(roomId: number) {
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

export async function staffHostelRoutes(app: FastifyInstance) {
  const P = "/staff/hostel";

  // ── GET /staff/hostel/overview ──────────────────────────
  app.get(`${P}/overview`, { preHandler: [appAuth, requireCapability("hostel.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const [totalHostels, totalRooms, bedAgg] = await Promise.all([
        prisma.hostel.count({ where: { schoolId, isActive: true } }),
        prisma.hostelRoom.count({ where: { hostel: { schoolId } } }),
        prisma.hostel.aggregate({ where: { schoolId, isActive: true }, _sum: { totalBeds: true, occupiedBeds: true } }),
      ]);
      const totalBeds = bedAgg._sum.totalBeds ?? 0;
      const occupiedBeds = bedAgg._sum.occupiedBeds ?? 0;
      return reply.send({ success: true, data: { totalHostels, totalRooms, totalBeds, occupiedBeds, vacantBeds: totalBeds - occupiedBeds } });
    }
  );

  // ── GET /staff/hostel/hostels ────────────────────────────
  app.get(`${P}/hostels`, { preHandler: [appAuth, requireCapability("hostel.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const hostels = await prisma.hostel.findMany({
        where: { schoolId, isActive: true }, orderBy: { name: "asc" },
        include: { warden: { include: { user: { select: { name: true, phone: true } } } }, _count: { select: { rooms: true } } },
      });
      return reply.send({ success: true, data: { hostels } });
    }
  );

  // ── GET /staff/hostel/hostels/:id ────────────────────────
  app.get(`${P}/hostels/:id`, { preHandler: [appAuth, requireCapability("hostel.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };
      const hostel = await prisma.hostel.findFirst({
        where: { id: Number(id), schoolId },
        include: {
          warden: { include: { user: { select: { name: true, phone: true, avatarUrl: true } } } },
          floors: { orderBy: { floorNo: "asc" }, include: { _count: { select: { rooms: true } } } },
          _count: { select: { rooms: true } },
        },
      });
      if (!hostel) return reply.status(404).send({ success: false, message: "Hostel not found." });
      return reply.send({ success: true, data: { hostel } });
    }
  );

  // ── GET /staff/hostel/rooms?hostelId= ────────────────────
  app.get(`${P}/rooms`, { preHandler: [appAuth, requireCapability("hostel.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = req.query as { hostelId?: string; status?: string };
      const where: any = { hostel: { schoolId } };
      if (q.hostelId) where.hostelId = Number(q.hostelId);
      if (q.status) where.status = q.status;

      const rooms = await prisma.hostelRoom.findMany({
        where, orderBy: [{ hostelId: "asc" }, { roomNumber: "asc" }],
        include: { hostel: { select: { name: true } }, roomType: { select: { name: true } } },
      });
      return reply.send({ success: true, data: { rooms } });
    }
  );

  // ── GET /staff/hostel/rooms/:id ──────────────────────────
  app.get(`${P}/rooms/:id`, { preHandler: [appAuth, requireCapability("hostel.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const room = await prisma.hostelRoom.findFirst({
        where: { id: Number(id) },
        include: {
          hostel: { select: { name: true } }, floor: { select: { floorName: true } },
          roomType: { select: { name: true, capacity: true, amenities: true } },
          beds: {
            orderBy: { bedCode: "asc" },
            include: { allocations: { where: { status: "ACTIVE" }, take: 1, include: { student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } } } } },
          },
        },
      });
      if (!room) return reply.status(404).send({ success: false, message: "Room not found." });
      return reply.send({ success: true, data: { room } });
    }
  );

  // ── GET /staff/hostel/residents ──────────────────────────
  app.get(`${P}/residents`, { preHandler: [appAuth, requireCapability("hostel.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = req.query as { hostelId?: string; search?: string };
      const where: any = { schoolId, status: "ACTIVE" };
      if (q.hostelId) where.hostelId = Number(q.hostelId);
      if (q.search) where.student = { user: { name: { contains: q.search, mode: "insensitive" } } };

      const allocations = await prisma.hostelAllocation.findMany({
        where, orderBy: { allocationDate: "desc" },
        include: {
          student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } },
          hostel: { select: { name: true } }, room: { select: { roomNumber: true } }, bed: { select: { bedCode: true } },
        },
      });
      return reply.send({ success: true, data: { residents: allocations } });
    }
  );

  // ── GET /staff/hostel/allocate/search-students ───────────
  app.get(`${P}/allocate/search-students`, { preHandler: [appAuth, requireCapability("hostel.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = req.query as { search?: string };
      if (!q.search || q.search.trim().length < 2) return reply.send({ success: true, data: { students: [] } });

      const allocated = await prisma.hostelAllocation.findMany({ where: { schoolId, status: "ACTIVE" }, select: { studentId: true } });
      const students = await prisma.student.findMany({
        where: {
          schoolId, isActive: true, id: { notIn: allocated.map((a) => a.studentId) },
          user: { name: { contains: q.search, mode: "insensitive" } },
        },
        include: { user: { select: { name: true, avatarUrl: true, gender: true } }, class: { select: { name: true } } },
        take: 15,
      });
      return reply.send({ success: true, data: { students } });
    }
  );

  // ── GET /staff/hostel/allocate/available-hostels ─────────
  app.get(`${P}/allocate/available-hostels`, { preHandler: [appAuth, requireCapability("hostel.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = req.query as { gender?: string };
      const where: any = { schoolId, isActive: true, status: "ACTIVE" };
      if (q.gender === "MALE") where.hostelType = { in: ["BOYS", "MIXED"] };
      if (q.gender === "FEMALE") where.hostelType = { in: ["GIRLS", "MIXED"] };

      const hostels = await prisma.hostel.findMany({
        where, select: { id: true, name: true, hostelType: true, totalBeds: true, occupiedBeds: true },
      });
      return reply.send({ success: true, data: { hostels: hostels.map((h) => ({ ...h, availBeds: h.totalBeds - h.occupiedBeds })) } });
    }
  );

  // ── GET /staff/hostel/allocate/available-rooms/:hostelId ─
  app.get(`${P}/allocate/available-rooms/:hostelId`, { preHandler: [appAuth, requireCapability("hostel.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { hostelId } = req.params as { hostelId: string };
      const rooms = await prisma.hostelRoom.findMany({
        where: { hostelId: Number(hostelId), status: { in: ["AVAILABLE", "PARTIAL"] } },
        include: { roomType: { select: { name: true, capacity: true } } },
        orderBy: { roomNumber: "asc" },
      });
      return reply.send({ success: true, data: { rooms } });
    }
  );

  // ── GET /staff/hostel/allocate/available-beds/:roomId ────
  app.get(`${P}/allocate/available-beds/:roomId`, { preHandler: [appAuth, requireCapability("hostel.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { roomId } = req.params as { roomId: string };
      const beds = await prisma.hostelBed.findMany({ where: { roomId: Number(roomId), status: "AVAILABLE" }, orderBy: { bedCode: "asc" } });
      return reply.send({ success: true, data: { beds } });
    }
  );

  // ── POST /staff/hostel/allocate ───────────────────────────
  app.post(`${P}/allocate`, { preHandler: [appAuth, requireCapability("hostel.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const b = req.body as { studentId: number; hostelId: number; roomId: number; bedId: number; remarks?: string };

      const bed = await prisma.hostelBed.findFirst({ where: { id: Number(b.bedId), status: "AVAILABLE" } });
      if (!bed) return reply.status(409).send({ success: false, message: "This bed is no longer available." });

      const existing = await prisma.hostelAllocation.findFirst({ where: { studentId: Number(b.studentId), status: "ACTIVE" } });
      if (existing) return reply.status(409).send({ success: false, message: "This student is already allocated to a hostel." });

      const allocation = await prisma.hostelAllocation.create({
        data: {
          schoolId, studentId: Number(b.studentId), hostelId: Number(b.hostelId), roomId: Number(b.roomId), bedId: Number(b.bedId),
          allocationDate: new Date(), academicYear: `${new Date().getFullYear()}-${(new Date().getFullYear() + 1 - 2000)}`,
          remarks: b.remarks ?? null, allocatedById: staffId ?? null,
        },
      });

      await prisma.hostelBed.update({ where: { id: Number(b.bedId) }, data: { status: "OCCUPIED" } });
      await syncRoomAndHostelCounts(Number(b.roomId));

      return reply.status(201).send({ success: true, message: "Student allocated successfully.", data: { allocation } });
    }
  );
}
