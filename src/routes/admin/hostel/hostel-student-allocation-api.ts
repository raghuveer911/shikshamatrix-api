// apps/api/src/routes/admin/hostel/hostel-student-allocation-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// Sync room & hostel counts after any allocation change
async function syncRoomCounts(roomId: number) {
  const occupied = await prisma.hostelBed.count({ where: { roomId, status: "OCCUPIED" } });
  const capacity = await prisma.hostelRoom.findFirst({ where: { id: roomId }, select: { capacity: true } });
  const cap = capacity?.capacity ?? 1;
  const status: any = occupied === 0 ? "AVAILABLE" : occupied >= cap ? "OCCUPIED" : "PARTIAL";
  const room = await prisma.hostelRoom.update({ where: { id: roomId }, data: { occupiedCount: occupied, status } });
  const hostel = await prisma.hostel.findFirst({ where: { id: room.hostelId }, select: { id: true } });
  if (hostel) {
    const [totalBeds, occupiedBeds] = await Promise.all([
      prisma.hostelBed.count({ where: { room: { hostelId: hostel.id } } }),
      prisma.hostelBed.count({ where: { room: { hostelId: hostel.id }, status: "OCCUPIED" } }),
    ]);
    await prisma.hostel.update({ where: { id: hostel.id }, data: { totalBeds, occupiedBeds } });
  }
}

