// apps/api/src/routes/admin/inventory/inv-stock-audits-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminInvStockAuditRoutes(app: FastifyInstance) {
  const P = "/admin/inventory/audits";

  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [total, inProgress, completed, discrepancyCount] = await Promise.all([
      prisma.invAudit.count({ where: { schoolId } }),
      prisma.invAudit.count({ where: { schoolId, status: "IN_PROGRESS" } }),
      prisma.invAudit.count({ where: { schoolId, status: "COMPLETED" } }),
      prisma.invAuditItem.count({ where: { audit: { schoolId }, discrepancyQty: { not: 0 } } }),
    ]);
    const recentAudits = await prisma.invAudit.findMany({ where: { schoolId }, include: { location: { select: { name: true } }, category: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 8 });
    return rep.send({ kpis: { total, inProgress, completed, discrepancyCount }, recentAudits });
  });

  app.get(P, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const where: any = { schoolId };
    if (q.status) where.status = q.status;
    const [audits, total] = await Promise.all([
      prisma.invAudit.findMany({ where, include: { location: { select: { name: true } }, category: { select: { name: true } }, _count: { select: { items: true } } }, orderBy: { createdAt: "desc" }, skip: (Number(q.page ?? 1) - 1) * 50, take: 50 }),
      prisma.invAudit.count({ where }),
    ]);
    return rep.send({ audits, total });
  });

  app.post(P, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const b = req.body as any;
    const settings = await prisma.invSettings.findUnique({ where: { schoolId } });
    const count = await prisma.invAudit.count({ where: { schoolId } });
    const code  = `${settings?.auditCodePrefix ?? "AUD"}-${String(count + 1).padStart(4, "0")}`;
    const audit = await prisma.invAudit.create({ data: { schoolId, auditCode: code, title: b.title, description: b.description ?? null, locationId: b.locationId ? Number(b.locationId) : null, categoryId: b.categoryId ? Number(b.categoryId) : null, conductedById: Number(userId) } });
    // Pre-populate items from current stock
    const stockWhere: any = { schoolId };
    if (b.locationId)  stockWhere.locationId  = Number(b.locationId);
    if (b.categoryId)  stockWhere.item = { categoryId: Number(b.categoryId) };
    const stocks = await prisma.invStock.findMany({ where: stockWhere, include: { item: { select: { isActive: true } } } });
    await prisma.invAuditItem.createMany({ data: stocks.filter(s => s.item.isActive).map(s => ({ auditId: audit.id, itemId: s.itemId, locationId: s.locationId, systemQty: s.quantity, physicalQty: 0, discrepancyQty: 0 })), skipDuplicates: true });
    await prisma.invAudit.update({ where: { id: audit.id }, data: { totalItems: stocks.filter(s => s.item.isActive).length } });
    return rep.code(201).send({ audit });
  });

  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const audit = await prisma.invAudit.findFirst({ where: { id, schoolId }, include: { items: { include: { item: { select: { name: true, itemCode: true, unit: { select: { shortName: true } } } }, location: { select: { name: true } } } }, location: { select: { name: true } }, category: { select: { name: true } } } });
    if (!audit) return rep.code(404).send({ error: "Audit not found" });
    return rep.send({ audit });
  });

  // Scan/verify an item
  app.post(`${P}/:id/verify`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const auditId = Number((req.params as any).id);
    const b = req.body as any;
    // Lookup by copy code or itemId
    let itemId = b.itemId ? Number(b.itemId) : null;
    if (!itemId && b.code) {
      const item = await prisma.invItem.findFirst({ where: { schoolId, OR: [{ itemCode: b.code }, { barcode: b.code }] }, select: { id: true } });
      itemId = item?.id ?? null;
    }
    if (!itemId) return rep.code(404).send({ error: "Item not found" });

    const physicalQty = Number(b.physicalQty ?? 0);
    const auditItem   = await prisma.invAuditItem.findFirst({ where: { auditId, itemId } });
    const systemQty   = auditItem?.systemQty ?? 0;
    const discrepancyQty = physicalQty - systemQty;
    const discrepancyType: any = discrepancyQty < 0 ? "MISSING" : discrepancyQty > 0 ? "EXTRA" : b.condition === "DAMAGED" ? "DAMAGED" : null;

    const updated = await prisma.invAuditItem.upsert({
      where: { auditId_itemId_locationId: { auditId, itemId, locationId: b.locationId ? Number(b.locationId) : 0 } },
      create: { auditId, itemId, locationId: b.locationId ? Number(b.locationId) : null, systemQty, physicalQty, discrepancyQty, discrepancyType, isVerified: true, notes: b.notes ?? null, checkedById: Number(userId) },
      update: { physicalQty, discrepancyQty, discrepancyType, isVerified: true, notes: b.notes ?? null, checkedAt: new Date(), checkedById: Number(userId) },
    });

    // Update audit verified count
    const verifiedCount = await prisma.invAuditItem.count({ where: { auditId, isVerified: true } });
    const discCount     = await prisma.invAuditItem.count({ where: { auditId, discrepancyQty: { not: 0 } } });
    await prisma.invAudit.update({ where: { id: auditId }, data: { verified: verifiedCount, discrepancies: discCount } });

    return rep.send({ auditItem: updated, discrepancyQty, discrepancyType });
  });

  app.post(`${P}/:id/complete`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const audit = await prisma.invAudit.update({ where: { id, schoolId }, data: { status: "COMPLETED", completedAt: new Date() } });
    return rep.send({ audit });
  });

  // Apply adjustments for discrepancies
  app.post(`${P}/:id/apply-adjustments`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const id = Number((req.params as any).id);
    const discrepancies = await prisma.invAuditItem.findMany({ where: { auditId: id, discrepancyQty: { not: 0 }, adjustmentApplied: false } });
    let adjusted = 0;
    for (const item of discrepancies) {
      if (!item.locationId) continue;
      await prisma.invStock.upsert({
        where: { itemId_locationId: { itemId: item.itemId, locationId: item.locationId } },
        create: { schoolId, itemId: item.itemId, locationId: item.locationId, quantity: Math.max(0, item.physicalQty) },
        update: { quantity: Math.max(0, item.physicalQty) },
      });
      const count = await prisma.invTransaction.count({ where: { schoolId } });
      await prisma.invTransaction.create({ data: { schoolId, txnCode: `INV-TXN-${String(count + 1).padStart(5, "0")}`, type: "ADJUSTMENT", itemId: item.itemId, quantity: Math.abs(item.discrepancyQty), fromLocationId: item.discrepancyQty < 0 ? item.locationId : null, toLocationId: item.discrepancyQty > 0 ? item.locationId : null, adjustmentReason: "AUDIT_CORRECTION", notes: `Audit ${id} adjustment`, txnDate: new Date() } });
      await prisma.invAuditItem.update({ where: { id: item.id }, data: { adjustmentApplied: true } });
      adjusted++;
    }
    return rep.send({ adjusted });
  });

  app.get(`${P}/:id/discrepancies`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const auditId = Number((req.params as any).id);
    const items = await prisma.invAuditItem.findMany({ where: { auditId, discrepancyQty: { not: 0 } }, include: { item: { select: { name: true, itemCode: true } }, location: { select: { name: true } } }, orderBy: { discrepancyQty: "asc" } });
    return rep.send({ items });
  });
}
