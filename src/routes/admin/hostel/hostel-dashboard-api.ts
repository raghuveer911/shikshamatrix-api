// apps/api/src/routes/admin/hostel/hostel-dashboard-api.ts
//
// ENRICHED — the original returned kpis/roomStatusMap/hostelOccupancy/
// recent with no way to surface "what needs attention" (a maintenance
// room, a hostel about to be full) without the admin scanning every
// number by hand. Added an `alerts` block (same shape as the Finance
// dashboard's alerts) and warden names on each hostel's occupancy row
// so the premium frontend can show them without a second request.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminHostelDashboardRoutes(app: FastifyInstance) {
  const P = "/admin/hostel";

  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('hostel.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [totalHostels, roomStats, bedStats, activeStudents] = await Promise.all([
        prisma.hostel.count({ where: { schoolId, isActive: true } }),
        prisma.hostelRoom.groupBy({ by: ["status"], where: { hostel: { schoolId } }, _count: { id: true } }),
        prisma.hostelBed.aggregate({ where: { room: { hostel: { schoolId } } }, _count: { id: true } }),
        prisma.hostelAllocation.count({ where: { schoolId, status: "ACTIVE" } }),
      ]);

      const occupiedBeds = await prisma.hostelBed.count({ where: { room: { hostel: { schoolId } }, status: "OCCUPIED" } });
      const availBeds    = bedStats._count.id - occupiedBeds;

      // Per-hostel occupancy — now with the warden's name attached so
      // the dashboard can show "who to call" right next to the number.
      const hostels = await prisma.hostel.findMany({
        where: { schoolId, isActive: true },
        select: {
          id: true, name: true, hostelType: true, status: true, totalBeds: true, occupiedBeds: true,
          warden: { select: { user: { select: { name: true, phone: true } } } },
          _count: { select: { floors: true, rooms: true } },
        },
        orderBy: { name: "asc" },
      });

      // Gender distribution
      const [boysCount, girlsCount] = await Promise.all([
        prisma.hostelAllocation.count({ where: { schoolId, status: "ACTIVE", hostel: { hostelType: "BOYS" } } }),
        prisma.hostelAllocation.count({ where: { schoolId, status: "ACTIVE", hostel: { hostelType: "GIRLS" } } }),
      ]);

      // Room status map
      const roomStatusMap: Record<string, number> = {};
      roomStats.forEach(r => { roomStatusMap[r.status] = r._count.id; });

      // ADDED: things worth flagging, same idea as the Finance
      // dashboard's alerts block — computed here so the frontend
      // doesn't need a second round trip.
      const [roomsWithoutFloor, hostelsWithoutWarden] = await Promise.all([
        prisma.hostelRoom.count({ where: { hostel: { schoolId }, floorId: null } }),
        prisma.hostel.count({ where: { schoolId, isActive: true, wardenId: null } }),
      ]);
      const nearFullHostels = hostels.filter(h => h.totalBeds > 0 && h.occupiedBeds / h.totalBeds >= 0.9).length;

      // Recent activities (latest 8 allocations)
      const recent = await prisma.hostelAllocation.findMany({
        where: { schoolId },
        include: {
          student: { include: { user: { select: { name: true, avatarUrl: true } } } },
          hostel:  { select: { name: true } },
          room:    { select: { roomNumber: true } },
          bed:     { select: { bedCode: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
      });

      return rep.send({
        kpis: {
          totalHostels,
          totalRooms:   (roomStatusMap.AVAILABLE ?? 0) + (roomStatusMap.PARTIAL ?? 0) + (roomStatusMap.OCCUPIED ?? 0) + (roomStatusMap.MAINTENANCE ?? 0) + (roomStatusMap.BLOCKED ?? 0),
          totalBeds:    bedStats._count.id,
          occupiedBeds,
          availBeds,
          activeStudents,
          boysCount,
          girlsCount,
        },
        roomStatusMap,
        hostelOccupancy: hostels.map(h => ({
          ...h,
          pct: h.totalBeds > 0 ? Math.round((h.occupiedBeds / h.totalBeds) * 100) : 0,
          wardenName: h.warden?.user?.name ?? null,
          floorsCount: h._count.floors,
          roomsCount: h._count.rooms,
        })),
        alerts: {
          maintenanceRooms: roomStatusMap.MAINTENANCE ?? 0,
          blockedRooms: roomStatusMap.BLOCKED ?? 0,
          nearFullHostels,
          hostelsWithoutWarden,
          roomsWithoutFloor,
        },
        recent,
      });
    }
  );
}