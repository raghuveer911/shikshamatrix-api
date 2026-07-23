// apps/api/src/routes/admin/transport/transport-routes-api.ts
// Pure TypeScript — NO JSX, NO className
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminTransportRoutesRoutes(app: FastifyInstance) {
  const P = "/admin/transport/routes";

  // LIST
  app.get(P, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const where: any = { schoolId, isActive: true };
    if (q.status)    where.status    = q.status;
    if (q.vehicleId) where.vehicleId = Number(q.vehicleId);
    if (q.search)    where.OR = [
      { routeName: { contains: q.search, mode: "insensitive" } },
      { routeCode: { contains: q.search, mode: "insensitive" } },
    ];

    const [routes, total] = await Promise.all([
      prisma.transportRoute.findMany({
        where,
        include: {
          vehicle: { select: { vehicleNo: true, vehicleName: true, vehicleType: true, driver: { include: { user: { select: { name: true } } } } } },
          _count:  { select: { stops: true } },
        },
        orderBy: { routeName: "asc" },
        skip: (Number(q.page ?? 1) - 1) * 50,
        take: 50,
      }),
      prisma.transportRoute.count({ where }),
    ]);

    return rep.send({
      routes: routes.map(r => ({
        ...r,
        availSeats: Math.max(0, r.totalSeats - r.occupiedSeats),
        pct: r.totalSeats > 0 ? Math.round((r.occupiedSeats / r.totalSeats) * 100) : 0,
      })),
      total,
    });
  });

  // GET ONE (with stops)
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const route = await prisma.transportRoute.findFirst({
      where: { id, schoolId },
      include: {
        vehicle:  { include: { driver: { include: { user: { select: { name: true, phone: true } } } }, conductor: { include: { user: { select: { name: true } } } } } },
        stops:    { where: { isActive: true }, orderBy: { sequence: "asc" } },
        _count:   { select: { trips: true } },
      },
    });
    if (!route) return rep.code(404).send({ error: "Route not found" });
    const vehicles = await prisma.transportVehicle.findMany({ where: { schoolId, isActive: true, status: "ACTIVE" }, select: { id: true, vehicleNo: true, vehicleName: true, totalSeats: true } });
    return rep.send({ route, vehicles });
  });

  // CREATE
  app.post(P, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const route = await prisma.transportRoute.create({
      data: {
        schoolId, routeName: b.routeName, routeCode: b.routeCode,
        description: b.description ?? null, status: b.status as any ?? "ACTIVE",
        vehicleId: b.vehicleId ? Number(b.vehicleId) : null,
        totalSeats: b.totalSeats ? Number(b.totalSeats) : 0,
        morningStart: b.morningStart ?? null, eveningStart: b.eveningStart ?? null,
        estimatedDuration: b.estimatedDuration ? Number(b.estimatedDuration) : null,
        coverageArea: b.coverageArea ?? null,
      },
    });
    // If vehicle assigned — copy seat count
    if (b.vehicleId) {
      const v = await prisma.transportVehicle.findFirst({ where: { id: Number(b.vehicleId) }, select: { totalSeats: true } });
      if (v) await prisma.transportRoute.update({ where: { id: route.id }, data: { totalSeats: v.totalSeats } });
    }
    return rep.code(201).send({ route });
  });

  // UPDATE
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const route = await prisma.transportRoute.update({
      where: { id, schoolId },
      data: {
        routeName: b.routeName, routeCode: b.routeCode, description: b.description,
        status: b.status as any, vehicleId: b.vehicleId ? Number(b.vehicleId) : null,
        morningStart: b.morningStart ?? undefined, eveningStart: b.eveningStart ?? undefined,
        estimatedDuration: b.estimatedDuration ? Number(b.estimatedDuration) : undefined,
        coverageArea: b.coverageArea, isActive: b.isActive,
      },
    });
    return rep.send({ route });
  });

  // ─── STOPS ───────────────────────────────────────────────

  // List stops
  app.get(`${P}/:id/stops`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const id = Number((req.params as any).id);
    const stops = await prisma.transportStop.findMany({ where: { routeId: id, isActive: true }, orderBy: { sequence: "asc" } });
    return rep.send({ stops });
  });

  // Add stop
  app.post(`${P}/:id/stops`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    // Auto-sequence: max + 1
    const maxSeq = await prisma.transportStop.aggregate({ where: { routeId: id }, _max: { sequence: true } });
    const seq = b.sequence ?? (maxSeq._max.sequence ?? 0) + 1;
    // Shift existing stops if inserting in middle
    if (b.sequence !== undefined) {
      await prisma.transportStop.updateMany({ where: { routeId: id, sequence: { gte: seq } }, data: { sequence: { increment: 1 } } });
    }
    const stop = await prisma.transportStop.create({ data: { routeId: id, stopName: b.stopName, landmark: b.landmark ?? null, sequence: seq, latitude: b.latitude ? Number(b.latitude) : null, longitude: b.longitude ? Number(b.longitude) : null, pickupTime: b.pickupTime ?? null, dropTime: b.dropTime ?? null } });
    return rep.code(201).send({ stop });
  });

  // Update stop
  app.put(`${P}/:id/stops/:stopId`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const stopId = Number((req.params as any).stopId);
    const b      = req.body as any;
    const stop = await prisma.transportStop.update({
      where: { id: stopId },
      data: { stopName: b.stopName, landmark: b.landmark, sequence: b.sequence ? Number(b.sequence) : undefined, latitude: b.latitude ? Number(b.latitude) : undefined, longitude: b.longitude ? Number(b.longitude) : undefined, pickupTime: b.pickupTime, dropTime: b.dropTime, isActive: b.isActive },
    });
    return rep.send({ stop });
  });

  // Delete stop
  app.delete(`${P}/:id/stops/:stopId`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const stopId = Number((req.params as any).stopId);
    const stop   = await prisma.transportStop.findFirst({ where: { id: stopId } });
    if (!stop) return rep.code(404).send({ error: "Stop not found" });
    await prisma.transportStop.update({ where: { id: stopId }, data: { isActive: false } });
    // Re-sequence remaining stops
    const remaining = await prisma.transportStop.findMany({ where: { routeId: stop.routeId, isActive: true }, orderBy: { sequence: "asc" } });
    await Promise.all(remaining.map((s, i) => prisma.transportStop.update({ where: { id: s.id }, data: { sequence: i + 1 } })));
    return rep.send({ ok: true });
  });

  // Reorder stops (drag-drop)
  app.put(`${P}/:id/stops/reorder`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const b = req.body as any; // { orders: [{ id, sequence }] }
    await Promise.all((b.orders ?? []).map((o: any) =>
      prisma.transportStop.update({ where: { id: Number(o.id) }, data: { sequence: Number(o.sequence) } })
    ));
    return rep.send({ ok: true });
  });

  // ─── TRIPS (create today's trip) ─────────────────────────
  app.post(`${P}/:id/trips`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const routeId = Number((req.params as any).id);
    const b = req.body as any;
    const route = await prisma.transportRoute.findFirst({ where: { id: routeId }, select: { vehicleId: true, vehicle: { select: { driverId: true } } } });
    const trip = await prisma.transportTrip.create({
      data: { schoolId, vehicleId: route?.vehicleId ? Number(route.vehicleId) : Number(b.vehicleId), routeId, driverId: route?.vehicle?.driverId ?? (b.driverId ? Number(b.driverId) : null), tripDate: b.tripDate ? new Date(b.tripDate) : new Date(), tripType: b.tripType ?? "MORNING", status: "SCHEDULED", scheduledStart: b.scheduledStart ? new Date(b.scheduledStart) : null },
    });
    return rep.code(201).send({ trip });
  });

  // REPORTS
  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [byStatus, totalStops, occupancyAgg] = await Promise.all([
      prisma.transportRoute.groupBy({ by: ["status"], where: { schoolId, isActive: true }, _count: { id: true } }),
      prisma.transportStop.count({ where: { route: { schoolId }, isActive: true } }),
      prisma.transportRoute.aggregate({ where: { schoolId, isActive: true }, _sum: { totalSeats: true, occupiedSeats: true } }),
    ]);
    return rep.send({ byStatus, totalStops, totalSeats: occupancyAgg._sum.totalSeats ?? 0, occupiedSeats: occupancyAgg._sum.occupiedSeats ?? 0 });
  });
}
