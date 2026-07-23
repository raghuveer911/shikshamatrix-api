// apps/api/src/routes/admin/inventory/inv-vendors-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminInvVendorsRoutes(app: FastifyInstance) {
  const P = "/admin/inventory/vendors";

  // Vendor Categories
  app.get(`${P}/categories`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const cats = await prisma.invVendorCategory.findMany({ where: { schoolId, isActive: true }, orderBy: { name: "asc" } });
    return rep.send({ categories: cats });
  });

  app.post(`${P}/categories`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { name } = req.body as any;
    const cat = await prisma.invVendorCategory.upsert({ where: { schoolId_name: { schoolId, name } }, create: { schoolId, name }, update: {} });
    return rep.code(201).send({ category: cat });
  });

  // Vendors
  app.get(P, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const where: any = { schoolId };
    if (q.status)     where.status     = q.status;
    if (q.categoryId) where.categoryId = Number(q.categoryId);
    if (q.preferred === "true") where.isPreferred = true;
    if (q.search) where.OR = [{ name: { contains: q.search, mode: "insensitive" } }, { vendorCode: { contains: q.search } }, { contactPerson: { contains: q.search, mode: "insensitive" } }];
    const [vendors, total] = await Promise.all([
      prisma.invVendor.findMany({ where, include: { category: { select: { name: true } }, _count: { select: { ratings: true, purchaseRequests: true } } }, orderBy: [{ isPreferred: "desc" }, { name: "asc" }], skip: (Number(q.page ?? 1) - 1) * 50, take: 50 }),
      prisma.invVendor.count({ where }),
    ]);
    return rep.send({ vendors, total });
  });

  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const vendor = await prisma.invVendor.findFirst({ where: { id, schoolId }, include: { category: { select: { name: true } }, ratings: { orderBy: { createdAt: "desc" }, take: 10 }, purchaseRequests: { orderBy: { createdAt: "desc" }, take: 5, select: { id: true, requestCode: true, title: true, status: true, actualCost: true, createdAt: true } } } });
    if (!vendor) return rep.code(404).send({ error: "Vendor not found" });
    return rep.send({ vendor });
  });

  app.post(P, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const settings = await prisma.invSettings.findUnique({ where: { schoolId } });
    const count = await prisma.invVendor.count({ where: { schoolId } });
    const code = `${settings?.vendorCodePrefix ?? "VEN"}-${String(count + 1).padStart(4, "0")}`;
    const vendor = await prisma.invVendor.create({ data: { schoolId, vendorCode: code, name: b.name, contactPerson: b.contactPerson ?? null, phone: b.phone ?? null, email: b.email ?? null, address: b.address ?? null, gstNumber: b.gstNumber ?? null, panNumber: b.panNumber ?? null, categoryId: b.categoryId ? Number(b.categoryId) : null, isPreferred: b.isPreferred ?? false, contractStart: b.contractStart ? new Date(b.contractStart) : null, contractEnd: b.contractEnd ? new Date(b.contractEnd) : null, warrantyTerms: b.warrantyTerms ?? null, notes: b.notes ?? null } });
    return rep.code(201).send({ vendor });
  });

  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const b = req.body as any;
    const vendor = await prisma.invVendor.update({ where: { id, schoolId }, data: { name: b.name, contactPerson: b.contactPerson, phone: b.phone, email: b.email, address: b.address, gstNumber: b.gstNumber, panNumber: b.panNumber, categoryId: b.categoryId ? Number(b.categoryId) : undefined, status: b.status as any, isPreferred: b.isPreferred, contractStart: b.contractStart ? new Date(b.contractStart) : undefined, contractEnd: b.contractEnd ? new Date(b.contractEnd) : undefined, warrantyTerms: b.warrantyTerms, notes: b.notes } });
    return rep.send({ vendor });
  });

  // Ratings
  app.post(`${P}/:id/rate`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const id = Number((req.params as any).id);
    const b = req.body as any;
    const rating = await prisma.invVendorRating.create({ data: { vendorId: id, rating: Number(b.rating), review: b.review ?? null, orderId: b.orderId ? Number(b.orderId) : null, ratedById: Number(userId) } });
    // Update vendor overall rating
    const agg = await prisma.invVendorRating.aggregate({ where: { vendorId: id }, _avg: { rating: true } });
    await prisma.invVendor.update({ where: { id }, data: { overallRating: agg._avg.rating ? Number(agg._avg.rating.toFixed(1)) : null } });
    return rep.code(201).send({ rating });
  });

  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [total, active, preferred, topVendors] = await Promise.all([
      prisma.invVendor.count({ where: { schoolId } }),
      prisma.invVendor.count({ where: { schoolId, status: "ACTIVE" } }),
      prisma.invVendor.count({ where: { schoolId, isPreferred: true } }),
      prisma.invVendor.findMany({ where: { schoolId }, orderBy: { totalPurchaseValue: "desc" }, take: 5, select: { id: true, name: true, totalOrders: true, totalPurchaseValue: true, overallRating: true } }),
    ]);
    return rep.send({ total, active, preferred, topVendors });
  });
}
