// apps/api/src/routes/admin/inventory/inv-reports-analytics-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminInvReportsRoutes(app: FastifyInstance) {
  const P = "/admin/inventory/reports";

  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const items = await prisma.invItem.findMany({ where: { schoolId, isActive: true, purchasePrice: { not: null } }, select: { id: true, purchasePrice: true } });
    const stockAgg = await prisma.invStock.findMany({ where: { schoolId }, select: { itemId: true, quantity: true } });
    const stockMap: Record<number, number> = {};
    stockAgg.forEach(s => { stockMap[s.itemId] = (stockMap[s.itemId] ?? 0) + s.quantity; });
    const inventoryValue = items.reduce((sum, i) => sum + Number(i.purchasePrice ?? 0) * (stockMap[i.id] ?? 0), 0);
    const [assetsAssigned, maintenanceCost, lowStockCount, totalVendors] = await Promise.all([
      prisma.invAssetAssignment.count({ where: { schoolId, status: "ACTIVE" } }),
      prisma.invMaintenanceRequest.aggregate({ where: { schoolId, status: { in: ["RESOLVED","CLOSED"] } }, _sum: { actualCost: true } }),
      (async () => { const stocks = await prisma.invStock.findMany({ where: { schoolId }, include: { item: { select: { minimumLevel: true, isActive: true } } } }); return stocks.filter(s => s.item.isActive && s.item.minimumLevel > 0 && s.quantity <= s.item.minimumLevel).length; })(),
      prisma.invVendor.count({ where: { schoolId, status: "ACTIVE" } }),
    ]);
    return rep.send({ kpis: { inventoryValue, assetsAssigned, maintenanceCost: Number(maintenanceCost._sum.actualCost ?? 0), lowStockCount, totalVendors } });
  });

  app.get(`${P}/stock`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
    const to   = q.to   ? new Date(q.to)   : new Date();
    const [byType, topConsumed, stockMovement, lowStock] = await Promise.all([
      prisma.invTransaction.groupBy({ by: ["type"], where: { schoolId, txnDate: { gte: from, lte: to } }, _count: { id: true }, _sum: { quantity: true } }),
      prisma.invTransaction.groupBy({ by: ["itemId"], where: { schoolId, type: "STOCK_OUT", txnDate: { gte: from, lte: to } }, _sum: { quantity: true }, orderBy: { _sum: { quantity: "desc" } }, take: 10 }),
      prisma.invTransaction.groupBy({ by: ["type"], where: { schoolId, txnDate: { gte: from, lte: to } }, _count: { id: true } }),
      (async () => { const stocks = await prisma.invStock.findMany({ where: { schoolId }, include: { item: { select: { name: true, minimumLevel: true, isActive: true } } } }); return stocks.filter(s => s.item.isActive && s.item.minimumLevel > 0 && s.quantity <= s.item.minimumLevel); })(),
    ]);
    const ids   = topConsumed.map(t => t.itemId);
    const iMap  = Object.fromEntries((await prisma.invItem.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, itemCode: true } })).map(i => [i.id, i]));
    return rep.send({ byType, topConsumed: topConsumed.map(t => ({ ...t, item: iMap[t.itemId], qty: t._sum.quantity ?? 0 })), stockMovement, lowStockCount: lowStock.length, from, to });
  });

  app.get(`${P}/assets`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [byStatus, byCategory, totalValue, warrantyExpiring] = await Promise.all([
      prisma.invItem.groupBy({ by: ["assetStatus"], where: { schoolId, trackingType: "ASSET" }, _count: { id: true } }),
      prisma.invItem.groupBy({ by: ["categoryId"], where: { schoolId, trackingType: "ASSET" }, _count: { id: true }, orderBy: { _count: { id: "desc" } }, take: 8 }),
      prisma.invItem.aggregate({ where: { schoolId, trackingType: "ASSET", isActive: true }, _sum: { purchasePrice: true } }),
      prisma.invItem.count({ where: { schoolId, trackingType: "ASSET", isActive: true, warrantyUntil: { lt: new Date(Date.now() + 90 * 86400000), gt: new Date() } } }),
    ]);
    return rep.send({ byStatus, byCategory, totalValue: Number(totalValue._sum.purchasePrice ?? 0), warrantyExpiring });
  });

  app.get(`${P}/purchase`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 90 * 86400000);
    const to   = q.to   ? new Date(q.to)   : new Date();
    const [byStatus, byPriority, bySource, totalBudget] = await Promise.all([
      prisma.invPurchaseRequest.groupBy({ by: ["status"], where: { schoolId, createdAt: { gte: from, lte: to } }, _count: { id: true }, _sum: { actualCost: true } }),
      prisma.invPurchaseRequest.groupBy({ by: ["priority"], where: { schoolId, createdAt: { gte: from, lte: to } }, _count: { id: true } }),
      prisma.invPurchaseRequest.groupBy({ by: ["requestSource"], where: { schoolId, createdAt: { gte: from, lte: to } }, _count: { id: true }, orderBy: { _count: { id: "desc" } } }),
      prisma.invPurchaseRequest.aggregate({ where: { schoolId, status: { in: ["APPROVED","ORDERED","RECEIVED"] }, createdAt: { gte: from, lte: to } }, _sum: { approvedBudget: true, actualCost: true } }),
    ]);
    return rep.send({ byStatus, byPriority, bySource, totalBudget: Number(totalBudget._sum.approvedBudget ?? 0), totalSpent: Number(totalBudget._sum.actualCost ?? 0), from, to });
  });

  app.get(`${P}/vendor`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const topVendors = await prisma.invVendor.findMany({ where: { schoolId, status: "ACTIVE" }, orderBy: { totalPurchaseValue: "desc" }, take: 10, select: { id: true, name: true, totalOrders: true, totalPurchaseValue: true, overallRating: true, avgDeliveryDays: true } });
    return rep.send({ topVendors });
  });

  app.get(`${P}/maintenance`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [byType, byStatus, costAgg, monthlyTrend] = await Promise.all([
      prisma.invMaintenanceRequest.groupBy({ by: ["type"], where: { schoolId }, _count: { id: true }, _sum: { actualCost: true } }),
      prisma.invMaintenanceRequest.groupBy({ by: ["status"], where: { schoolId }, _count: { id: true } }),
      prisma.invMaintenanceRequest.aggregate({ where: { schoolId }, _sum: { estimatedCost: true, actualCost: true } }),
      Promise.all(Array.from({ length: 3 }, async (_, i) => {
        const mFrom = new Date(new Date().getFullYear(), new Date().getMonth() - (2 - i), 1);
        const mTo   = new Date(new Date().getFullYear(), new Date().getMonth() - (2 - i) + 1, 0);
        const [count, cost] = await Promise.all([
          prisma.invMaintenanceRequest.count({ where: { schoolId, reportedDate: { gte: mFrom, lte: mTo } } }),
          prisma.invMaintenanceRequest.aggregate({ where: { schoolId, resolvedDate: { gte: mFrom, lte: mTo } }, _sum: { actualCost: true } }),
        ]);
        return { month: mFrom.toLocaleString("default", { month: "short" }), count, cost: Number(cost._sum.actualCost ?? 0) };
      })),
    ]);
    return rep.send({ byType, byStatus, totalCost: Number(costAgg._sum.actualCost ?? 0), monthlyTrend });
  });

  app.get(`${P}/audit`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [byStatus, totalDiscrepancies, lastCompleted] = await Promise.all([
      prisma.invAudit.groupBy({ by: ["status"], where: { schoolId }, _count: { id: true } }),
      prisma.invAuditItem.count({ where: { audit: { schoolId }, discrepancyQty: { not: 0 } } }),
      prisma.invAudit.findFirst({ where: { schoolId, status: "COMPLETED" }, orderBy: { completedAt: "desc" } }),
    ]);
    return rep.send({ byStatus, totalDiscrepancies, lastCompleted });
  });

  app.post(`${P}/custom`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const from = b.from ? new Date(b.from) : new Date(Date.now() - 30 * 86400000);
    const to   = b.to   ? new Date(b.to)   : new Date();
    const where: any = { schoolId, txnDate: { gte: from, lte: to } };
    if (b.type)        where.type        = b.type;
    if (b.locationId)  where.OR = [{ fromLocationId: Number(b.locationId) }, { toLocationId: Number(b.locationId) }];
    if (b.categoryId) {
      const catItems = await prisma.invItem.findMany({ where: { schoolId, categoryId: Number(b.categoryId) }, select: { id: true } });
      where.itemId = { in: catItems.map(i => i.id) };
    }
    const transactions = await prisma.invTransaction.findMany({ where, include: { item: { select: { name: true, itemCode: true } }, fromLocation: { select: { name: true } }, toLocation: { select: { name: true } } }, orderBy: { txnDate: "desc" }, take: Number(b.limit ?? 200) });
    return rep.send({ transactions, total: transactions.length, from, to });
  });
}
