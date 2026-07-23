// apps/api/src/routes/admin/transport/transport-vehicles-api.ts
// Pure TypeScript — NO JSX, NO className
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminTransportVehiclesRoutes(app: FastifyInstance) {
  const P = "/admin/transport/vehicles";

  // LIST
  app.get(P, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const where: any = { schoolId, isActive: true };
    if (q.status) where.status = q.status;
    if (q.type)   where.vehicleType = q.type;
    if (q.search) where.OR = [
      { vehicleNo:   { contains: q.search, mode: "insensitive" } },
      { vehicleName: { contains: q.search, mode: "insensitive" } },
      { brand:       { contains: q.search, mode: "insensitive" } },
    ];

    const today   = new Date();
    const alert30 = new Date(today.getTime() + 30 * 86400000);

    const [vehicles, total] = await Promise.all([
      prisma.transportVehicle.findMany({
        where,
        include: {
          driver:    { include: { user: { select: { name: true, phone: true, avatarUrl: true } } } },
          conductor: { include: { user: { select: { name: true } } } },
          routes:    { where: { isActive: true }, select: { id: true, routeName: true, routeCode: true } },
          documents: { orderBy: { expiryDate: "asc" }, where: { expiryDate: { not: null } } },
        },
        orderBy: { vehicleNo: "asc" },
        skip: (Number(q.page ?? 1) - 1) * 30,
        take: 30,
      }),
      prisma.transportVehicle.count({ where }),
    ]);

    // Enrich with doc alerts
    const enriched = vehicles.map(v => {
      const expiringDocs = v.documents.filter(d => d.expiryDate && d.expiryDate <= alert30 && d.expiryDate >= today);
      const expiredDocs  = v.documents.filter(d => d.expiryDate && d.expiryDate < today);
      return { ...v, expiringDocs: expiringDocs.length, expiredDocs: expiredDocs.length };
    });

    return rep.send({ vehicles: enriched, total });
  });

  // GET ONE
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const vehicle = await prisma.transportVehicle.findFirst({
      where: { id, schoolId },
      include: {
        driver:    { include: { user: { select: { name: true, phone: true, role: true, avatarUrl: true } } } },
        conductor: { include: { user: { select: { name: true, phone: true } } } },
        routes:    { where: { isActive: true }, include: { _count: { select: { stops: true } } } },
        documents: { orderBy: { docType: "asc" } },
      },
    });
    if (!vehicle) return rep.code(404).send({ error: "Vehicle not found" });
    // Available drivers (staff who are not already assigned to another vehicle)
    const assignedDriverIds = (await prisma.transportVehicle.findMany({ where: { schoolId, isActive: true, driverId: { not: null }, id: { not: id } }, select: { driverId: true } })).map(v => v.driverId);
    const drivers = await prisma.staff.findMany({ where: { schoolId, isActive: true, id: { notIn: assignedDriverIds.filter(Boolean) as number[] } }, include: { user: { select: { name: true, phone: true, role: true } } }, take: 100 });
    return rep.send({ vehicle, drivers });
  });

  // CREATE
  app.post(P, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const vehicle = await prisma.transportVehicle.create({
      data: {
        schoolId,
        vehicleNo:    b.vehicleNo,
        vehicleName:  b.vehicleName  ?? null,
        vehicleType:  b.vehicleType  as any ?? "SCHOOL_BUS",
        brand:        b.brand        ?? null,
        model:        b.model        ?? null,
        year:         b.year         ? Number(b.year)         : null,
        color:        b.color        ?? null,
        totalSeats:   Number(b.totalSeats  ?? 40),
        reservedSeats:Number(b.reservedSeats ?? 0),
        driverId:    b.driverId    ? Number(b.driverId)    : null,
        conductorId: b.conductorId ? Number(b.conductorId) : null,
        status:       b.status as any ?? "ACTIVE",
        gpsDeviceId:  b.gpsDeviceId  ?? null,
        notes:        b.notes        ?? null,
      },
    });
    // Create documents if provided
    if (b.documents?.length) {
      await prisma.transportVehicleDoc.createMany({
        data: b.documents.map((d: any) => ({ vehicleId: vehicle.id, docType: d.docType, docNumber: d.docNumber ?? null, issueDate: d.issueDate ? new Date(d.issueDate) : null, expiryDate: d.expiryDate ? new Date(d.expiryDate) : null })),
        skipDuplicates: true,
      });
    }
    return rep.code(201).send({ vehicle });
  });

  // UPDATE
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const vehicle = await prisma.transportVehicle.update({
      where: { id, schoolId },
      data: {
        vehicleNo:     b.vehicleNo,
        vehicleName:   b.vehicleName,
        vehicleType:   b.vehicleType   as any,
        brand:         b.brand,
        model:         b.model,
        year:          b.year         ? Number(b.year)    : undefined,
        color:         b.color,
        totalSeats:    b.totalSeats    ? Number(b.totalSeats)    : undefined,
        reservedSeats: b.reservedSeats ? Number(b.reservedSeats) : undefined,
        driverId:      b.driverId    ? Number(b.driverId)    : null,
        conductorId:   b.conductorId ? Number(b.conductorId) : null,
        status:        b.status        as any,
        gpsDeviceId:   b.gpsDeviceId,
        notes:         b.notes,
        isActive:      b.isActive,
      },
    });
    return rep.send({ vehicle });
  });

  // DOCUMENTS CRUD
  app.post(`${P}/:id/documents`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const vehicleId = Number((req.params as any).id);
    const b = req.body as any;
    const doc = await prisma.transportVehicleDoc.upsert({
      where: { id: b.docId ? Number(b.docId) : 0 },
      create: { vehicleId, docType: b.docType as any, docNumber: b.docNumber ?? null, issueDate: b.issueDate ? new Date(b.issueDate) : null, expiryDate: b.expiryDate ? new Date(b.expiryDate) : null, notes: b.notes ?? null },
      update: { docNumber: b.docNumber, issueDate: b.issueDate ? new Date(b.issueDate) : null, expiryDate: b.expiryDate ? new Date(b.expiryDate) : null, notes: b.notes },
    });
    return rep.code(201).send({ document: doc });
  });

  app.delete(`${P}/:id/documents/:docId`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const docId = Number((req.params as any).docId);
    await prisma.transportVehicleDoc.delete({ where: { id: docId } });
    return rep.send({ ok: true });
  });

  // LOCATION UPDATE (from GPS/mobile)
  app.post(`${P}/:id/location`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const now = new Date();
    await prisma.transportVehicle.update({ where: { id, schoolId }, data: { lastLatitude: Number(b.latitude), lastLongitude: Number(b.longitude), lastSpeed: b.speed ? Number(b.speed) : null, lastSeen: now } });
    // Log tracking point
    await prisma.transportTracking.create({ data: { vehicleId: id, tripId: b.tripId ? Number(b.tripId) : null, latitude: Number(b.latitude), longitude: Number(b.longitude), speed: b.speed ? Number(b.speed) : null, heading: b.heading ? Number(b.heading) : null, source: b.source ?? "MOBILE" } });
    return rep.send({ ok: true, timestamp: now });
  });

  // REPORTS
  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('transport.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const today   = new Date();
    const alert30 = new Date(today.getTime() + 30 * 86400000);
    const [byStatus, byType, expiring, expired] = await Promise.all([
      prisma.transportVehicle.groupBy({ by: ["status"],      where: { schoolId, isActive: true }, _count: { id: true } }),
      prisma.transportVehicle.groupBy({ by: ["vehicleType"], where: { schoolId, isActive: true }, _count: { id: true } }),
      prisma.transportVehicleDoc.count({ where: { vehicle: { schoolId }, expiryDate: { gte: today, lte: alert30 } } }),
      prisma.transportVehicleDoc.count({ where: { vehicle: { schoolId }, expiryDate: { lt: today } } }),
    ]);
    return rep.send({ byStatus, byType, expiringDocs: expiring, expiredDocs: expired });
  });
}
