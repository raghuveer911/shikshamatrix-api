// apps/api/src/routes/admin/hostel/hostel-manage-hostels-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminManageHostelsRoutes(app: FastifyInstance) {
  const P = "/admin/hostel/hostels";

  // List
  app.get(P, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const where: any = { schoolId };
    if (q.type)   where.hostelType = q.type;
    if (q.status) where.status     = q.status;
    const hostels = await prisma.hostel.findMany({
      where,
      include: { warden: { include: { user: { select: { name: true, phone: true } } } }, _count: { select: { rooms: true, allocations: true } } },
      orderBy: { name: "asc" },
    });
    return rep.send({ hostels });
  });

  // Get one
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const hostel = await prisma.hostel.findFirst({
      where: { id, schoolId },
      include: {
        warden:  { include: { user: { select: { name: true, phone: true, email: true, avatarUrl: true } } } },
        floors:  { orderBy: { floorNo: "asc" }, include: { _count: { select: { rooms: true } } } },
        _count:  { select: { rooms: true, allocations: true } },
      },
    });
    if (!hostel) return rep.code(404).send({ error: "Hostel not found" });
    // Available staff for warden
    const wardens = await prisma.staff.findMany({ where: { schoolId, isActive: true }, include: { user: { select: { name: true, role: true } } }, take: 100 });
    return rep.send({ hostel, wardens });
  });

  // Create
  app.post(P, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const count = await prisma.hostel.count({ where: { schoolId } });
    const code  = b.hostelCode ?? `HST-${String(count + 1).padStart(3, "0")}`;
    const hostel = await prisma.hostel.create({
      data: {
        schoolId, hostelCode: code, name: b.name, hostelType: b.hostelType as any ?? "BOYS",
        status: b.status as any ?? "ACTIVE",
        phone: b.phone ?? null, email: b.email ?? null, address: b.address ?? null,
        city:  b.city  ?? null, state: b.state  ?? null,
        wardenId:    b.wardenId    ? Number(b.wardenId)    : null,
        facilities:  b.facilities  ?? [],
        description: b.description ?? null,
      },
    });
    // Create floors if provided
    if (b.floors && Array.isArray(b.floors)) {
      await prisma.hostelFloor.createMany({ data: b.floors.map((f: any, i: number) => ({ hostelId: hostel.id, floorNo: i, floorName: f })) });
    }
    return rep.code(201).send({ hostel });
  });

  // Update
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const hostel = await prisma.hostel.update({
      where: { id, schoolId },
      data: {
        name: b.name, hostelType: b.hostelType as any, status: b.status as any,
        phone: b.phone, email: b.email, address: b.address, city: b.city, state: b.state,
        wardenId: b.wardenId ? Number(b.wardenId) : null,
        facilities: b.facilities, description: b.description,
      },
    });
    return rep.send({ hostel });
  });

  // Add floor
  app.post(`${P}/:id/floors`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const hostelId = Number((req.params as any).id);
    const b = req.body as any;
    const maxFloor = await prisma.hostelFloor.findFirst({ where: { hostelId }, orderBy: { floorNo: "desc" } });
    const floor = await prisma.hostelFloor.create({ data: { hostelId, floorNo: (maxFloor?.floorNo ?? -1) + 1, floorName: b.floorName } });
    return rep.code(201).send({ floor });
  });

  // Report
  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const byType = await prisma.hostel.groupBy({ by: ["hostelType"], where: { schoolId }, _count: { id: true }, _sum: { totalBeds: true, occupiedBeds: true } });
    return rep.send({ byType });
  });
}
