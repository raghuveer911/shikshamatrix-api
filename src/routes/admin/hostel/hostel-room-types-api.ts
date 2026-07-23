// apps/api/src/routes/admin/hostel/hostel-room-types-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminRoomTypesRoutes(app: FastifyInstance) {
  const P = "/admin/hostel/room-types";

  app.get(P, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const types = await prisma.roomType.findMany({
      where: { schoolId, isActive: true },
      include: { _count: { select: { rooms: true } } },
      orderBy: { capacity: "asc" },
    });
    return rep.send({ roomTypes: types });
  });

  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const type = await prisma.roomType.findFirst({ where: { id, schoolId }, include: { _count: { select: { rooms: true } } } });
    if (!type) return rep.code(404).send({ error: "Room type not found" });
    return rep.send({ roomType: type });
  });

  app.post(P, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const type = await prisma.roomType.upsert({
      where: { schoolId_name: { schoolId, name: b.name } },
      create: { schoolId, name: b.name, capacity: Number(b.capacity), amenities: b.amenities ?? [], monthlyFee: b.monthlyFee ? Number(b.monthlyFee) : null, annualFee: b.annualFee ? Number(b.annualFee) : null, description: b.description ?? null },
      update: { capacity: Number(b.capacity), amenities: b.amenities, monthlyFee: b.monthlyFee ? Number(b.monthlyFee) : undefined, annualFee: b.annualFee ? Number(b.annualFee) : undefined, description: b.description },
    });
    return rep.code(201).send({ roomType: type });
  });

  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const type = await prisma.roomType.update({
      where: { id, schoolId },
      data: { name: b.name, capacity: b.capacity ? Number(b.capacity) : undefined, amenities: b.amenities, monthlyFee: b.monthlyFee ? Number(b.monthlyFee) : undefined, annualFee: b.annualFee ? Number(b.annualFee) : undefined, description: b.description, isActive: b.isActive },
    });
    return rep.send({ roomType: type });
  });

  app.delete(`${P}/:id`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const inUse = await prisma.hostelRoom.count({ where: { roomTypeId: id } });
    if (inUse > 0) return rep.code(409).send({ error: `Cannot delete — used by ${inUse} rooms` });
    await prisma.roomType.update({ where: { id, schoolId }, data: { isActive: false } });
    return rep.send({ ok: true });
  });

  // Seed defaults
  app.post(`${P}/seed-defaults`, { preHandler: [authenticate, requireCapability('hostel.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const defaults = [
      { name: "Single Bed",      capacity: 1, amenities: ["Study Table", "Attached Bathroom"] },
      { name: "Double Sharing",  capacity: 2, amenities: ["Study Table", "Non-AC"] },
      { name: "Triple Sharing",  capacity: 3, amenities: ["Non-AC"] },
      { name: "Dormitory",       capacity: 8, amenities: ["Non-AC"] },
    ];
    for (const d of defaults) {
      await prisma.roomType.upsert({ where: { schoolId_name: { schoolId, name: d.name } }, create: { schoolId, ...d }, update: {} });
    }
    return rep.send({ ok: true, message: "Default room types created" });
  });
}
