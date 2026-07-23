import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { requireCapability } from "../../middleware/checkCapability.js";
import { stockIn, stockOut, InventoryError } from "../../services/inventory-stock.service.js";

export async function staffInventoryRoutes(app: FastifyInstance) {
  const P = "/staff/inventory";

  // ── GET /staff/inventory/overview ───────────────────────
  app.get(`${P}/overview`, { preHandler: [appAuth, requireCapability("inventory.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;

      const [totalItems, stocks] = await Promise.all([
        prisma.invItem.count({ where: { schoolId, isActive: true } }),
        prisma.invStock.findMany({ where: { schoolId }, include: { item: { select: { isActive: true, minimumLevel: true } } } }),
      ]);

      const lowStockCount = stocks.filter((s) => s.item.isActive && s.item.minimumLevel > 0 && s.quantity <= s.item.minimumLevel).length;
      const outOfStockCount = stocks.filter((s) => s.item.isActive && s.quantity === 0).length;

      return reply.send({ success: true, data: { totalItems, lowStockCount, outOfStockCount } });
    }
  );

  // ── GET /staff/inventory/items?search= ──────────────────
  app.get(`${P}/items`, { preHandler: [appAuth, requireCapability("inventory.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = req.query as any;
      const page = Number(q.page ?? 1);
      const limit = Number(q.limit ?? 30);

      const where: any = { schoolId, isActive: true };
      if (q.categoryId) where.categoryId = Number(q.categoryId);
      if (q.search) {
        where.OR = [
          { name: { contains: q.search, mode: "insensitive" } },
          { itemCode: { contains: q.search, mode: "insensitive" } },
          { barcode: { contains: q.search, mode: "insensitive" } },
        ];
      }

      const [items, total] = await Promise.all([
        prisma.invItem.findMany({
          where, orderBy: { name: "asc" }, skip: (page - 1) * limit, take: limit,
          include: { category: { select: { name: true, color: true } }, unit: { select: { name: true, shortName: true } } },
        }),
        prisma.invItem.count({ where }),
      ]);

      const enriched = await Promise.all(items.map(async (item) => {
        const stockAgg = await prisma.invStock.aggregate({ where: { itemId: item.id }, _sum: { quantity: true } });
        const totalQty = Number(stockAgg._sum.quantity ?? 0);
        const stockStatus = totalQty === 0 ? "OUT_OF_STOCK" : item.minimumLevel > 0 && totalQty <= item.minimumLevel ? "LOW_STOCK" : "HEALTHY";
        return { ...item, totalQty, stockStatus };
      }));

      return reply.send({ success: true, data: { items: enriched, total, pages: Math.ceil(total / limit) } });
    }
  );

  // ── GET /staff/inventory/items/:id ───────────────────────
  app.get(`${P}/items/:id`, { preHandler: [appAuth, requireCapability("inventory.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };

      const item = await prisma.invItem.findFirst({
        where: { id: Number(id), schoolId },
        include: {
          category: { select: { name: true, color: true } }, unit: { select: { name: true, shortName: true } },
          stocks: { include: { location: { select: { name: true, type: true } } } },
        },
      });
      if (!item) return reply.status(404).send({ success: false, message: "Item not found." });

      const recentTxns = await prisma.invTransaction.findMany({
        where: { itemId: Number(id), schoolId }, orderBy: { createdAt: "desc" }, take: 10,
        include: { toLocation: { select: { name: true } }, fromLocation: { select: { name: true } }, issuedToStaff: { include: { user: { select: { name: true } } } } },
      });

      return reply.send({ success: true, data: { item, recentTxns } });
    }
  );

  // ── GET /staff/inventory/locations ───────────────────────
  app.get(`${P}/locations`, { preHandler: [appAuth, requireCapability("inventory.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const locations = await prisma.invLocation.findMany({ where: { schoolId, isActive: true }, orderBy: { name: "asc" } });
      return reply.send({ success: true, data: { locations } });
    }
  );

  // ── POST /staff/inventory/stock-in ───────────────────────
  app.post(`${P}/stock-in`, { preHandler: [appAuth, requireCapability("inventory.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const b = req.body as any;
      if (!b.itemId || !b.quantity) return reply.status(400).send({ success: false, message: "itemId and quantity are required." });
      try {
        const txn = await stockIn(schoolId, staffId ?? null, {
          itemId: Number(b.itemId), quantity: Number(b.quantity), locationId: b.locationId ? Number(b.locationId) : undefined,
          source: b.source, supplierName: b.supplierName, purchasePrice: b.purchasePrice ? Number(b.purchasePrice) : undefined,
          invoiceNo: b.invoiceNo, notes: b.notes,
        });
        return reply.status(201).send({ success: true, message: "Stock added successfully.", data: { transaction: txn } });
      } catch (err) {
        if (err instanceof InventoryError) return reply.status(err.status).send({ success: false, message: err.message });
        console.error("[staff/inventory] stock-in failed:", err);
        return reply.status(500).send({ success: false, message: "Couldn't add stock. Please try again." });
      }
    }
  );

  // ── POST /staff/inventory/stock-out ──────────────────────
  app.post(`${P}/stock-out`, { preHandler: [appAuth, requireCapability("inventory.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const b = req.body as any;
      if (!b.itemId || !b.locationId || !b.quantity) return reply.status(400).send({ success: false, message: "itemId, locationId and quantity are required." });
      try {
        const txn = await stockOut(schoolId, staffId ?? null, {
          itemId: Number(b.itemId), locationId: Number(b.locationId), quantity: Number(b.quantity),
          destination: b.destination, issuedToStaffId: b.issuedToStaffId ? Number(b.issuedToStaffId) : undefined,
          purpose: b.purpose, departmentName: b.departmentName, notes: b.notes,
        });
        return reply.status(201).send({ success: true, message: "Stock issued successfully.", data: { transaction: txn } });
      } catch (err) {
        if (err instanceof InventoryError) return reply.status(err.status).send({ success: false, message: err.message });
        console.error("[staff/inventory] stock-out failed:", err);
        return reply.status(500).send({ success: false, message: "Couldn't issue stock. Please try again." });
      }
    }
  );

  // ── GET /staff/inventory/transactions ────────────────────
  app.get(`${P}/transactions`, { preHandler: [appAuth, requireCapability("inventory.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = req.query as { page?: string; type?: string; search?: string };
      const page = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 30;

      const where: any = { schoolId };
      if (q.type) where.type = q.type;
      if (q.search) {
        where.OR = [
          { txnCode: { contains: q.search, mode: "insensitive" } },
          { item: { name: { contains: q.search, mode: "insensitive" } } },
        ];
      }

      const [txns, total] = await Promise.all([
        prisma.invTransaction.findMany({
          where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit,
          include: { item: { select: { name: true, itemCode: true } }, toLocation: { select: { name: true } }, fromLocation: { select: { name: true } } },
        }),
        prisma.invTransaction.count({ where }),
      ]);

      return reply.send({ success: true, data: { transactions: txns, total, pages: Math.ceil(total / limit) } });
    }
  );

  // ── GET /staff/inventory/low-stock ───────────────────────
  app.get(`${P}/low-stock`, { preHandler: [appAuth, requireCapability("inventory.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const stocks = await prisma.invStock.findMany({
        where: { schoolId },
        include: { item: { include: { category: { select: { name: true, color: true } }, unit: { select: { shortName: true } } } }, location: { select: { name: true } } },
        orderBy: { quantity: "asc" },
      });
      const lowStock = stocks.filter((s) => s.item.isActive && s.item.minimumLevel > 0 && s.quantity <= s.item.minimumLevel);
      return reply.send({ success: true, data: { lowStock, total: lowStock.length } });
    }
  );
}
