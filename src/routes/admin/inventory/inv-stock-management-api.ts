// apps/api/src/routes/admin/inventory/inv-stock-management-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ── Update stock quantity helper ─────────────────────────────
async function updateStock(schoolId: number, itemId: number, locationId: number, delta: number): Promise<void> {
  await prisma.invStock.upsert({
    where: { itemId_locationId: { itemId, locationId } },
    create: { schoolId, itemId, locationId, quantity: Math.max(0, delta) },
    update: { quantity: { increment: delta } },
  });
}

// ── Next transaction code ─────────────────────────────────────
async function nextTxnCode(schoolId: number): Promise<string> {
  const count = await prisma.invTransaction.count({ where: { schoolId } });
  return `INV-TXN-${String(count + 1).padStart(5, "0")}`;
}

export async function adminInvStockMgmtRoutes(app: FastifyInstance) {
  const P = "/admin/inventory/stock";

  // ─── STOCK DASHBOARD ──────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

      const [monthIn, monthOut, monthTransfer, monthAdj] = await Promise.all([
        prisma.invTransaction.aggregate({ where: { schoolId, type: "STOCK_IN",   txnDate: { gte: month } }, _sum: { quantity: true }, _count: { id: true } }),
        prisma.invTransaction.aggregate({ where: { schoolId, type: "STOCK_OUT",  txnDate: { gte: month } }, _sum: { quantity: true }, _count: { id: true } }),
        prisma.invTransaction.count({ where: { schoolId, type: "TRANSFER",       txnDate: { gte: month } } }),
        prisma.invTransaction.count({ where: { schoolId, type: "ADJUSTMENT",     txnDate: { gte: month } } }),
      ]);

      return rep.send({
        kpis: {
          inCount:       monthIn._count.id,       inQty: monthIn._sum.quantity  ?? 0,
          outCount:      monthOut._count.id,      outQty: monthOut._sum.quantity ?? 0,
          transferCount: monthTransfer,
          adjCount:      monthAdj,
        },
      });
    }
  );

  // ─── STOCK IN ─────────────────────────────────────────────
  app.post(`${P}/in`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId }, select: { id: true } });
      const txnCode = await nextTxnCode(schoolId);

      // Get default location
      let locationId = b.locationId ? Number(b.locationId) : null;
      if (!locationId) {
        const defaultLoc = await prisma.invLocation.findFirst({ where: { schoolId, type: "STORE", isActive: true }, select: { id: true } });
        locationId = defaultLoc?.id ?? null;
      }
      if (!locationId) return rep.code(400).send({ error: "Provide locationId or create a STORE location first" });

      const txn = await prisma.invTransaction.create({
        data: {
          schoolId, txnCode,
          type:         "STOCK_IN",
          itemId:       Number(b.itemId),
          quantity:     Number(b.quantity),
          toLocationId: locationId,
          source:       b.source as any ?? "PURCHASE",
          supplierName: b.supplierName ?? null,
          purchasePrice: b.purchasePrice ? Number(b.purchasePrice) : null,
          invoiceNo:    b.invoiceNo    ?? null,
          notes:        b.notes        ?? null,
          referenceNo:  b.referenceNo  ?? null,
          txnDate:      b.txnDate ? new Date(b.txnDate) : new Date(),
          processedById: staff?.id ?? null,
        },
      });

      // Update stock
      await updateStock(schoolId, Number(b.itemId), locationId, Number(b.quantity));

      // Also update item purchase price if new
      if (b.purchasePrice) {
        await prisma.invItem.update({ where: { id: Number(b.itemId) }, data: { purchasePrice: Number(b.purchasePrice) } });
      }

      return rep.code(201).send({ transaction: txn });
    }
  );

  // ─── STOCK OUT ────────────────────────────────────────────
  app.post(`${P}/out`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      const itemId     = Number(b.itemId);
      const locationId = Number(b.locationId);
      const qty        = Number(b.quantity);

      // Check available stock
      const currentStock = await prisma.invStock.findUnique({ where: { itemId_locationId: { itemId, locationId } } });
      if (!currentStock || currentStock.quantity < qty) {
        return rep.code(409).send({ error: `Insufficient stock. Available: ${currentStock?.quantity ?? 0}` });
      }

      const staff    = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId }, select: { id: true } });
      const txnCode  = await nextTxnCode(schoolId);

      const txn = await prisma.invTransaction.create({
        data: {
          schoolId, txnCode,
          type:          "STOCK_OUT",
          itemId,
          quantity:      qty,
          fromLocationId: locationId,
          destination:   b.destination as any ?? "DEPARTMENT",
          issuedToStaffId: b.issuedToStaffId ? Number(b.issuedToStaffId) : null,
          purpose:       b.purpose        ?? null,
          departmentName: b.departmentName ?? null,
          notes:         b.notes          ?? null,
          referenceNo:   b.referenceNo    ?? null,
          txnDate:       b.txnDate ? new Date(b.txnDate) : new Date(),
          processedById: staff?.id ?? null,
        },
      });

      await updateStock(schoolId, itemId, locationId, -qty);

      // If asset: update assetStatus
      if (b.issuedToStaffId) {
        const item = await prisma.invItem.findFirst({ where: { id: itemId }, select: { trackingType: true } });
        if (item?.trackingType === "ASSET") {
          await prisma.invItem.update({ where: { id: itemId }, data: { assetStatus: "ASSIGNED" } });
        }
      }

      return rep.code(201).send({ transaction: txn });
    }
  );

  // ─── TRANSFER ─────────────────────────────────────────────
  app.post(`${P}/transfer`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      const itemId       = Number(b.itemId);
      const fromLocationId = Number(b.fromLocationId);
      const toLocationId   = Number(b.toLocationId);
      const qty            = Number(b.quantity);

      if (fromLocationId === toLocationId) return rep.code(400).send({ error: "Cannot transfer to same location" });

      const fromStock = await prisma.invStock.findUnique({ where: { itemId_locationId: { itemId, locationId: fromLocationId } } });
      if (!fromStock || fromStock.quantity < qty) {
        return rep.code(409).send({ error: `Insufficient stock at source. Available: ${fromStock?.quantity ?? 0}` });
      }

      const staff   = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId }, select: { id: true } });
      const txnCode = await nextTxnCode(schoolId);

      const txn = await prisma.invTransaction.create({
        data: {
          schoolId, txnCode,
          type:          "TRANSFER",
          itemId,
          quantity:      qty,
          fromLocationId,
          toLocationId,
          notes:         b.notes       ?? null,
          referenceNo:   b.referenceNo ?? null,
          txnDate:       b.txnDate ? new Date(b.txnDate) : new Date(),
          processedById: staff?.id ?? null,
        },
      });

      await updateStock(schoolId, itemId, fromLocationId, -qty);
      await updateStock(schoolId, itemId, toLocationId,   +qty);

      return rep.code(201).send({ transaction: txn });
    }
  );

  // ─── ADJUSTMENT ───────────────────────────────────────────
  app.post(`${P}/adjust`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      const itemId     = Number(b.itemId);
      const locationId = Number(b.locationId);
      const newQty     = Number(b.newQuantity);

      const currentStock = await prisma.invStock.findUnique({ where: { itemId_locationId: { itemId, locationId } } });
      const currentQty   = currentStock?.quantity ?? 0;
      const delta        = newQty - currentQty;

      const staff   = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId }, select: { id: true } });
      const txnCode = await nextTxnCode(schoolId);

      const txn = await prisma.invTransaction.create({
        data: {
          schoolId, txnCode,
          type:             "ADJUSTMENT",
          itemId,
          quantity:         Math.abs(delta),
          fromLocationId:   delta < 0 ? locationId : null,
          toLocationId:     delta > 0 ? locationId : null,
          adjustmentReason: b.reason as any ?? "AUDIT_CORRECTION",
          notes:            b.notes  ?? `Adjusted from ${currentQty} to ${newQty}`,
          txnDate:          b.txnDate ? new Date(b.txnDate) : new Date(),
          processedById:    staff?.id ?? null,
        },
      });

      // Set to exact new quantity
      await prisma.invStock.upsert({
        where: { itemId_locationId: { itemId, locationId } },
        create: { schoolId, itemId, locationId, quantity: newQty },
        update: { quantity: newQty },
      });

      return rep.code(201).send({ transaction: txn, delta, previousQty: currentQty, newQty });
    }
  );

  // ─── CURRENT STOCK (all items) ────────────────────────────
  app.get(`${P}/current`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId };
      if (q.locationId)   where.locationId   = Number(q.locationId);
      if (q.stockStatus === "OUT_OF_STOCK") where.quantity = 0;
      if (q.stockStatus === "LOW_STOCK")    where.quantity = { gt: 0 };

      const [stocks, total] = await Promise.all([
        prisma.invStock.findMany({
          where,
          include: {
            item:     { include: { category: { select: { name: true, color: true } }, unit: { select: { shortName: true } } } },
            location: { select: { name: true, type: true } },
          },
          orderBy: { item: { name: "asc" } },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.invStock.count({ where }),
      ]);

      // Enrich with stock status
      const enriched = stocks.map(s => {
        const status = s.quantity === 0 ? "OUT_OF_STOCK"
          : s.item.minimumLevel > 0 && s.quantity <= s.item.minimumLevel ? "LOW_STOCK"
          : "HEALTHY";
        return { ...s, stockStatus: status };
      });

      // Filter by stockStatus (post-enrichment)
      const filtered = q.stockStatus ? enriched.filter(s => s.stockStatus === q.stockStatus) : enriched;

      return rep.send({ stocks: filtered, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── STOCK BY ITEM (across all locations) ─────────────────
  app.get(`${P}/item/:itemId`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const itemId = Number((req.params as any).itemId);

      const [stocks, item, recentTxns] = await Promise.all([
        prisma.invStock.findMany({
          where: { itemId, schoolId },
          include: { location: { select: { name: true, type: true } } },
        }),
        prisma.invItem.findFirst({ where: { id: itemId, schoolId }, include: { unit: { select: { shortName: true } } } }),
        prisma.invTransaction.findMany({
          where: { itemId, schoolId },
          include: {
            toLocation:   { select: { name: true } },
            fromLocation: { select: { name: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
      ]);

      const totalQty = stocks.reduce((s, st) => s + st.quantity, 0);
      return rep.send({ item, stocks, totalQty, recentTxns });
    }
  );

  // ─── STOCK LEDGER (paginated history) ────────────────────
  app.get(`${P}/ledger`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId };
      if (q.itemId)      where.itemId      = Number(q.itemId);
      if (q.type)        where.type        = q.type;
      if (q.locationId)  where.OR = [{ fromLocationId: Number(q.locationId) }, { toLocationId: Number(q.locationId) }];
      if (q.from || q.to) {
        where.txnDate = {};
        if (q.from) where.txnDate.gte = new Date(q.from);
        if (q.to)   where.txnDate.lte = new Date(q.to);
      }

      const [txns, total] = await Promise.all([
        prisma.invTransaction.findMany({
          where,
          include: {
            item:          { select: { name: true, itemCode: true, unit: { select: { shortName: true } } } },
            toLocation:    { select: { name: true } },
            fromLocation:  { select: { name: true } },
            issuedToStaff: { include: { user: { select: { name: true } } } },
            processedBy:   { include: { user: { select: { name: true } } } },
          },
          orderBy: { txnDate: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.invTransaction.count({ where }),
      ]);

      return rep.send({ transactions: txns, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── LOW STOCK ALERTS ────────────────────────────────────
  app.get(`${P}/low-stock`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const stocks = await prisma.invStock.findMany({
        where: { schoolId },
        include: {
          item:     { include: { category: { select: { name: true, color: true } }, unit: { select: { shortName: true } } } },
          location: { select: { name: true } },
        },
        orderBy: { quantity: "asc" },
      });

      const lowStock = stocks.filter(s =>
        s.item.isActive && s.item.minimumLevel > 0 && s.quantity <= s.item.minimumLevel
      );
      const outOfStock = stocks.filter(s =>
        s.item.isActive && s.quantity === 0
      );

      return rep.send({ lowStock, outOfStock, totalAlerts: lowStock.length + outOfStock.length });
    }
  );

  // ─── REPORTS ─────────────────────────────────────────────
  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      const [byType, totalIn, totalOut, topConsumed] = await Promise.all([
        prisma.invTransaction.groupBy({
          by: ["type"],
          where: { schoolId, txnDate: { gte: from, lte: to } },
          _count: { id: true },
          _sum:   { quantity: true },
        }),
        prisma.invTransaction.aggregate({ where: { schoolId, type: "STOCK_IN",  txnDate: { gte: from, lte: to } }, _sum: { quantity: true } }),
        prisma.invTransaction.aggregate({ where: { schoolId, type: "STOCK_OUT", txnDate: { gte: from, lte: to } }, _sum: { quantity: true } }),
        prisma.invTransaction.groupBy({
          by: ["itemId"],
          where: { schoolId, type: "STOCK_OUT", txnDate: { gte: from, lte: to } },
          _sum: { quantity: true },
          orderBy: { _sum: { quantity: "desc" } },
          take: 10,
        }),
      ]);

      const topIds   = topConsumed.map(t => t.itemId);
      const topItems = await prisma.invItem.findMany({ where: { id: { in: topIds } }, select: { id: true, name: true, itemCode: true } });
      const topMap   = Object.fromEntries(topItems.map(i => [i.id, i]));

      return rep.send({
        byType,
        totalIn:  Number(totalIn._sum.quantity  ?? 0),
        totalOut: Number(totalOut._sum.quantity ?? 0),
        topConsumed: topConsumed.map(t => ({ ...t, item: topMap[t.itemId], qty: t._sum.quantity ?? 0 })),
        from, to,
      });
    }
  );
}
