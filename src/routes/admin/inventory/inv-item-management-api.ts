// apps/api/src/routes/admin/inventory/inv-item-management-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ── Generate next item code ───────────────────────────────────
async function nextItemCode(schoolId: number): Promise<string> {
  const count = await prisma.invItem.count({ where: { schoolId } });
  return `INV-${String(count + 1).padStart(4, "0")}`;
}

export async function adminInvItemMgmtRoutes(app: FastifyInstance) {
  const P = "/admin/inventory/items";

  // ─── CATEGORIES CRUD ──────────────────────────────────────
  app.get(`${P}/categories`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const categories = await prisma.invCategory.findMany({
        where: { schoolId, isActive: true },
        orderBy: { name: "asc" },
        include: { _count: { select: { items: true } } },
      });
      return rep.send({ categories });
    }
  );

  app.post(`${P}/categories`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const cat = await prisma.invCategory.upsert({
        where: { schoolId_name: { schoolId, name: b.name } },
        create: { schoolId, name: b.name, description: b.description ?? null, color: b.color ?? "#6366f1", icon: b.icon ?? "Package" },
        update: { description: b.description, color: b.color, icon: b.icon },
      });
      return rep.code(201).send({ category: cat });
    }
  );

  app.put(`${P}/categories/:id`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const cat = await prisma.invCategory.update({
        where: { id, schoolId },
        data: { name: b.name, description: b.description, color: b.color, icon: b.icon, isActive: b.isActive },
      });
      return rep.send({ category: cat });
    }
  );

  // ─── UNITS CRUD ───────────────────────────────────────────
  app.get(`${P}/units`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const units = await prisma.invUnit.findMany({ where: { schoolId, isActive: true }, orderBy: { name: "asc" } });
      return rep.send({ units });
    }
  );

  app.post(`${P}/units`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const unit = await prisma.invUnit.upsert({
        where: { schoolId_name: { schoolId, name: b.name } },
        create: { schoolId, name: b.name, shortName: b.shortName ?? b.name.slice(0, 5) },
        update: { shortName: b.shortName },
      });
      return rep.code(201).send({ unit });
    }
  );

  // ─── BRANDS CRUD ──────────────────────────────────────────
  app.get(`${P}/brands`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const brands = await prisma.invBrand.findMany({
        where: { schoolId, isActive: true, ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}) },
        orderBy: { name: "asc" },
        take: Number(q.limit ?? 50),
      });
      return rep.send({ brands });
    }
  );

  app.post(`${P}/brands`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { name } = req.body as any;
      const brand = await prisma.invBrand.upsert({
        where: { schoolId_name: { schoolId, name } },
        create: { schoolId, name },
        update: {},
      });
      return rep.code(201).send({ brand });
    }
  );

  // ─── LOCATIONS CRUD ───────────────────────────────────────
  app.get(`${P}/locations`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const locations = await prisma.invLocation.findMany({
        where: { schoolId, isActive: true },
        orderBy: [{ type: "asc" }, { name: "asc" }],
        include: { _count: { select: { stocks: true } } },
      });
      return rep.send({ locations });
    }
  );

  app.post(`${P}/locations`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const location = await prisma.invLocation.upsert({
        where: { schoolId_name: { schoolId, name: b.name } },
        create: { schoolId, name: b.name, code: b.code ?? null, type: b.type ?? "STORE", floor: b.floor ?? null },
        update: { code: b.code, type: b.type, floor: b.floor },
      });
      return rep.code(201).send({ location });
    }
  );

  // ─── ITEMS — List & Search ────────────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 30);

      const where: any = { schoolId, isActive: true };
      if (q.categoryId)    where.categoryId    = Number(q.categoryId);
      if (q.trackingType)  where.trackingType  = q.trackingType;
      if (q.status)        where.status        = q.status;
      if (q.assetStatus)   where.assetStatus   = q.assetStatus;
      if (q.search) {
        where.OR = [
          { name:     { contains: q.search, mode: "insensitive" } },
          { itemCode: { contains: q.search, mode: "insensitive" } },
          { barcode:  { contains: q.search, mode: "insensitive" } },
          { brand:    { name: { contains: q.search, mode: "insensitive" } } },
          { model:    { contains: q.search, mode: "insensitive" } },
        ];
      }

      const [items, total] = await Promise.all([
        prisma.invItem.findMany({
          where,
          include: {
            category: { select: { name: true, color: true } },
            unit:     { select: { name: true, shortName: true } },
            brand:    { select: { name: true } },
            _count:   { select: { stocks: true } },
          },
          orderBy: { name: "asc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.invItem.count({ where }),
      ]);

      // Enrich with total stock
      const enriched = await Promise.all(items.map(async item => {
        const stockAgg = await prisma.invStock.aggregate({ where: { itemId: item.id }, _sum: { quantity: true } });
        const totalQty = Number(stockAgg._sum.quantity ?? 0);
        const stockStatus = totalQty === 0 ? "OUT_OF_STOCK"
          : item.minimumLevel > 0 && totalQty <= item.minimumLevel ? "LOW_STOCK"
          : "HEALTHY";
        return { ...item, totalQty, stockStatus };
      }));

      return rep.send({ items: enriched, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── GET ONE ITEM ─────────────────────────────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const item = await prisma.invItem.findFirst({
        where: { id, schoolId },
        include: {
          category: { select: { name: true, color: true } },
          unit:     { select: { name: true, shortName: true } },
          brand:    { select: { name: true } },
          stocks:   { include: { location: { select: { name: true, type: true } } } },
        },
      });
      if (!item) return rep.code(404).send({ error: "Item not found" });

      // Recent transactions
      const recentTxns = await prisma.invTransaction.findMany({
        where: { itemId: id, schoolId },
        include: {
          toLocation:   { select: { name: true } },
          fromLocation: { select: { name: true } },
          issuedToStaff: { include: { user: { select: { name: true } } } },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      });

      return rep.send({ item, recentTxns });
    }
  );

  // ─── CREATE ITEM ──────────────────────────────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      // Auto-create brand if string provided
      let brandId = b.brandId ? Number(b.brandId) : null;
      if (b.brandName && !brandId) {
        const brand = await prisma.invBrand.upsert({
          where: { schoolId_name: { schoolId, name: b.brandName } },
          create: { schoolId, name: b.brandName },
          update: {},
        });
        brandId = brand.id;
      }

      const itemCode = await nextItemCode(schoolId);

      const item = await prisma.invItem.create({
        data: {
          schoolId,
          itemCode,
          barcode:       b.barcode       ?? null,
          name:          b.name,
          description:   b.description   ?? null,
          categoryId:    b.categoryId    ? Number(b.categoryId)  : null,
          unitId:        b.unitId        ? Number(b.unitId)      : null,
          brandId,
          model:         b.model         ?? null,
          trackingType:  b.trackingType  as any ?? "CONSUMABLE",
          purchasePrice: b.purchasePrice ? Number(b.purchasePrice) : null,
          expectedLifeMonths: b.expectedLifeMonths ? Number(b.expectedLifeMonths) : null,
          assetStatus:   b.trackingType === "ASSET" ? "AVAILABLE" as any : null,
          serialNumber:  b.serialNumber  ?? null,
          assetTag:      b.assetTag      ?? null,
          warrantyUntil: b.warrantyUntil ? new Date(b.warrantyUntil) : null,
          minimumLevel:  Number(b.minimumLevel  ?? 0),
          reorderLevel:  Number(b.reorderLevel  ?? 0),
          imageUrl:      b.imageUrl      ?? null,
          tags:          b.tags          ?? [],
          createdById:   Number(userId),
        },
      });

      // Update category item count
      if (b.categoryId) {
        await prisma.invCategory.update({ where: { id: Number(b.categoryId) }, data: { itemCount: { increment: 1 } } });
      }

      return rep.code(201).send({ item });
    }
  );

  // ─── UPDATE ITEM ──────────────────────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const item = await prisma.invItem.update({
        where: { id, schoolId },
        data: {
          name:          b.name,
          description:   b.description,
          categoryId:    b.categoryId  ? Number(b.categoryId) : undefined,
          unitId:        b.unitId      ? Number(b.unitId)     : undefined,
          brandId:       b.brandId     ? Number(b.brandId)    : undefined,
          model:         b.model,
          trackingType:  b.trackingType as any,
          purchasePrice: b.purchasePrice ? Number(b.purchasePrice) : undefined,
          expectedLifeMonths: b.expectedLifeMonths ? Number(b.expectedLifeMonths) : undefined,
          assetStatus:   b.assetStatus as any,
          serialNumber:  b.serialNumber,
          assetTag:      b.assetTag,
          warrantyUntil: b.warrantyUntil ? new Date(b.warrantyUntil) : undefined,
          minimumLevel:  b.minimumLevel  ? Number(b.minimumLevel) : undefined,
          reorderLevel:  b.reorderLevel  ? Number(b.reorderLevel) : undefined,
          imageUrl:      b.imageUrl,
          tags:          b.tags,
          status:        b.status as any,
          isActive:      b.isActive,
        },
      });
      return rep.send({ item });
    }
  );

  // ─── SOFT DELETE ──────────────────────────────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const totalStock = await prisma.invStock.aggregate({ where: { itemId: id }, _sum: { quantity: true } });
      if (Number(totalStock._sum.quantity ?? 0) > 0) {
        return rep.code(409).send({ error: "Cannot delete — item has stock. Adjust stock to 0 first." });
      }
      await prisma.invItem.update({ where: { id, schoolId }, data: { isActive: false, status: "ARCHIVED" } });
      return rep.send({ ok: true });
    }
  );

  // ─── ISBN BARCODE CHECK ───────────────────────────────────
  app.get(`${P}/check-code/:code`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const code = (req.params as any).code;
      const item = await prisma.invItem.findFirst({
        where: { schoolId, OR: [{ itemCode: code }, { barcode: code }] },
        select: { id: true, name: true, itemCode: true },
      });
      return rep.send({ exists: !!item, item });
    }
  );

  // ─── CATALOG STATS ────────────────────────────────────────
  app.get(`${P}/stats`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [total, byCategory, byType, byStatus, warrantyExpiring] = await Promise.all([
        prisma.invItem.count({ where: { schoolId, isActive: true } }),
        prisma.invItem.groupBy({ by: ["categoryId"], where: { schoolId, isActive: true }, _count: { id: true }, orderBy: { _count: { id: "desc" } }, take: 10 }),
        prisma.invItem.groupBy({ by: ["trackingType"], where: { schoolId, isActive: true }, _count: { id: true } }),
        prisma.invItem.groupBy({ by: ["status"], where: { schoolId }, _count: { id: true } }),
        prisma.invItem.count({ where: { schoolId, isActive: true, trackingType: "ASSET", warrantyUntil: { lt: new Date(Date.now() + 90 * 86400000), gt: new Date() } } }),
      ]);
      return rep.send({ total, byCategory, byType, byStatus, warrantyExpiring });
    }
  );
}
