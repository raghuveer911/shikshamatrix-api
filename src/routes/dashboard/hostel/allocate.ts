import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { z } from "zod";

const allocateSchema = z.object({
  studentId:    z.number(),
  hostelId:     z.number(),
  roomId:       z.number(),
  bedId:        z.number(),
  academicYear: z.string(),
  remarks:      z.string().optional(),
});

const vacateSchema = z.object({
  allocationId: z.number(),
  vacateReason: z.enum(["GRADUATED", "TRANSFERRED", "WITHDRAWN", "DISCIPLINARY", "OTHER"]).optional(),
  vacateNote:   z.string().optional(),
});

export async function hostelAllocateRoutes(app: FastifyInstance) {

  // ── GET /hostel/residents — All active residents ────────────
  app.get("/hostel/residents",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { hostelId, search, page = "1" } = req.query as Record<string, string>;
      const skip = (parseInt(page) - 1) * 30;

      const where: any = {
        schoolId, status: "ACTIVE",
        ...(hostelId ? { hostelId: parseInt(hostelId) } : {}),
        ...(search ? {
          student: {
            OR: [
              { user: { name: { contains: search, mode: "insensitive" } } },
              { admissionNo: { contains: search, mode: "insensitive" } },
            ],
          },
        } : {}),
      };

      const [allocations, total] = await Promise.all([
        prisma.hostelAllocation.findMany({
          where, skip, take: 30,
          orderBy: { allocationDate: "desc" },
          select: {
            id: true, allocationDate: true, academicYear: true,
            student: {
              select: {
                id: true, admissionNo: true, rollNumber: true,
                user:  { select: { name: true, phone: true } },
                class: { select: { name: true, section: true } },
              },
            },
            hostel: { select: { name: true } },
            room:   { select: { roomNumber: true } },
            bed:    { select: { bedCode: true } },
          },
        }),
        prisma.hostelAllocation.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: {
          residents: allocations.map((a) => ({
            id: a.id,
            allocationDate: a.allocationDate,
            academicYear: a.academicYear,
            studentId: a.student.id,
            name: a.student.user.name,
            phone: a.student.user.phone,
            admissionNo: a.student.admissionNo,
            className: `${a.student.class?.name ?? ""} ${a.student.class?.section ?? ""}`,
            hostelName: a.hostel.name,
            roomNumber: a.room.roomNumber,
            bedCode: a.bed.bedCode,
          })),
          pagination: { total, page: parseInt(page), totalPages: Math.ceil(total / 30) },
        },
      });
    }
  );

  // ── GET /hostel/students/search — Unallocated students ──────
  app.get("/hostel/students/search",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { q } = req.query as { q: string };

      if (!q || q.trim().length < 2) {
        return reply.send({ success: true, data: { students: [] } });
      }

      const students = await prisma.student.findMany({
        where: {
          schoolId, isActive: true,
          OR: [
            { user: { name: { contains: q, mode: "insensitive" } } },
            { admissionNo: { contains: q, mode: "insensitive" } },
          ],
          // Not currently allocated
          hostelAllocations: { none: { status: "ACTIVE" } },
        },
        take: 15,
        select: {
          id: true, admissionNo: true, rollNumber: true,
          user:  { select: { name: true } },
          class: { select: { name: true, section: true } },
        },
      });

      return reply.send({
        success: true,
        data: {
          students: students.map((s) => ({
            id: s.id, name: s.user.name,
            admissionNo: s.admissionNo,
            className: `${s.class?.name ?? ""} ${s.class?.section ?? ""}`,
          })),
        },
      });
    }
  );

  // ── GET /hostel/available-beds — beds for allocation ────────
  app.get("/hostel/available-beds",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { hostelId } = req.query as { hostelId: string };

      const rooms = await prisma.hostelRoom.findMany({
        where: {
          ...(hostelId ? { hostelId: parseInt(hostelId) } : {}),
          hostel: { schoolId },
          status: { in: ["AVAILABLE", "PARTIALLY_OCCUPIED"] },
          beds: { some: { status: "AVAILABLE" } },
        },
        select: {
          id: true, roomNumber: true,
          floor: { select: { floorName: true } },
          roomType: { select: { name: true } },
          beds: {
            where:  { status: "AVAILABLE" },
            select: { id: true, bedCode: true },
          },
        },
        orderBy: { roomNumber: "asc" },
      });

      return reply.send({
        success: true,
        data: {
          rooms: rooms.map((r) => ({
            id: r.id, roomNumber: r.roomNumber,
            floor: r.floor?.floorName ?? "",
            roomType: r.roomType?.name ?? "",
            availableBeds: r.beds,
          })),
        },
      });
    }
  );

  // ── POST /hostel/allocate — Allocate student ────────────────
  app.post("/hostel/allocate",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;

      const parsed = allocateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });
      }

      const { studentId, hostelId, roomId, bedId, academicYear, remarks } = parsed.data;

      // Verify bed is available
      const bed = await prisma.hostelBed.findFirst({
        where: { id: bedId, roomId, status: "AVAILABLE" },
      });
      if (!bed) {
        return reply.status(400).send({ success: false, error: "BED_NOT_AVAILABLE" });
      }

      await prisma.$transaction(async (tx) => {
        // Create allocation
        await tx.hostelAllocation.create({
          data: {
            schoolId, studentId, hostelId, roomId, bedId,
            status: "ACTIVE", allocationDate: new Date(),
            academicYear, remarks: remarks ?? null,
            allocatedById: staffId,
          },
        });

        // Mark bed occupied
        await tx.hostelBed.update({
          where: { id: bedId }, data: { status: "OCCUPIED" },
        });

        // Update room occupied count + status
        const room = await tx.hostelRoom.update({
          where: { id: roomId },
          data:  { occupiedCount: { increment: 1 } },
        });
        const newStatus = room.occupiedCount >= room.capacity
          ? "FULL" : "PARTIALLY_OCCUPIED";
        await tx.hostelRoom.update({
          where: { id: roomId }, data: { status: newStatus },
        });

        // Update hostel occupied beds
        await tx.hostel.update({
          where: { id: hostelId },
          data:  { occupiedBeds: { increment: 1 } },
        });
      });

      return reply.status(201).send({
        success: true,
        message: "Student allocated successfully",
      });
    }
  );

  // ── POST /hostel/vacate — Vacate allocation ─────────────────
  app.post("/hostel/vacate",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;

      const parsed = vacateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });
      }

      const { allocationId, vacateReason, vacateNote } = parsed.data;

      const alloc = await prisma.hostelAllocation.findFirst({
        where: { id: allocationId, schoolId, status: "ACTIVE" },
      });
      if (!alloc) {
        return reply.status(404).send({ success: false, error: "ALLOCATION_NOT_FOUND" });
      }

      await prisma.$transaction(async (tx) => {
        await tx.hostelAllocation.update({
          where: { id: allocationId },
          data: {
            status: "VACATED", vacateDate: new Date(),
            vacateReason: vacateReason ?? null,
            vacateNote: vacateNote ?? null,
          },
        });
        await tx.hostelBed.update({
          where: { id: alloc.bedId }, data: { status: "AVAILABLE" },
        });
        const room = await tx.hostelRoom.update({
          where: { id: alloc.roomId },
          data:  { occupiedCount: { decrement: 1 } },
        });
        const newStatus = room.occupiedCount <= 0
          ? "AVAILABLE" : "PARTIALLY_OCCUPIED";
        await tx.hostelRoom.update({
          where: { id: alloc.roomId }, data: { status: newStatus },
        });
        await tx.hostel.update({
          where: { id: alloc.hostelId },
          data:  { occupiedBeds: { decrement: 1 } },
        });
      });

      return reply.send({ success: true, message: "Student vacated successfully" });
    }
  );
}