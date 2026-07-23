import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { requireCapability } from "../../middleware/checkCapability.js";

export async function staffTransportRoutes(app: FastifyInstance) {
  const P = "/staff/transport";

  // ── GET /staff/transport/overview ───────────────────────
  app.get(`${P}/overview`, { preHandler: [appAuth, requireCapability("transport.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const [totalVehicles, totalRoutes, seatAgg] = await Promise.all([
        prisma.transportVehicle.count({ where: { schoolId, isActive: true } }),
        prisma.transportRoute.count({ where: { schoolId, isActive: true } }),
        prisma.transportRoute.aggregate({ where: { schoolId, isActive: true }, _sum: { totalSeats: true, occupiedSeats: true } }),
      ]);
      const totalSeats = seatAgg._sum.totalSeats ?? 0;
      const occupiedSeats = seatAgg._sum.occupiedSeats ?? 0;
      return reply.send({ success: true, data: { totalVehicles, totalRoutes, totalSeats, occupiedSeats, availSeats: totalSeats - occupiedSeats } });
    }
  );

  // ── GET /staff/transport/vehicles ────────────────────────
  app.get(`${P}/vehicles`, { preHandler: [appAuth, requireCapability("transport.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = req.query as { search?: string };
      const where: any = { schoolId, isActive: true };
      if (q.search) where.OR = [
        { vehicleNo: { contains: q.search, mode: "insensitive" } },
        { vehicleName: { contains: q.search, mode: "insensitive" } },
      ];

      const vehicles = await prisma.transportVehicle.findMany({
        where, orderBy: { vehicleNo: "asc" },
        include: { driver: { include: { user: { select: { name: true, phone: true } } } }, routes: { where: { isActive: true }, select: { routeName: true } } },
      });
      return reply.send({ success: true, data: { vehicles } });
    }
  );

  // ── GET /staff/transport/vehicles/:id ────────────────────
  app.get(`${P}/vehicles/:id`, { preHandler: [appAuth, requireCapability("transport.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };
      const vehicle = await prisma.transportVehicle.findFirst({
        where: { id: Number(id), schoolId },
        include: {
          driver: { include: { user: { select: { name: true, phone: true, avatarUrl: true } } } },
          conductor: { include: { user: { select: { name: true, phone: true } } } },
          routes: { where: { isActive: true }, select: { id: true, routeName: true, routeCode: true } },
          documents: { orderBy: { expiryDate: "asc" } },
        },
      });
      if (!vehicle) return reply.status(404).send({ success: false, message: "Vehicle not found." });
      return reply.send({ success: true, data: { vehicle } });
    }
  );

  // ── GET /staff/transport/routes ──────────────────────────
  app.get(`${P}/routes`, { preHandler: [appAuth, requireCapability("transport.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = req.query as { search?: string };
      const where: any = { schoolId, isActive: true };
      if (q.search) where.OR = [
        { routeName: { contains: q.search, mode: "insensitive" } },
        { routeCode: { contains: q.search, mode: "insensitive" } },
      ];

      const routes = await prisma.transportRoute.findMany({
        where, orderBy: { routeName: "asc" },
        include: { vehicle: { select: { vehicleNo: true, vehicleName: true, driver: { include: { user: { select: { name: true } } } } } }, _count: { select: { stops: true } } },
      });
      return reply.send({
        success: true,
        data: {
          routes: routes.map((r) => ({ ...r, availSeats: Math.max(0, r.totalSeats - r.occupiedSeats), pct: r.totalSeats > 0 ? Math.round((r.occupiedSeats / r.totalSeats) * 100) : 0 })),
        },
      });
    }
  );

  // ── GET /staff/transport/routes/:id ──────────────────────
  app.get(`${P}/routes/:id`, { preHandler: [appAuth, requireCapability("transport.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };
      const route = await prisma.transportRoute.findFirst({
        where: { id: Number(id), schoolId },
        include: {
          vehicle: { select: { vehicleNo: true, vehicleName: true, driver: { include: { user: { select: { name: true, phone: true } } } } } },
          stops: { orderBy: { sequenceNo: "asc" } },
        },
      });
      if (!route) return reply.status(404).send({ success: false, message: "Route not found." });
      return reply.send({ success: true, data: { route } });
    }
  );

  // ── GET /staff/transport/live ─────────────────────────────
  // Professional-tier only, matching admin's transport.liveTracking gate.
  app.get(`${P}/live`, { preHandler: [appAuth, requireCapability("transport.liveTracking")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const vehicles = await prisma.transportVehicle.findMany({
        where: { schoolId, isActive: true, status: "ACTIVE" },
        include: {
          driver: { include: { user: { select: { name: true, phone: true } } } },
          routes: { where: { isActive: true, status: "ACTIVE" }, select: { routeName: true } },
          trips: { where: { status: { in: ["IN_PROGRESS", "SCHEDULED"] }, tripDate: { gte: new Date(new Date().toDateString()) } }, orderBy: { createdAt: "desc" }, take: 1, include: { route: { select: { routeName: true } } } },
        },
        orderBy: { vehicleNo: "asc" },
      });

      const now = new Date();
      const enriched = vehicles.map((v) => {
        const lastSeenSec = v.lastSeen ? (now.getTime() - v.lastSeen.getTime()) / 1000 : null;
        const gpsStatus = lastSeenSec === null ? "OFFLINE" : lastSeenSec < 60 ? "ONLINE" : lastSeenSec < 300 ? "DELAYED" : "OFFLINE";
        const activeTrip = v.trips?.[0] ?? null;
        return {
          id: v.id, vehicleNo: v.vehicleNo, vehicleName: v.vehicleName,
          latitude: v.lastLatitude, longitude: v.lastLongitude, speed: v.lastSpeed, lastSeen: v.lastSeen,
          gpsStatus, driver: v.driver?.user,
          route: activeTrip?.route?.routeName ?? v.routes?.[0]?.routeName ?? "—",
          tripStatus: activeTrip?.status ?? "NO_TRIP", stopsCompleted: activeTrip?.stopsCompleted ?? 0,
        };
      });

      return reply.send({ success: true, data: { vehicles: enriched, timestamp: now } });
    }
  );
}
