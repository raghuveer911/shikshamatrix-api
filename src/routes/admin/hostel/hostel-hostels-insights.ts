// apps/api/src/routes/admin/hostel/hostel-hostels-insights.ts
// ─────────────────────────────────────────────────────────────
// Manage Hostel — the health layer on top of the existing, already
// solid hostel-manage-hostels-api.ts (list/get/create/update/add-
// floor/reports all untouched and still work).
//
//   GET  /admin/hostel/hostels/overview        → Layer 1 stat rail
//   POST /admin/hostel/hostels/:id/duplicate-setup
//        → copy one hostel's facilities + floor names onto a new
//          hostel, so setting up a second building doesn't mean
//          re-typing everything
//
// Register alongside adminManageHostelsRoutes.
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminHostelHostelsInsightRoutes(app: FastifyInstance) {
  const P = "/admin/hostel/hostels";
  const guard = { preHandler: [authenticate, requireCapability("hostel.core")] };

  // ── GET /admin/hostel/hostels/overview ───────────────────
  app.get(`${P}/overview`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;

    const hostels = await prisma.hostel.findMany({
      where: { schoolId, isActive: true },
      select: {
        id: true, hostelType: true, status: true, totalBeds: true, occupiedBeds: true, wardenId: true,
        facilities: true, _count: { select: { floors: true, rooms: true } },
      },
    });

    const totalBeds = hostels.reduce((s, h) => s + h.totalBeds, 0);
    const occupiedBeds = hostels.reduce((s, h) => s + h.occupiedBeds, 0);
    const withWarden = hostels.filter((h) => h.wardenId !== null).length;
    const byType: Record<string, number> = {};
    hostels.forEach((h) => { byType[h.hostelType] = (byType[h.hostelType] ?? 0) + 1; });
    const totalFacilities = new Set(hostels.flatMap((h) => h.facilities)).size;
    const noFloorsSet = hostels.filter((h) => h._count.floors === 0).length;
    const underMaintenance = hostels.filter((h) => h.status === "UNDER_MAINTENANCE").length;

    return rep.send({
      success: true,
      data: {
        totalHostels: hostels.length,
        totalBeds, occupiedBeds,
        occupancyPct: totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0,
        withWarden, withoutWarden: hostels.length - withWarden,
        byType: { BOYS: byType.BOYS ?? 0, GIRLS: byType.GIRLS ?? 0, MIXED: byType.MIXED ?? 0 },
        distinctFacilities: totalFacilities,
        noFloorsSet,
        underMaintenance,
      },
    });
  });

  // ── POST /admin/hostel/hostels/:id/duplicate-setup ───────
  // Copies facilities + floor names (not rooms/beds/residents) onto a
  // brand-new hostel — the tedious part of standing up a second
  // building, done once instead of re-typing the same facility list
  // and floor names by hand.
  app.post(`${P}/:id/duplicate-setup`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { id } = req.params as { id: string };
    const b = req.body as { name: string; hostelType?: string };

    if (!b.name?.trim()) return rep.status(400).send({ success: false, message: "Name the new hostel." });

    const source = await prisma.hostel.findFirst({
      where: { id: Number(id), schoolId },
      include: { floors: { orderBy: { floorNo: "asc" } } },
    });
    if (!source) return rep.status(404).send({ success: false, message: "Hostel not found." });

    const count = await prisma.hostel.count({ where: { schoolId } });
    const hostel = await prisma.hostel.create({
      data: {
        schoolId, hostelCode: `HST-${String(count + 1).padStart(3, "0")}`,
        name: b.name.trim(), hostelType: (b.hostelType as any) ?? source.hostelType,
        status: "ACTIVE", facilities: source.facilities, description: source.description,
      },
    });

    if (source.floors.length > 0) {
      await prisma.hostelFloor.createMany({
        data: source.floors.map((f) => ({ hostelId: hostel.id, floorNo: f.floorNo, floorName: f.floorName })),
      });
    }

    return rep.status(201).send({
      success: true,
      message: `"${hostel.name}" created with ${source.facilities.length} facilit${source.facilities.length === 1 ? "y" : "ies"} and ${source.floors.length} floor(s) copied from ${source.name}.`,
      data: { hostel },
    });
  });
}