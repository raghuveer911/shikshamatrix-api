import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";

export async function hostelRoomsRoutes(app: FastifyInstance) {

  // ── GET /hostel/overview — Stats ────────────────────────────
  app.get("/hostel/overview",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;

      const hostels = await prisma.hostel.findMany({
        where:  { schoolId, isActive: true },
        select: {
          id: true, name: true, hostelType: true,
          totalRooms: true, totalBeds: true, occupiedBeds: true,
        },
      });

      const totalBeds     = hostels.reduce((s, h) => s + h.totalBeds, 0);
      const occupiedBeds  = hostels.reduce((s, h) => s + h.occupiedBeds, 0);
      const residents = await prisma.hostelAllocation.count({
        where: { schoolId, status: "ACTIVE" },
      });

      return reply.send({
        success: true,
        data: {
          hostels:      hostels.length,
          totalBeds, occupiedBeds,
          availableBeds: totalBeds - occupiedBeds,
          residents,
          occupancyPct: totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0,
        },
      });
    }
  );

  // ── GET /hostel/hostels — Hostel list ───────────────────────
  app.get("/hostel/hostels",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;

      const hostels = await prisma.hostel.findMany({
        where:   { schoolId, isActive: true },
        orderBy: { name: "asc" },
        select: {
          id: true, hostelCode: true, name: true, hostelType: true,
          status: true, totalRooms: true, totalBeds: true, occupiedBeds: true,
          facilities: true,
          warden: { select: { user: { select: { name: true, phone: true } } } },
        },
      });

      return reply.send({
        success: true,
        data: {
          hostels: hostels.map((h) => ({
            id: h.id, hostelCode: h.hostelCode, name: h.name,
            hostelType: h.hostelType, status: h.status,
            totalRooms: h.totalRooms, totalBeds: h.totalBeds,
            occupiedBeds: h.occupiedBeds,
            availableBeds: h.totalBeds - h.occupiedBeds,
            occupancyPct: h.totalBeds > 0 ? Math.round((h.occupiedBeds / h.totalBeds) * 100) : 0,
            facilities: h.facilities,
            wardenName: h.warden?.user?.name ?? "Not assigned",
            wardenPhone: h.warden?.user?.phone,
          })),
        },
      });
    }
  );

  // ── GET /hostel/rooms — Rooms list (filter by hostel) ───────
  app.get("/hostel/rooms",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { hostelId, status } = req.query as Record<string, string>;

      const where: any = {
        ...(hostelId ? { hostelId: parseInt(hostelId) } : {}),
        hostel: { schoolId },
        ...(status ? { status } : {}),
      };

      const rooms = await prisma.hostelRoom.findMany({
        where,
        orderBy: { roomNumber: "asc" },
        select: {
          id: true, roomNumber: true, capacity: true, occupiedCount: true,
          status: true, floor_label: true,
          hostel:   { select: { name: true } },
          roomType: { select: { name: true, amenities: true } },
          floor:    { select: { floorName: true } },
          beds: {
            select: { id: true, bedCode: true, status: true },
            orderBy: { bedCode: "asc" },
          },
        },
      });

      // Hostels for filter
      const hostels = await prisma.hostel.findMany({
        where:   { schoolId, isActive: true },
        select:  { id: true, name: true },
        orderBy: { name: "asc" },
      });

      return reply.send({
        success: true,
        data: {
          rooms: rooms.map((r) => ({
            id: r.id, roomNumber: r.roomNumber,
            capacity: r.capacity, occupiedCount: r.occupiedCount,
            availableBeds: r.capacity - r.occupiedCount,
            status: r.status,
            floorLabel: r.floor?.floorName ?? r.floor_label ?? "",
            hostelName: r.hostel?.name ?? "",
            roomType: r.roomType?.name ?? "—",
            amenities: r.roomType?.amenities ?? [],
            beds: r.beds,
          })),
          hostels,
        },
      });
    }
  );

  // ── GET /hostel/rooms/:id — Room detail + residents ─────────
  app.get("/hostel/rooms/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };

      const room = await prisma.hostelRoom.findFirst({
        where: { id: parseInt(id), hostel: { schoolId } },
        select: {
          id: true, roomNumber: true, capacity: true, occupiedCount: true,
          status: true, maintenanceNote: true,
          hostel:   { select: { name: true } },
          roomType: { select: { name: true, amenities: true, monthlyFee: true } },
          floor:    { select: { floorName: true } },
          beds: {
            orderBy: { bedCode: "asc" },
            select: { id: true, bedCode: true, status: true, notes: true },
          },
          allocations: {
            where: { status: "ACTIVE" },
            select: {
              id: true, bedId: true, allocationDate: true,
              student: {
                select: {
                  id: true, admissionNo: true, rollNumber: true,
                  user:  { select: { name: true, phone: true } },
                  class: { select: { name: true, section: true } },
                },
              },
              bed: { select: { bedCode: true } },
            },
          },
        },
      });

      if (!room) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      return reply.send({ success: true, data: { room } });
    }
  );
}