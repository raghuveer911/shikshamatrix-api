import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";

export async function transportRoutesRoutes(app: FastifyInstance) {

  // ── GET /transport/routes — Routes list ─────────────────────
  app.get("/transport/routes",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { search } = req.query as Record<string, string>;

      const where: any = {
        schoolId, isActive: true,
        ...(search ? {
          OR: [
            { routeName: { contains: search, mode: "insensitive" } },
            { routeCode: { contains: search, mode: "insensitive" } },
          ],
        } : {}),
      };

      const routes = await prisma.transportRoute.findMany({
        where,
        orderBy: { routeName: "asc" },
        select: {
          id: true, routeName: true, routeCode: true, status: true,
          morningStart: true, eveningStart: true, coverageArea: true,
          totalSeats: true, occupiedSeats: true,
          vehicle: {
            select: {
              vehicleNo: true, vehicleName: true,
              driver: { select: { user: { select: { name: true } } } },
            },
          },
          _count: { select: { stops: true } },
        },
      });

      return reply.send({
        success: true,
        data: {
          routes: routes.map((r) => ({
            id: r.id, routeName: r.routeName, routeCode: r.routeCode,
            status: r.status, morningStart: r.morningStart,
            eveningStart: r.eveningStart, coverageArea: r.coverageArea,
            totalSeats: r.totalSeats, occupiedSeats: r.occupiedSeats,
            stopCount: r._count.stops,
            vehicleNo: r.vehicle?.vehicleNo ?? "No vehicle",
            driverName: r.vehicle?.driver?.user?.name ?? "—",
          })),
        },
      });
    }
  );

  // ── GET /transport/routes/:id — Route detail + stops ────────
  app.get("/transport/routes/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };

      const route = await prisma.transportRoute.findFirst({
        where: { id: parseInt(id), schoolId },
        select: {
          id: true, routeName: true, routeCode: true, description: true,
          status: true, morningStart: true, eveningStart: true,
          estimatedDuration: true, coverageArea: true,
          totalSeats: true, occupiedSeats: true,
          vehicle: {
            select: {
              id: true, vehicleNo: true, vehicleName: true,
              driver: { select: { user: { select: { name: true, phone: true } } } },
            },
          },
          stops: {
            orderBy: { sequence: "asc" },
            select: {
              id: true, stopName: true, landmark: true, sequence: true,
              latitude: true, longitude: true,
              pickupTime: true, dropTime: true, studentCount: true,
            },
          },
        },
      });

      if (!route) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      return reply.send({ success: true, data: { route } });
    }
  );

  // ── GET /transport/vehicles/:id/track — Last location ───────
  app.get("/transport/vehicles/:id/track",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };

      const vehicle = await prisma.transportVehicle.findFirst({
        where: { id: parseInt(id), schoolId },
        select: {
          id: true, vehicleNo: true, vehicleName: true,
          lastLatitude: true, lastLongitude: true,
          lastSeen: true, lastSpeed: true, status: true,
          driver: { select: { user: { select: { name: true, phone: true } } } },
        },
      });

      if (!vehicle) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      // Recent tracking points
      const tracking = await prisma.transportTracking.findMany({
        where: { vehicleId: parseInt(id) },
        orderBy: { timestamp: "desc" },
        take: 20,
        select: { latitude: true, longitude: true, speed: true, timestamp: true },
      });

      return reply.send({
        success: true,
        data: {
          vehicle: {
            id: vehicle.id, vehicleNo: vehicle.vehicleNo,
            vehicleName: vehicle.vehicleName, status: vehicle.status,
            driverName: vehicle.driver?.user?.name,
            driverPhone: vehicle.driver?.user?.phone,
            lastLatitude: vehicle.lastLatitude,
            lastLongitude: vehicle.lastLongitude,
            lastSeen: vehicle.lastSeen,
            lastSpeed: vehicle.lastSpeed,
            hasGps: !!vehicle.lastLatitude,
          },
          tracking,
        },
      });
    }
  );
}