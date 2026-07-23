// apps/api/src/routes/admin/vendor-payments.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

async function genVendorCode(schoolId: number): Promise<string> {
  const cnt = await prisma.vendor.count({ where: { schoolId } });
  return `VND-${String(cnt + 1).padStart(4, "0")}`;
}

export async function adminVendorPaymentRoutes(app: FastifyInstance) {

  // ═══════════════════════════════════════════════════
  //  DASHBOARD
  // ═══════════════════════════════════════════════════

  app.get("/admin/vendors/dashboard", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();

      const [activeVendors, pendingBills, overdueBills, byCategory, recentPayments, dueSoon] = await Promise.all([
        prisma.vendor.count({ where: { schoolId, isActive: true } }),
        prisma.vendorBill.findMany({ where: { schoolId, status: { notIn: ["PAID","CANCELLED"] } }, select: { balanceDue: true } }),
        prisma.vendorBill.aggregate({ where: { schoolId, status: { notIn: ["PAID","CANCELLED"] }, dueDate: { lt: now } }, _sum: { balanceDue: true }, _count: true }),
        prisma.vendor.groupBy({ by: ["category"], where: { schoolId, isActive: true }, _count: true }),
        prisma.vendorPayment.findMany({ where: { schoolId }, orderBy: { createdAt: "desc" }, take: 8, include: { bill: { include: { vendor: { select: { name: true } } } }, paidBy: { select: { name: true } } } }),
        prisma.vendorBill.findMany({ where: { schoolId, status: { notIn: ["PAID","CANCELLED"] }, dueDate: { lte: new Date(now.getTime() + 7*24*3600*1000) } }, orderBy: { dueDate: "asc" }, take: 5, include: { vendor: { select: { name: true } } } }),
      ]);

      const paidThisMonth = await prisma.vendorPayment.aggregate({ where: { schoolId, createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) } }, _sum: { amount: true } });
      const pendingDue = pendingBills.reduce((s, b) => s + Number(b.balanceDue), 0);

      // 6-month spend trend
      const trend: any[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
        const d2 = new Date(d); d2.setMonth(d2.getMonth() + 1);
        const agg = await prisma.vendorPayment.aggregate({ where: { schoolId, createdAt: { gte: d, lt: d2 } }, _sum: { amount: true } });
        trend.push({ label: d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" }), amount: Number(agg._sum.amount ?? 0) });
      }

      return reply.send({ success: true, data: {
        kpi: { activeVendors, pendingBills: pendingBills.length, pendingDue, paidThisMonth: Number(paidThisMonth._sum.amount ?? 0), overdueCount: overdueBills._count, overdueAmount: Number(overdueBills._sum.balanceDue ?? 0) },
        byCategory: byCategory.map(b => ({ category: b.category, count: b._count })),
        recentPayments, dueSoon, trend,
      }});
    }
  );

  // ═══════════════════════════════════════════════════
  //  VENDOR DIRECTORY
  // ═══════════════════════════════════════════════════

  app.get("/admin/vendors", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; category?: string; search?: string; active?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.category) where.category = q.category;
      if (q.active !== undefined) where.isActive = q.active === "true";
      if (q.search) where.OR = [
        { name: { contains: q.search, mode: "insensitive" } },
        { vendorCode: { contains: q.search, mode: "insensitive" } },
        { mobile: { contains: q.search, mode: "insensitive" } },
      ];
      const [vendors, total] = await Promise.all([
        prisma.vendor.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { name: "asc" },
          include: { _count: { select: { bills: true } } } }),
        prisma.vendor.count({ where }),
      ]);
      // Outstanding per vendor
      const enriched = await Promise.all(vendors.map(async v => {
        const outstanding = await prisma.vendorBill.aggregate({ where: { vendorId: v.id, status: { notIn: ["PAID","CANCELLED"] } }, _sum: { balanceDue: true } });
        return { ...v, outstanding: Number(outstanding._sum.balanceDue ?? 0) };
      }));
      return reply.send({ success: true, data: { vendors: enriched, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  app.get("/admin/vendors/:id", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const vendor = await prisma.vendor.findFirst({ where: { id: parseInt(id), schoolId },
        include: { bills: { orderBy: { billDate: "desc" }, take: 10, include: { payments: true } }, createdBy: { select: { name: true } } } });
      if (!vendor) return reply.status(404).send({ success: false, message: "Vendor not found." });
      const totalBilled = await prisma.vendorBill.aggregate({ where: { vendorId: parseInt(id) }, _sum: { totalAmount: true } });
      const totalPaid   = await prisma.vendorBill.aggregate({ where: { vendorId: parseInt(id) }, _sum: { paidAmount: true } });
      return reply.send({ success: true, data: { vendor, totalBilled: Number(totalBilled._sum.totalAmount ?? 0), totalPaid: Number(totalPaid._sum.paidAmount ?? 0) } });
    }
  );

  app.post("/admin/vendors", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { name: string; category?: string; mobile?: string; email?: string; gstNumber?: string; panNumber?: string; address?: string; bankName?: string; accountNo?: string; ifscCode?: string; accountName?: string; notes?: string };
      if (!body.name?.trim()) return reply.status(400).send({ success: false, message: "Vendor name required." });
      const vendorCode = await genVendorCode(schoolId);
      const v = await prisma.vendor.create({ data: { schoolId, createdById: userId, vendorCode, name: body.name.trim(), category: body.category as any ?? "OTHER", mobile: body.mobile ?? null, email: body.email ?? null, gstNumber: body.gstNumber ?? null, panNumber: body.panNumber ?? null, address: body.address ?? null, bankName: body.bankName ?? null, accountNo: body.accountNo ?? null, ifscCode: body.ifscCode ?? null, accountName: body.accountName ?? null, notes: body.notes ?? null } });
      return reply.status(201).send({ success: true, data: { vendorId: v.id, vendorCode } });
    }
  );

  app.put("/admin/vendors/:id", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const data: any = {};
      ["name","category","mobile","email","gstNumber","panNumber","address","bankName","accountNo","ifscCode","accountName","isActive","rating","notes"].forEach(k => { if (body[k] !== undefined) data[k] = body[k]; });
      await prisma.vendor.updateMany({ where: { id: parseInt(id), schoolId }, data });
      return reply.send({ success: true, message: "Vendor updated." });
    }
  );

  app.delete("/admin/vendors/:id", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.vendor.updateMany({ where: { id: parseInt(id), schoolId }, data: { isActive: false } });
      return reply.send({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════
  //  VENDOR BILLS
  // ═══════════════════════════════════════════════════

  app.get("/admin/vendor-bills", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; status?: string; vendorId?: string; overdue?: string; dueThisWeek?: string; search?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const now = new Date();
      const where: any = { schoolId };
      if (q.status)   where.status   = q.status;
      if (q.vendorId) where.vendorId = parseInt(q.vendorId);
      if (q.overdue === "true") { where.dueDate = { lt: now }; where.status = { notIn: ["PAID","CANCELLED"] }; }
      if (q.dueThisWeek === "true") { where.dueDate = { lte: new Date(now.getTime() + 7*24*3600*1000), gte: now }; where.status = { notIn: ["PAID","CANCELLED"] }; }
      if (q.search) where.OR = [
        { billNo: { contains: q.search, mode: "insensitive" } },
        { vendor: { name: { contains: q.search, mode: "insensitive" } } },
        { description: { contains: q.search, mode: "insensitive" } },
      ];
      const [bills, total] = await Promise.all([
        prisma.vendorBill.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { dueDate: "asc" },
          include: { vendor: { select: { name: true, vendorCode: true } }, createdBy: { select: { name: true } }, verifiedBy: { select: { name: true } }, approvedBy: { select: { name: true } }, _count: { select: { payments: true } } } }),
        prisma.vendorBill.count({ where }),
      ]);
      const enriched = bills.map(b => ({ ...b, isOverdue: new Date(b.dueDate) < now && !["PAID","CANCELLED"].includes(b.status), daysOverdue: new Date(b.dueDate) < now ? Math.floor((now.getTime() - new Date(b.dueDate).getTime()) / 86400000) : 0 }));
      return reply.send({ success: true, data: { bills: enriched, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  app.get("/admin/vendor-bills/:id", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const bill = await prisma.vendorBill.findFirst({ where: { id: parseInt(id), schoolId },
        include: { vendor: true, payments: { include: { paidBy: { select: { name: true } } } }, createdBy: { select: { name: true } }, verifiedBy: { select: { name: true } }, approvedBy: { select: { name: true } } } });
      if (!bill) return reply.status(404).send({ success: false, message: "Not found." });
      return reply.send({ success: true, data: { bill } });
    }
  );

  app.post("/admin/vendor-bills", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { vendorId: number; billNo: string; category?: string; billDate: string; dueDate: string; amount: number; taxAmount?: number; description: string; attachmentUrls?: string[]; isRecurring?: boolean; recurrenceType?: string };
      if (!body.vendorId || !body.billNo || !body.amount) return reply.status(400).send({ success: false, message: "vendorId, billNo, amount required." });
      const total = body.amount + (body.taxAmount ?? 0);
      const bill = await prisma.vendorBill.create({ data: { schoolId, createdById: userId, vendorId: body.vendorId, billNo: body.billNo.trim(), category: body.category as any ?? "OTHER", billDate: new Date(body.billDate), dueDate: new Date(body.dueDate), amount: body.amount, taxAmount: body.taxAmount ?? 0, totalAmount: total, paidAmount: 0, balanceDue: total, description: body.description, attachmentUrls: body.attachmentUrls ?? [], isRecurring: body.isRecurring ?? false, recurrenceType: body.recurrenceType as any ?? "NONE", status: "SUBMITTED" } });
      return reply.status(201).send({ success: true, data: { billId: bill.id } });
    }
  );

  app.patch("/admin/vendor-bills/:id/verify", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.vendorBill.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "VERIFIED", verifiedById: userId, verifiedAt: new Date() } });
      return reply.send({ success: true, message: "Bill verified." });
    }
  );

  app.patch("/admin/vendor-bills/:id/approve", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.vendorBill.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "APPROVED", approvedById: userId, approvedAt: new Date() } });
      return reply.send({ success: true, message: "Bill approved." });
    }
  );

  app.patch("/admin/vendor-bills/:id/cancel", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };
      await prisma.vendorBill.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "CANCELLED", cancelledById: userId, cancelledAt: new Date(), cancelReason: reason } });
      return reply.send({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════
  //  PAYMENTS
  // ═══════════════════════════════════════════════════

  app.post("/admin/vendor-bills/:id/pay", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { amount, paymentDate, paymentMode, referenceNo, remarks } = req.body as { amount: number; paymentDate: string; paymentMode: string; referenceNo?: string; remarks?: string };

      const bill = await prisma.vendorBill.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!bill) return reply.status(404).send({ success: false, message: "Bill not found." });
      if (amount > Number(bill.balanceDue)) return reply.status(400).send({ success: false, message: "Payment exceeds balance due." });

      await prisma.vendorPayment.create({ data: { schoolId, billId: parseInt(id), vendorId: bill.vendorId, amount, paymentDate: new Date(paymentDate), paymentMode: paymentMode as any, referenceNo: referenceNo ?? null, remarks: remarks ?? null, isPartial: amount < Number(bill.balanceDue), paidById: userId } });

      const newPaid = Number(bill.paidAmount) + amount;
      const newBalance = Number(bill.totalAmount) - newPaid;
      const newStatus = newBalance <= 0 ? "PAID" : "PARTIAL";

      await prisma.vendorBill.update({ where: { id: parseInt(id) }, data: { paidAmount: newPaid, balanceDue: Math.max(0, newBalance), status: newStatus } });

      // Auto-set next due for recurring
      if (bill.isRecurring && newStatus === "PAID") {
        const next = new Date(bill.dueDate);
        if (bill.recurrenceType === "MONTHLY")    next.setMonth(next.getMonth() + 1);
        else if (bill.recurrenceType === "QUARTERLY") next.setMonth(next.getMonth() + 3);
        else if (bill.recurrenceType === "YEARLY")    next.setFullYear(next.getFullYear() + 1);
        await prisma.vendorBill.update({ where: { id: parseInt(id) }, data: { nextDueDate: next } });
      }

      return reply.send({ success: true, message: `Payment of ₹${amount} recorded. ${newStatus === "PAID" ? "Bill fully paid ✅" : `Balance: ₹${newBalance}`}`, data: { newStatus, newBalance } });
    }
  );

  // ═══════════════════════════════════════════════════
  //  VENDOR LEDGER
  // ═══════════════════════════════════════════════════

  app.get("/admin/vendor-ledger/:vendorId", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { vendorId } = req.params as { vendorId: string };
      const [vendor, bills] = await Promise.all([
        prisma.vendor.findFirst({ where: { id: parseInt(vendorId), schoolId } }),
        prisma.vendorBill.findMany({ where: { vendorId: parseInt(vendorId), schoolId }, orderBy: { billDate: "desc" }, include: { payments: { orderBy: { createdAt: "desc" } } } }),
      ]);
      if (!vendor) return reply.status(404).send({ success: false, message: "Vendor not found." });
      const totalBilled = bills.reduce((s, b) => s + Number(b.totalAmount), 0);
      const totalPaid   = bills.reduce((s, b) => s + Number(b.paidAmount), 0);
      const outstanding = bills.filter(b => !["PAID","CANCELLED"].includes(b.status)).reduce((s, b) => s + Number(b.balanceDue), 0);
      return reply.send({ success: true, data: { vendor, bills, totalBilled, totalPaid, outstanding } });
    }
  );

  // ═══════════════════════════════════════════════════
  //  REPORTS
  // ═══════════════════════════════════════════════════

  app.get("/admin/vendor-payments/reports", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string };
      const billWhere: any = { schoolId };
      if (q.from || q.to) { billWhere.billDate = {}; if (q.from) billWhere.billDate.gte = new Date(q.from); if (q.to) billWhere.billDate.lte = new Date(q.to); }

      const [byCategory, byStatus, paymentTotals, topVendors] = await Promise.all([
        prisma.vendorBill.groupBy({ by: ["category"], where: billWhere, _count: true, _sum: { totalAmount: true } }),
        prisma.vendorBill.groupBy({ by: ["status"],   where: billWhere, _count: true, _sum: { totalAmount: true } }),
        prisma.vendorPayment.aggregate({ where: { schoolId }, _sum: { amount: true } }),
        prisma.vendor.findMany({ where: { schoolId, isActive: true }, include: { _count: { select: { bills: true } } }, orderBy: { bills: { _count: "desc" } }, take: 10 }),
      ]);

      return reply.send({ success: true, data: {
        byCategory: byCategory.map(b => ({ category: b.category, count: b._count, amount: Number(b._sum.totalAmount ?? 0) })).sort((a,b) => b.amount-a.amount),
        byStatus:   byStatus.map(b => ({ status: b.status, count: b._count, amount: Number(b._sum.totalAmount ?? 0) })),
        totalPaid:  Number(paymentTotals._sum.amount ?? 0),
        topVendors,
      }});
    }
  );
}
