import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";

export async function transportVehiclesRoutes(app: FastifyInstance) {

  // ── GET /transport/overview — Stats ─────────────────────────
  app.get("/transport/overview",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;

      const [vehicles, routes, activeVehicles] = await Promise.all([
        prisma.transportVehicle.count({ where: { schoolId, isActive: true } }),
        prisma.transportRoute.count({ where: { schoolId, isActive: true } }),
        prisma.transportVehicle.count({ where: { schoolId, status: "ACTIVE" } }),
      ]);

      // Total students on transport (sum of occupied seats)
      const seatAgg = await prisma.transportVehicle.aggregate({
        where: { schoolId, isActive: true },
        _sum:  { occupiedSeats: true, totalSeats: true },
      });

      return reply.send({
        success: true,
        data: {
          vehicles, routes, activeVehicles,
          studentsOnTransport: seatAgg._sum.occupiedSeats ?? 0,
          totalCapacity:       seatAgg._sum.totalSeats ?? 0,
        },
      });
    }
  );

  // ── GET /transport/vehicles — Vehicle list ──────────────────
  app.get("/transport/vehicles",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { search } = req.query as Record<string, string>;

      const where: any = {
        schoolId, isActive: true,
        ...(search ? {
          OR: [
            { vehicleNo:   { contains: search, mode: "insensitive" } },
            { vehicleName: { contains: search, mode: "insensitive" } },
          ],
        } : {}),
      };

      const vehicles = await prisma.transportVehicle.findMany({
        where,
        orderBy: { vehicleNo: "asc" },
        select: {
          id: true, vehicleNo: true, vehicleName: true, vehicleType: true,
          totalSeats: true, occupiedSeats: true, status: true,
          lastLatitude: true, lastLongitude: true, lastSeen: true, lastSpeed: true,
          driver: {
            select: {
              employeeId: true,
              user: { select: { name: true, phone: true } },
            },
          },
          routes: { select: { id: true, routeName: true }, take: 1 },
        },
      });

      return reply.send({
        success: true,
        data: {
          vehicles: vehicles.map((v) => ({
            id: v.id, vehicleNo: v.vehicleNo, vehicleName: v.vehicleName,
            vehicleType: v.vehicleType, status: v.status,
            totalSeats: v.totalSeats, occupiedSeats: v.occupiedSeats,
            availableSeats: v.totalSeats - v.occupiedSeats,
            driverName: v.driver?.user?.name ?? "Not assigned",
            driverPhone: v.driver?.user?.phone,
            routeName: v.routes[0]?.routeName ?? "No route",
            hasGps: !!v.lastLatitude,
            lastSeen: v.lastSeen,
          })),
        },
      });
    }
  );

  // ── GET /transport/vehicles/:id — Vehicle detail ────────────
  app.get("/transport/vehicles/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };

      const vehicle = await prisma.transportVehicle.findFirst({
        where: { id: parseInt(id), schoolId },
        select: {
          id: true, vehicleNo: true, vehicleName: true, vehicleType: true,
          brand: true, model: true, year: true, color: true,
          totalSeats: true, occupiedSeats: true, status: true,
          gpsDeviceId: true, lastLatitude: true, lastLongitude: true,
          lastSeen: true, lastSpeed: true, notes: true,
          driver: {
            select: {
              employeeId: true,
              user: { select: { name: true, phone: true } },
            },
          },
          conductor: {
            select: {
              employeeId: true,
              user: { select: { name: true, phone: true } },
            },
          },
          documents: {
            select: {
              id: true, docType: true, docNumber: true,
              issueDate: true, expiryDate: true,
            },
            orderBy: { expiryDate: "asc" },
          },
          routes: {
            select: {
              id: true, routeName: true, routeCode: true,
              morningStart: true, eveningStart: true,
              _count: { select: { stops: true } },
            },
          },
        },
      });

      if (!vehicle) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      // Check expiring documents
      const today = new Date();
      const docs = vehicle.documents.map((d) => ({
        ...d,
        isExpired: d.expiryDate ? new Date(d.expiryDate) < today : false,
        isExpiringSoon: d.expiryDate
          ? new Date(d.expiryDate) > today &&
            new Date(d.expiryDate) < new Date(today.getTime() + 30 * 86400000)
          : false,
      }));

      return reply.send({
        success: true,
        data: { vehicle: { ...vehicle, documents: docs } },
      });
    }
  );
}