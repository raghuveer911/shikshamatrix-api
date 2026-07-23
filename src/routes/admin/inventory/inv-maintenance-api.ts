// apps/api/src/routes/admin/inventory/inv-maintenance-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminInvMaintenanceRoutes(app: FastifyInstance) {
  const P = "/admin/inventory/maintenance";

  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const today = new Date();
    const [open, inProgress, critical, amcsExpiring, scheduledSoon] = await Promise.all([
      prisma.invMaintenanceRequest.count({ where: { schoolId, status: "OPEN" } }),
      prisma.invMaintenanceRequest.count({ where: { schoolId, status: "IN_PROGRESS" } }),
      prisma.invMaintenanceRequest.count({ where: { schoolId, priority: "CRITICAL", status: { notIn: ["RESOLVED","CLOSED","CANCELLED"] } } }),
      prisma.invMaintenanceAMC.count({ where: { schoolId, isActive: true, endDate: { lt: new Date(today.getTime() + 30 * 86400000) } } }),
      prisma.invMaintenanceSchedule.count({ where: { schoolId, isActive: true, nextServiceDate: { lt: new Date(today.getTime() + 30 * 86400000) } } }),
    ]);
    const costAgg = await prisma.invMaintenanceRequest.aggregate({ where: { schoolId, status: { in: ["RESOLVED","CLOSED"] } }, _sum: { actualCost: true } });
    const recentRequests = await prisma.invMaintenanceRequest.findMany({ where: { schoolId }, include: { item: { select: { name: true, itemCode: true } }, vendor: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 8 });
    return rep.send({ kpis: { open, inProgress, critical, amcsExpiring, scheduledSoon, totalMaintenanceCost: Number(costAgg._sum.actualCost ?? 0) }, recentRequests });
  });

  // Service Requests
  app.get(`${P}/requests`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const where: any = { schoolId };
    if (q.status)   where.status   = q.status;
    if (q.type)     where.type     = q.type;
    if (q.priority) where.priority = q.priority;
    if (q.itemId)   where.itemId   = Number(q.itemId);
    const [requests, total] = await Promise.all([
      prisma.invMaintenanceRequest.findMany({ where, include: { item: { select: { name: true, itemCode: true, serialNumber: true } }, vendor: { select: { name: true } }, amc: { select: { title: true } } }, orderBy: [{ priority: "desc" }, { createdAt: "desc" }], skip: (Number(q.page ?? 1) - 1) * 50, take: 50 }),
      prisma.invMaintenanceRequest.count({ where }),
    ]);
    return rep.send({ requests, total });
  });

  app.post(`${P}/requests`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const b = req.body as any;
    const settings = await prisma.invSettings.findUnique({ where: { schoolId } });
    const count = await prisma.invMaintenanceRequest.count({ where: { schoolId } });
    const code  = `${settings?.maintenanceCodePrefix ?? "MNT"}-${String(count + 1).padStart(5, "0")}`;
    const req_  = await prisma.invMaintenanceRequest.create({
      data: { schoolId, requestCode: code, itemId: Number(b.itemId), type: b.type as any ?? "CORRECTIVE", priority: b.priority as any ?? "MEDIUM", problemTitle: b.problemTitle, description: b.description ?? null, vendorId: b.vendorId ? Number(b.vendorId) : null, reportedDate: new Date(b.reportedDate ?? new Date()), scheduledDate: b.scheduledDate ? new Date(b.scheduledDate) : null, estimatedCost: b.estimatedCost ? Number(b.estimatedCost) : null, reportedById: Number(userId), amcId: b.amcId ? Number(b.amcId) : null },
      include: { item: { select: { name: true } } },
    });
    await prisma.invItem.update({ where: { id: Number(b.itemId) }, data: { assetStatus: "UNDER_MAINTENANCE" } });
    return rep.code(201).send({ request: req_ });
  });

  app.put(`${P}/requests/:id`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const now = new Date();
    const data: any = { status: b.status as any, assignedTo: b.assignedTo, scheduledDate: b.scheduledDate ? new Date(b.scheduledDate) : undefined, vendorId: b.vendorId ? Number(b.vendorId) : undefined, estimatedCost: b.estimatedCost ? Number(b.estimatedCost) : undefined, actualCost: b.actualCost ? Number(b.actualCost) : undefined, resolutionNote: b.resolutionNote, partsReplaced: b.partsReplaced };
    if (b.status === "RESOLVED") { data.resolvedDate = now; }
    if (b.status === "CLOSED")   { data.closedDate   = now; }
    const req_ = await prisma.invMaintenanceRequest.update({ where: { id, schoolId }, data });
    if (b.status === "RESOLVED" || b.status === "CLOSED") {
      await prisma.invItem.update({ where: { id: req_.itemId }, data: { assetStatus: "AVAILABLE" } });
    }
    return rep.send({ request: req_ });
  });

  // AMC Management
  app.get(`${P}/amcs`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const amcs = await prisma.invMaintenanceAMC.findMany({ where: { schoolId, isActive: true }, include: { item: { select: { name: true, itemCode: true } }, vendor: { select: { name: true } }, _count: { select: { maintenanceRequests: true } } }, orderBy: { endDate: "asc" } });
    const today = new Date();
    return rep.send({ amcs: amcs.map(a => ({ ...a, daysRemaining: Math.ceil((new Date(a.endDate).getTime() - today.getTime()) / 86400000) })) });
  });

  app.post(`${P}/amcs`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const count = await prisma.invMaintenanceAMC.count({ where: { schoolId } });
    const code  = `AMC-${String(count + 1).padStart(4, "0")}`;
    const amc   = await prisma.invMaintenanceAMC.create({ data: { schoolId, amcCode: code, title: b.title, itemId: b.itemId ? Number(b.itemId) : null, vendorId: b.vendorId ? Number(b.vendorId) : null, startDate: new Date(b.startDate), endDate: new Date(b.endDate), renewalDate: b.renewalDate ? new Date(b.renewalDate) : null, contractValue: b.contractValue ? Number(b.contractValue) : null, serviceFrequencyMonths: b.serviceFrequencyMonths ? Number(b.serviceFrequencyMonths) : 6, terms: b.terms ?? null, notes: b.notes ?? null } });
    return rep.code(201).send({ amc });
  });

  // Schedules
  app.get(`${P}/schedules`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const schedules = await prisma.invMaintenanceSchedule.findMany({ where: { schoolId, isActive: true }, include: { item: { select: { name: true, itemCode: true } } }, orderBy: { nextServiceDate: "asc" } });
    const today = new Date();
    return rep.send({ schedules: schedules.map(s => ({ ...s, isDue: s.nextServiceDate ? s.nextServiceDate <= today : false, daysUntilDue: s.nextServiceDate ? Math.ceil((new Date(s.nextServiceDate).getTime() - today.getTime()) / 86400000) : null })) });
  });

  app.post(`${P}/schedules`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const schedule = await prisma.invMaintenanceSchedule.create({ data: { schoolId, itemId: Number(b.itemId), title: b.title, type: b.type as any ?? "PREVENTIVE", frequencyDays: Number(b.frequencyDays ?? 180), lastServiceDate: b.lastServiceDate ? new Date(b.lastServiceDate) : null, nextServiceDate: b.nextServiceDate ? new Date(b.nextServiceDate) : null, vendorId: b.vendorId ? Number(b.vendorId) : null, estimatedCost: b.estimatedCost ? Number(b.estimatedCost) : null, notes: b.notes ?? null } });
    return rep.code(201).send({ schedule });
  });

  app.get(`${P}/warranty-tracking`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const today = new Date();
    const settings = await prisma.invSettings.findUnique({ where: { schoolId } });
    const alertDays = settings?.warrantyAlertDays ?? 30;
    const items = await prisma.invItem.findMany({ where: { schoolId, trackingType: "ASSET", isActive: true, warrantyUntil: { not: null } }, include: { category: { select: { name: true } } }, orderBy: { warrantyUntil: "asc" } });
    const enriched = items.map(i => {
      const days = i.warrantyUntil ? Math.ceil((new Date(i.warrantyUntil).getTime() - today.getTime()) / 86400000) : null;
      return { ...i, daysRemaining: days, isExpired: days != null && days < 0, isExpiringSoon: days != null && days >= 0 && days <= alertDays };
    });
    return rep.send({ items: enriched, expired: enriched.filter(i => i.isExpired).length, expiringSoon: enriched.filter(i => i.isExpiringSoon).length });
  });

  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [byStatus, byType, costAgg] = await Promise.all([
      prisma.invMaintenanceRequest.groupBy({ by: ["status"], where: { schoolId }, _count: { id: true } }),
      prisma.invMaintenanceRequest.groupBy({ by: ["type"], where: { schoolId }, _count: { id: true }, _sum: { actualCost: true } }),
      prisma.invMaintenanceRequest.aggregate({ where: { schoolId }, _sum: { estimatedCost: true, actualCost: true } }),
    ]);
    return rep.send({ byStatus, byType, totalCost: Number(costAgg._sum.actualCost ?? 0), totalEstimated: Number(costAgg._sum.estimatedCost ?? 0) });
  });
}
