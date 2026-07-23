// apps/api/src/routes/admin/transport/transport-tracking-api.ts
// Pure TypeScript — NO JSX, NO className
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminTransportTrackingRoutes(app: FastifyInstance) {
  const P = "/admin/transport/tracking";

  // ─── LIVE STATUS (all vehicles) ──────────────────────────
  app.get(`${P}/live`, { preHandler: [authenticate, requireCapability('transport.liveTracking')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const vehicles = await prisma.transportVehicle.findMany({
      where: { schoolId, isActive: true, status: "ACTIVE" },
      include: {
        driver: { include: { user: { select: { name: true, phone: true } } } },
        routes: { where: { isActive: true, status: "ACTIVE" }, select: { id: true, routeName: true, routeCode: true } },
        trips:  {
          where: { status: { in: ["IN_PROGRESS","SCHEDULED"] }, tripDate: { gte: new Date(new Date().toDateString()) } },
          orderBy: { createdAt: "desc" }, take: 1,
          include: { route: { select: { routeName: true } } },
        },
      },
      orderBy: { vehicleNo: "asc" },
    });

    const now = new Date();
    const enriched = vehicles.map(v => {
      const lastSeenSec = v.lastSeen ? (now.getTime() - v.lastSeen.getTime()) / 1000 : null;
      const gpsStatus = lastSeenSec === null ? "OFFLINE"
        : lastSeenSec < 60  ? "ONLINE"
        : lastSeenSec < 300 ? "DELAYED"
        : "OFFLINE";
      const activeTrip = v.trips?.[0] ?? null;
      return {
        id: v.id, vehicleNo: v.vehicleNo, vehicleName: v.vehicleName,
        latitude: v.lastLatitude, longitude: v.lastLongitude,
        speed: v.lastSpeed, lastSeen: v.lastSeen,
        gpsStatus, vehicleStatus: v.status,
        driver: v.driver?.user,
        route: activeTrip?.route?.routeName ?? v.routes?.[0]?.routeName ?? "—",
        tripStatus: activeTrip?.status ?? "NO_TRIP",
        stopsCompleted: activeTrip?.stopsCompleted ?? 0,
      };
    });

    return rep.send({ vehicles: enriched, timestamp: now });
  });

  // ─── VEHICLE MONITOR TABLE ───────────────────────────────
  app.get(`${P}/monitor`, { preHandler: [authenticate, requireCapability('transport.liveTracking')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const today = new Date(new Date().toDateString());
    const trips = await prisma.transportTrip.findMany({
      where: { schoolId, tripDate: { gte: today } },
      include: {
        vehicle: { include: { driver: { include: { user: { select: { name: true } } } } } },
        route:   { select: { routeName: true, routeCode: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return rep.send({ trips });
  });

  // ─── START / UPDATE / COMPLETE TRIP ──────────────────────
  app.post(`${P}/trips/:tripId/start`, { preHandler: [authenticate, requireCapability('transport.liveTracking')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const tripId = Number((req.params as any).tripId);
    const b = req.body as any;
    const trip = await prisma.transportTrip.update({
      where: { id: tripId, schoolId },
      data: { status: "IN_PROGRESS", actualStart: new Date(), startLatitude: b.latitude ? Number(b.latitude) : null, startLongitude: b.longitude ? Number(b.longitude) : null },
    });
    return rep.send({ trip });
  });

  app.post(`${P}/trips/:tripId/stop-reached`, { preHandler: [authenticate, requireCapability('transport.liveTracking')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const tripId = Number((req.params as any).tripId);
    const trip = await prisma.transportTrip.update({ where: { id: tripId, schoolId }, data: { stopsCompleted: { increment: 1 } } });
    return rep.send({ trip });
  });

  app.post(`${P}/trips/:tripId/complete`, { preHandler: [authenticate, requireCapability('transport.liveTracking')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const tripId = Number((req.params as any).tripId);
    const b = req.body as any;
    const trip = await prisma.transportTrip.update({
      where: { id: tripId, schoolId },
      data: { status: "COMPLETED", actualEnd: new Date(), endLatitude: b.latitude ? Number(b.latitude) : null, endLongitude: b.longitude ? Number(b.longitude) : null, totalDistance: b.distance ? Number(b.distance) : null },
    });
    return rep.send({ trip });
  });

  app.post(`${P}/trips/:tripId/delay`, { preHandler: [authenticate, requireCapability('transport.liveTracking')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const tripId = Number((req.params as any).tripId);
    const trip = await prisma.transportTrip.update({ where: { id: tripId, schoolId }, data: { status: "DELAYED", notes: (req.body as any).reason ?? "Delayed" } });
    return rep.send({ trip });
  });

  // ─── LOCATION LOGS ───────────────────────────────────────
  app.get(`${P}/logs/:vehicleId`, { preHandler: [authenticate, requireCapability('transport.liveTracking')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const vehicleId = Number((req.params as any).vehicleId);
    const q = req.query as any;
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 2 * 3600000); // last 2 hours
    const to   = q.to   ? new Date(q.to)   : new Date();
    const logs = await prisma.transportTracking.findMany({
      where: { vehicleId, timestamp: { gte: from, lte: to } },
      orderBy: { timestamp: "asc" },
      take: Number(q.limit ?? 500),
    });
    return rep.send({ logs, from, to });
  });

  // ─── TRIP HISTORY ─────────────────────────────────────────
  app.get(`${P}/history`, { preHandler: [authenticate, requireCapability('transport.liveTracking')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86400000);
    const to   = q.to   ? new Date(q.to)   : new Date();
    const where: any = { schoolId, tripDate: { gte: from, lte: to } };
    if (q.vehicleId) where.vehicleId = Number(q.vehicleId);
    if (q.status)    where.status    = q.status;
    const [trips, total] = await Promise.all([
      prisma.transportTrip.findMany({
        where, include: { vehicle: { select: { vehicleNo: true, vehicleName: true } }, route: { select: { routeName: true } }, driver: { include: { user: { select: { name: true } } } } },
        orderBy: { tripDate: "desc" }, skip: (Number(q.page ?? 1) - 1) * 50, take: 50,
      }),
      prisma.transportTrip.count({ where }),
    ]);
    return rep.send({ trips, total });
  });

  // ─── ANALYTICS ───────────────────────────────────────────
  app.get(`${P}/analytics`, { preHandler: [authenticate, requireCapability('transport.liveTracking')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const today = new Date(new Date().toDateString());
    const week  = new Date(today.getTime() - 7 * 86400000);
    const [byStatus, todayTrips, weekTrips, completionRate, distAgg] = await Promise.all([
      prisma.transportTrip.groupBy({ by: ["status"],    where: { schoolId, tripDate: { gte: week } }, _count: { id: true } }),
      prisma.transportTrip.count({ where: { schoolId, tripDate: { gte: today } } }),
      prisma.transportTrip.count({ where: { schoolId, tripDate: { gte: week } } }),
      prisma.transportTrip.count({ where: { schoolId, tripDate: { gte: week }, status: "COMPLETED" } }),
      prisma.transportTrip.aggregate({ where: { schoolId, status: "COMPLETED", tripDate: { gte: week } }, _avg: { totalDistance: true }, _sum: { totalDistance: true } }),
    ]);
    return rep.send({
      byStatus, todayTrips, weekTrips,
      completionRate: weekTrips > 0 ? Math.round((completionRate / weekTrips) * 100) : 0,
      avgDistance:    distAgg._avg.totalDistance ? Number(distAgg._avg.totalDistance.toFixed(1)) : null,
      totalDistance:  Number(distAgg._sum.totalDistance ?? 0),
    });
  });
}
