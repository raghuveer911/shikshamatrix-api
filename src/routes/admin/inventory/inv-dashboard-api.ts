// apps/api/src/routes/admin/inventory/inv-dashboard-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminInvDashboardRoutes(app: FastifyInstance) {
  const P = "/admin/inventory";

  // ─── MAIN DASHBOARD ───────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now   = new Date();
      const month = new Date(now.getFullYear(), now.getMonth(), 1);

      // KPI counts
      const [totalItems, lowStockCount, outOfStock, pendingRequests] = await Promise.all([
        prisma.invItem.count({ where: { schoolId, isActive: true } }),
        prisma.invStock.count({
          where: { schoolId, quantity: { gt: 0 }, item: { minimumLevel: { gt: 0 }, isActive: true }, AND: [{ quantity: { lte: prisma.invItem.fields.minimumLevel as any } }] },
        }).catch(async () => {
          // Fallback: manual low stock check
          const stocks = await prisma.invStock.findMany({
            where: { schoolId },
            include: { item: { select: { minimumLevel: true, isActive: true } } },
          });
          return stocks.filter(s => s.item.isActive && s.item.minimumLevel > 0 && s.quantity > 0 && s.quantity <= s.item.minimumLevel).length;
        }),
        prisma.invStock.count({ where: { schoolId, quantity: 0 } }),
        0, // placeholder — purchase requests come in next module
      ]);

      // Total available stock (sum across all locations)
      const totalStockAgg = await prisma.invStock.aggregate({ where: { schoolId }, _sum: { quantity: true } });
      const availableStock = Number(totalStockAgg._sum.quantity ?? 0);

      // Total inventory value
      const items = await prisma.invItem.findMany({ where: { schoolId, isActive: true, purchasePrice: { not: null } }, select: { id: true, purchasePrice: true } });
      const stockMap: Record<number, number> = {};
      const stockRows = await prisma.invStock.findMany({ where: { schoolId }, select: { itemId: true, quantity: true } });
      stockRows.forEach(s => { stockMap[s.itemId] = (stockMap[s.itemId] ?? 0) + s.quantity; });
      const totalValue = items.reduce((sum, item) => sum + (Number(item.purchasePrice ?? 0) * (stockMap[item.id] ?? 0)), 0);

      // Category distribution
      const categoryDist = await prisma.invItem.groupBy({
        by: ["categoryId"],
        where: { schoolId, isActive: true },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 8,
      });
      const catIds = categoryDist.map(c => c.categoryId).filter(Boolean) as number[];
      const cats   = await prisma.invCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true, color: true } });
      const catMap = Object.fromEntries(cats.map(c => [c.id, c]));

      // Asset status breakdown (assets only)
      const assetStatus = await prisma.invItem.groupBy({
        by: ["assetStatus"],
        where: { schoolId, trackingType: "ASSET", isActive: true },
        _count: { id: true },
      });

      // Low stock items
      const allStocks = await prisma.invStock.findMany({
        where: { schoolId },
        include: { item: { include: { category: { select: { name: true, color: true } } } } },
      });
      const lowStock = allStocks
        .filter(s => s.item.isActive && s.item.minimumLevel > 0 && s.quantity <= s.item.minimumLevel)
        .sort((a, b) => a.quantity - b.quantity)
        .slice(0, 8);

      // Monthly activity
      const [monthIn, monthOut, monthTransfer, monthAdj] = await Promise.all([
        prisma.invTransaction.aggregate({ where: { schoolId, type: "STOCK_IN",    txnDate: { gte: month } }, _sum: { quantity: true }, _count: { id: true } }),
        prisma.invTransaction.aggregate({ where: { schoolId, type: "STOCK_OUT",   txnDate: { gte: month } }, _sum: { quantity: true }, _count: { id: true } }),
        prisma.invTransaction.aggregate({ where: { schoolId, type: "TRANSFER",    txnDate: { gte: month } }, _count: { id: true } }),
        prisma.invTransaction.aggregate({ where: { schoolId, type: "ADJUSTMENT",  txnDate: { gte: month } }, _count: { id: true } }),
      ]);

      // Recent transactions
      const recent = await prisma.invTransaction.findMany({
        where: { schoolId },
        include: {
          item: { select: { name: true, itemCode: true } },
          toLocation: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
      });

      return rep.send({
        kpis: { totalItems, availableStock, lowStockCount, outOfStock, pendingRequests, totalValue },
        categoryDist: categoryDist.map(c => ({
          categoryId: c.categoryId,
          name:  c.categoryId ? catMap[c.categoryId]?.name  ?? "Uncategorized" : "Uncategorized",
          color: c.categoryId ? catMap[c.categoryId]?.color ?? "#9ca3af"       : "#9ca3af",
          count: c._count.id,
        })),
        assetStatus,
        lowStock,
        monthlyActivity: {
          in:       { count: monthIn._count.id,       qty: monthIn._sum.quantity  ?? 0 },
          out:      { count: monthOut._count.id,      qty: monthOut._sum.quantity ?? 0 },
          transfer: { count: monthTransfer._count.id },
          adjustment: { count: monthAdj._count.id },
        },
        recent,
      });
    }
  );

  // ─── QUICK STATS ──────────────────────────────────────────
  app.get(`${P}/quick-stats`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [total, consumable, asset] = await Promise.all([
        prisma.invItem.count({ where: { schoolId, isActive: true } }),
        prisma.invItem.count({ where: { schoolId, isActive: true, trackingType: "CONSUMABLE" } }),
        prisma.invItem.count({ where: { schoolId, isActive: true, trackingType: "ASSET" } }),
      ]);
      return rep.send({ total, consumable, asset });
    }
  );
}