export async function adminHostelAllocationRoutes(app: FastifyInstance) {
  const P = "/admin/hostel/allocations";

  // Step 1 — search students (not already allocated)
  app.get(`${P}/search-students`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const where: any = { schoolId, isActive: true };
    if (q.search) {
      where.OR = [
        { user: { name: { contains: q.search, mode: "insensitive" } } },
        { admissionNo: { contains: q.search, mode: "insensitive" } },
      ];
    }
    if (q.classId) where.classId = Number(q.classId);
    if (q.gender)  where.gender  = q.gender;
    // Exclude already-allocated
    if (q.excludeAllocated === "true") {
      const allocated = await prisma.hostelAllocation.findMany({ where: { schoolId, status: "ACTIVE" }, select: { studentId: true } });
      where.id = { notIn: allocated.map(a => a.studentId) };
    }
    const students = await prisma.student.findMany({
      where,
      include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } },
      orderBy: { user: { name: "asc" } },
      take: Number(q.limit ?? 20),
    });
    return rep.send({ students });
  });

  // Step 2 — available hostels (gender-filtered)
  app.get(`${P}/available-hostels`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const where: any = { schoolId, isActive: true, status: { in: ["ACTIVE"] } };
    // Gender filter
    if (q.gender === "MALE")   where.hostelType = { in: ["BOYS",  "MIXED"] };
    if (q.gender === "FEMALE") where.hostelType = { in: ["GIRLS", "MIXED"] };
    const hostels = await prisma.hostel.findMany({
      where,
      select: { id: true, name: true, hostelType: true, totalBeds: true, occupiedBeds: true, facilities: true },
      orderBy: { name: "asc" },
    });
    return rep.send({ hostels: hostels.map(h => ({ ...h, availBeds: h.totalBeds - h.occupiedBeds })) });
  });

  // Step 3 — available rooms in hostel
  app.get(`${P}/available-rooms/:hostelId`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const hostelId = Number((req.params as any).hostelId);
    const rooms = await prisma.hostelRoom.findMany({
      where: { hostelId, status: { in: ["AVAILABLE", "PARTIAL"] } },
      include: { roomType: { select: { name: true, capacity: true, amenities: true } }, floor: { select: { floorName: true } } },
      orderBy: { roomNumber: "asc" },
    });
    return rep.send({ rooms });
  });

  // Step 4 — available beds in room
  app.get(`${P}/available-beds/:roomId`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const roomId = Number((req.params as any).roomId);
    const beds = await prisma.hostelBed.findMany({
      where: { roomId, status: "AVAILABLE" },
      orderBy: { bedCode: "asc" },
    });
    return rep.send({ beds });
  });

  // Allocate student (Step 5)
  app.post(P, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const b = req.body as any;
    const studentId = Number(b.studentId);
    const hostelId  = Number(b.hostelId);
    const roomId    = Number(b.roomId);
    const bedId     = Number(b.bedId);

    // Validate bed is available
    const bed = await prisma.hostelBed.findFirst({ where: { id: bedId, status: "AVAILABLE" } });
    if (!bed) return rep.code(409).send({ error: "Bed is not available" });

    // Validate student not already allocated
    const existing = await prisma.hostelAllocation.findFirst({ where: { studentId, status: "ACTIVE" } });
    if (existing) return rep.code(409).send({ error: "Student is already allocated to a hostel" });

    const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId }, select: { id: true } });

    const allocation = await prisma.hostelAllocation.create({
      data: {
        schoolId, studentId, hostelId, roomId, bedId,
        allocationDate: new Date(b.allocationDate ?? new Date()),
        academicYear:   b.academicYear ?? new Date().getFullYear() + "-" + (new Date().getFullYear() + 1 - 2000),
        remarks:        b.remarks ?? null,
        allocatedById:  staff?.id ?? null,
      },
      include: {
        student: { include: { user: { select: { name: true } } } },
        hostel:  { select: { name: true } },
        room:    { select: { roomNumber: true } },
        bed:     { select: { bedCode: true } },
      },
    });

    // Mark bed as OCCUPIED
    await prisma.hostelBed.update({ where: { id: bedId }, data: { status: "OCCUPIED" } });
    await syncRoomCounts(roomId);

    return rep.code(201).send({ allocation });
  });

  // Current allocations list
  app.get(P, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const where: any = { schoolId };
    if (q.status)   where.status   = q.status  ?? "ACTIVE";
    if (q.hostelId) where.hostelId = Number(q.hostelId);
    if (q.search) {
      where.student = { user: { name: { contains: q.search, mode: "insensitive" } } };
    }
    const [allocations, total] = await Promise.all([
      prisma.hostelAllocation.findMany({
        where,
        include: {
          student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } },
          hostel:  { select: { name: true, hostelType: true } },
          room:    { select: { roomNumber: true } },
          bed:     { select: { bedCode: true } },
        },
        orderBy: { allocationDate: "desc" },
        skip: (Number(q.page ?? 1) - 1) * 50,
        take: 50,
      }),
      prisma.hostelAllocation.count({ where }),
    ]);
    return rep.send({ allocations, total });
  });

  // Transfer student
  app.post(`${P}/:id/transfer`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;

    const old = await prisma.hostelAllocation.findFirst({ where: { id, schoolId, status: "ACTIVE" } });
    if (!old) return rep.code(404).send({ error: "Active allocation not found" });

    const newBed = await prisma.hostelBed.findFirst({ where: { id: Number(b.newBedId), status: "AVAILABLE" } });
    if (!newBed) return rep.code(409).send({ error: "Target bed is not available" });

    // Vacate old
    await prisma.hostelAllocation.update({ where: { id }, data: { status: "TRANSFERRED", vacateDate: new Date(), vacateReason: "TRANSFERRED" } });
    await prisma.hostelBed.update({ where: { id: old.bedId }, data: { status: "AVAILABLE" } });
    await syncRoomCounts(old.roomId);

    // Create new
    const allocation = await prisma.hostelAllocation.create({
      data: { schoolId, studentId: old.studentId, hostelId: Number(b.newHostelId), roomId: Number(b.newRoomId), bedId: Number(b.newBedId), allocationDate: new Date(), academicYear: old.academicYear, previousAllocationId: id, remarks: b.remarks ?? "Transferred" },
      include: { hostel: { select: { name: true } }, room: { select: { roomNumber: true } }, bed: { select: { bedCode: true } } },
    });
    await prisma.hostelBed.update({ where: { id: Number(b.newBedId) }, data: { status: "OCCUPIED" } });
    await syncRoomCounts(Number(b.newRoomId));

    return rep.send({ allocation });
  });

  // Vacate student
  app.post(`${P}/:id/vacate`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;

    const alloc = await prisma.hostelAllocation.findFirst({ where: { id, schoolId, status: "ACTIVE" } });
    if (!alloc) return rep.code(404).send({ error: "Active allocation not found" });

    await prisma.hostelAllocation.update({ where: { id }, data: { status: "VACATED", vacateDate: new Date(b.vacateDate ?? new Date()), vacateReason: b.reason as any ?? "HOSTEL_LEFT", vacateNote: b.note ?? null } });
    await prisma.hostelBed.update({ where: { id: alloc.bedId }, data: { status: "AVAILABLE" } });
    await syncRoomCounts(alloc.roomId);

    return rep.send({ ok: true });
  });

  // Allocation history (per student)
  app.get(`${P}/history/:studentId`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const studentId = Number((req.params as any).studentId);
    const history = await prisma.hostelAllocation.findMany({
      where: { studentId, schoolId },
      include: { hostel: { select: { name: true } }, room: { select: { roomNumber: true } }, bed: { select: { bedCode: true } } },
      orderBy: { createdAt: "desc" },
    });
    return rep.send({ history });
  });

  // Reports
  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [byHostel, byStatus] = await Promise.all([
      prisma.hostelAllocation.groupBy({ by: ["hostelId"], where: { schoolId, status: "ACTIVE" }, _count: { id: true } }),
      prisma.hostelAllocation.groupBy({ by: ["status"], where: { schoolId }, _count: { id: true } }),
    ]);
    const hostelIds = byHostel.map(h => h.hostelId);
    const hostels   = await prisma.hostel.findMany({ where: { id: { in: hostelIds } }, select: { id: true, name: true } });
    const hMap      = Object.fromEntries(hostels.map(h => [h.id, h]));
    return rep.send({ byHostel: byHostel.map(h => ({ ...h, hostel: hMap[h.hostelId] })), byStatus });
  });
}
