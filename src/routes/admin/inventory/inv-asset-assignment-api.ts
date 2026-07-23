// apps/api/src/routes/admin/inventory/inv-asset-assignment-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminInvAssetAssignmentRoutes(app: FastifyInstance) {
  const P = "/admin/inventory/assets";

  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [totalAssets, assigned, available, underMaintenance, lost] = await Promise.all([
      prisma.invItem.count({ where: { schoolId, trackingType: "ASSET", isActive: true } }),
      prisma.invAssetAssignment.count({ where: { schoolId, status: "ACTIVE" } }),
      prisma.invItem.count({ where: { schoolId, trackingType: "ASSET", assetStatus: "AVAILABLE" } }),
      prisma.invItem.count({ where: { schoolId, trackingType: "ASSET", assetStatus: "UNDER_MAINTENANCE" } }),
      prisma.invItem.count({ where: { schoolId, trackingType: "ASSET", assetStatus: "LOST" } }),
    ]);
    const recentAssignments = await prisma.invAssetAssignment.findMany({ where: { schoolId }, include: { item: { select: { name: true, itemCode: true } }, staff: { include: { user: { select: { name: true } } } }, location: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 8 });
    return rep.send({ kpis: { totalAssets, assigned, available, underMaintenance, lost }, recentAssignments });
  });

  app.get(`${P}/directory`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const where: any = { schoolId, trackingType: "ASSET", isActive: true };
    if (q.assetStatus) where.assetStatus = q.assetStatus;
    if (q.categoryId)  where.categoryId  = Number(q.categoryId);
    if (q.search)      where.OR = [{ name: { contains: q.search, mode: "insensitive" } }, { itemCode: { contains: q.search } }, { serialNumber: { contains: q.search } }, { assetTag: { contains: q.search } }];
    const [assets, total] = await Promise.all([
      prisma.invItem.findMany({ where, include: { category: { select: { name: true, color: true } }, brand: { select: { name: true } }, assignments: { where: { status: "ACTIVE" }, take: 1, include: { staff: { include: { user: { select: { name: true } } } }, location: { select: { name: true } } } } }, orderBy: { name: "asc" }, skip: (Number(q.page ?? 1) - 1) * 50, take: 50 }),
      prisma.invItem.count({ where }),
    ]);
    return rep.send({ assets, total });
  });

  app.post(`${P}/assign`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const b = req.body as any;
    const settings = await prisma.invSettings.findUnique({ where: { schoolId } });
    const count = await prisma.invAssetAssignment.count({ where: { schoolId } });
    const code = `ASN-${String(count + 1).padStart(5, "0")}`;
    const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId }, select: { id: true } });
    const assignment = await prisma.invAssetAssignment.create({
      data: { schoolId, itemId: Number(b.itemId), assignmentCode: code, staffId: b.staffId ? Number(b.staffId) : null, departmentName: b.departmentName ?? null, locationId: b.locationId ? Number(b.locationId) : null, issueDate: new Date(b.issueDate ?? new Date()), expectedReturnDate: b.expectedReturnDate ? new Date(b.expectedReturnDate) : null, remarks: b.remarks ?? null, assignedById: staff?.id ?? null },
      include: { item: { select: { name: true } }, staff: { include: { user: { select: { name: true } } } } },
    });
    await prisma.invItem.update({ where: { id: Number(b.itemId) }, data: { assetStatus: "ASSIGNED" } });
    return rep.code(201).send({ assignment });
  });

  app.post(`${P}/return/:assignmentId`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const id = Number((req.params as any).assignmentId);
    const b = req.body as any;
    const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId }, select: { id: true } });
    const assignment = await prisma.invAssetAssignment.update({ where: { id, schoolId }, data: { status: "RETURNED", actualReturnDate: new Date(), returnNotes: b.notes ?? null, returnedById: staff?.id ?? null } });
    await prisma.invItem.update({ where: { id: assignment.itemId }, data: { assetStatus: b.condition === "DAMAGED" ? "DAMAGED" : "AVAILABLE" } });
    return rep.send({ assignment });
  });

  app.post(`${P}/transfer`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const b = req.body as any;
    // Mark old assignment returned
    const existingAssignment = await prisma.invAssetAssignment.findFirst({ where: { itemId: Number(b.itemId), schoolId, status: "ACTIVE" } });
    if (existingAssignment) {
      await prisma.invAssetAssignment.update({ where: { id: existingAssignment.id }, data: { status: "TRANSFERRED" } });
    }
    const transfer = await prisma.invAssetTransfer.create({ data: { schoolId, itemId: Number(b.itemId), fromStaffId: b.fromStaffId ? Number(b.fromStaffId) : null, fromDept: b.fromDept ?? null, toStaffId: b.toStaffId ? Number(b.toStaffId) : null, toDept: b.toDept ?? null, transferDate: new Date(b.transferDate ?? new Date()), reason: b.reason ?? null } });
    // Create new assignment
    const count = await prisma.invAssetAssignment.count({ where: { schoolId } });
    const code  = `ASN-${String(count + 1).padStart(5, "0")}`;
    const newAssignment = await prisma.invAssetAssignment.create({ data: { schoolId, itemId: Number(b.itemId), assignmentCode: code, staffId: b.toStaffId ? Number(b.toStaffId) : null, departmentName: b.toDept ?? null, issueDate: new Date(), status: "ACTIVE" } });
    return rep.code(201).send({ transfer, newAssignment });
  });

  app.get(`${P}/history/:itemId`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const itemId = Number((req.params as any).itemId);
    const [assignments, transfers] = await Promise.all([
      prisma.invAssetAssignment.findMany({ where: { itemId, schoolId }, include: { staff: { include: { user: { select: { name: true } } } }, location: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
      prisma.invAssetTransfer.findMany({ where: { itemId, schoolId }, include: { fromStaff: { include: { user: { select: { name: true } } } }, toStaff: { include: { user: { select: { name: true } } } } }, orderBy: { createdAt: "desc" } }),
    ]);
    return rep.send({ assignments, transfers });
  });

  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const byStatus = await prisma.invItem.groupBy({ by: ["assetStatus"], where: { schoolId, trackingType: "ASSET" }, _count: { id: true } });
    const byCategory = await prisma.invItem.groupBy({ by: ["categoryId"], where: { schoolId, trackingType: "ASSET" }, _count: { id: true }, orderBy: { _count: { id: "desc" } }, take: 8 });
    return rep.send({ byStatus, byCategory });
  });
}
