// apps/api/src/routes/admin/transport/transport-dashboard-api.ts
// Pure TypeScript — NO JSX, NO className
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminTransportDashboardRoutes(app: FastifyInstance) {
  const P = "/admin/transport";

  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('transport.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const today = new Date();
      const alertDays = today;
      const alert30   = new Date(today.getTime() + 30 * 86400000);

      const [totalVehicles, activeVehicles, maintenanceVehicles,
             totalRoutes, activeRoutes, totalTripsToday, driversCount] = await Promise.all([
        prisma.transportVehicle.count({ where: { schoolId, isActive: true } }),
        prisma.transportVehicle.count({ where: { schoolId, isActive: true, status: "ACTIVE" } }),
        prisma.transportVehicle.count({ where: { schoolId, isActive: true, status: "MAINTENANCE" } }),
        prisma.transportRoute.count({ where: { schoolId, isActive: true } }),
        prisma.transportRoute.count({ where: { schoolId, isActive: true, status: "ACTIVE" } }),
        prisma.transportTrip.count({ where: { schoolId, tripDate: { gte: new Date(today.getFullYear(), today.getMonth(), today.getDate()), lt: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1) } } }),
        prisma.transportVehicle.count({ where: { schoolId, isActive: true, driverId: { not: null } } }),
      ]);

      // Vehicles currently on route (IN_PROGRESS trip today)
      const vehiclesOnRoute = await prisma.transportTrip.count({ where: { schoolId, status: "IN_PROGRESS", tripDate: { gte: new Date(today.getFullYear(), today.getMonth(), today.getDate()) } } });

      // Route occupancy
      const routeOccupancy = await prisma.transportRoute.findMany({
        where: { schoolId, isActive: true, status: "ACTIVE" },
        select: { id: true, routeName: true, routeCode: true, totalSeats: true, occupiedSeats: true, vehicle: { select: { vehicleNo: true } } },
        orderBy: { routeName: "asc" },
        take: 10,
      });

      // Vehicle status breakdown
      const vehicleByStatus = await prisma.transportVehicle.groupBy({ by: ["status"], where: { schoolId, isActive: true }, _count: { id: true } });

      // Expiring documents (within 30 days)
      const expiringDocs = await prisma.transportVehicleDoc.findMany({
        where: { vehicle: { schoolId, isActive: true }, expiryDate: { gte: today, lte: alert30 } },
        include: { vehicle: { select: { vehicleNo: true, vehicleName: true } } },
        orderBy: { expiryDate: "asc" },
        take: 8,
      });

      // Expired documents
      const expiredDocs = await prisma.transportVehicleDoc.count({ where: { vehicle: { schoolId, isActive: true }, expiryDate: { lt: today } } });

      // Recent activities (latest 8 trips)
      const recentTrips = await prisma.transportTrip.findMany({
        where: { schoolId },
        include: { vehicle: { select: { vehicleNo: true, vehicleName: true } }, route: { select: { routeName: true } }, driver: { include: { user: { select: { name: true } } } } },
        orderBy: { createdAt: "desc" },
        take: 8,
      });

      // Routes with full capacity
      const fullRoutes = routeOccupancy.filter(r => r.totalSeats > 0 && r.occupiedSeats >= r.totalSeats).length;

      return rep.send({
        kpis: { totalVehicles, activeVehicles, maintenanceVehicles, totalRoutes, activeRoutes, vehiclesOnRoute, driversCount, expiredDocs, fullRoutes },
        vehicleByStatus,
        routeOccupancy: routeOccupancy.map(r => ({
          ...r,
          pct: r.totalSeats > 0 ? Math.round((r.occupiedSeats / r.totalSeats) * 100) : 0,
          availSeats: Math.max(0, r.totalSeats - r.occupiedSeats),
        })),
        expiringDocs,
        recentTrips,
      });
    }
  );
}
