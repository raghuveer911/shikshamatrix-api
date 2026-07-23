import { prisma } from "../lib/prisma.js";

export async function updateStock(schoolId: number, itemId: number, locationId: number, delta: number): Promise<void> {
  await prisma.invStock.upsert({
    where: { itemId_locationId: { itemId, locationId } },
    create: { schoolId, itemId, locationId, quantity: Math.max(0, delta) },
    update: { quantity: { increment: delta } },
  });
}

export async function nextTxnCode(schoolId: number): Promise<string> {
  const count = await prisma.invTransaction.count({ where: { schoolId } });
  return `INV-TXN-${String(count + 1).padStart(5, "0")}`;
}

export class InventoryError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface StockInInput {
  itemId: number; quantity: number; locationId?: number;
  source?: string; supplierName?: string; purchasePrice?: number; invoiceNo?: string; notes?: string; referenceNo?: string; txnDate?: string;
}

export async function stockIn(schoolId: number, processedByStaffId: number | null, b: StockInInput) {
  const txnCode = await nextTxnCode(schoolId);

  let locationId = b.locationId ?? null;
  if (!locationId) {
    const defaultLoc = await prisma.invLocation.findFirst({ where: { schoolId, type: "STORE", isActive: true }, select: { id: true } });
    locationId = defaultLoc?.id ?? null;
  }
  if (!locationId) throw new InventoryError(400, "No store location found — ask an admin to set one up first.");

  const txn = await prisma.invTransaction.create({
    data: {
      schoolId, txnCode, type: "STOCK_IN", itemId: b.itemId, quantity: b.quantity, toLocationId: locationId,
      source: b.source as any ?? "PURCHASE", supplierName: b.supplierName ?? null,
      purchasePrice: b.purchasePrice ?? null, invoiceNo: b.invoiceNo ?? null, notes: b.notes ?? null,
      referenceNo: b.referenceNo ?? null, txnDate: b.txnDate ? new Date(b.txnDate) : new Date(),
      processedById: processedByStaffId,
    },
  });

  await updateStock(schoolId, b.itemId, locationId, b.quantity);
  if (b.purchasePrice) {
    await prisma.invItem.update({ where: { id: b.itemId }, data: { purchasePrice: b.purchasePrice } });
  }

  return txn;
}

export interface StockOutInput {
  itemId: number; locationId: number; quantity: number;
  destination?: string; issuedToStaffId?: number; purpose?: string; departmentName?: string; notes?: string; referenceNo?: string; txnDate?: string;
}

export async function stockOut(schoolId: number, processedByStaffId: number | null, b: StockOutInput) {
  const currentStock = await prisma.invStock.findUnique({ where: { itemId_locationId: { itemId: b.itemId, locationId: b.locationId } } });
  if (!currentStock || currentStock.quantity < b.quantity) {
    throw new InventoryError(409, `Insufficient stock. Available: ${currentStock?.quantity ?? 0}`);
  }

  const txnCode = await nextTxnCode(schoolId);
  const txn = await prisma.invTransaction.create({
    data: {
      schoolId, txnCode, type: "STOCK_OUT", itemId: b.itemId, quantity: b.quantity, fromLocationId: b.locationId,
      destination: b.destination as any ?? "DEPARTMENT", issuedToStaffId: b.issuedToStaffId ?? null,
      purpose: b.purpose ?? null, departmentName: b.departmentName ?? null, notes: b.notes ?? null,
      referenceNo: b.referenceNo ?? null, txnDate: b.txnDate ? new Date(b.txnDate) : new Date(),
      processedById: processedByStaffId,
    },
  });

  await updateStock(schoolId, b.itemId, b.locationId, -b.quantity);

  if (b.issuedToStaffId) {
    const item = await prisma.invItem.findFirst({ where: { id: b.itemId }, select: { trackingType: true } });
    if (item?.trackingType === "ASSET") {
      await prisma.invItem.update({ where: { id: b.itemId }, data: { assetStatus: "ASSIGNED" } });
    }
  }

  return txn;
}
