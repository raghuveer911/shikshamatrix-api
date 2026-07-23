// apps/api/src/routes/admin/transactions.ts
// NOTE: Transactions are IMMUTABLE — no edit/delete, only reverse/refund/adjust

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

async function genAdjNo(schoolId: number) {
  const cnt = await prisma.txnAdjustment.count({ where: { schoolId } });
  const y = new Date().getFullYear().toString().slice(-2);
  return `ADJ-${y}-${String(cnt + 1).padStart(5, "0")}`;
}

export async function adminTransactionsRoutes(app: FastifyInstance) {

  // ─── DASHBOARD ─────────────────────────────────────────────
  app.get("/admin/transactions/dashboard", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const [totalTxns, collectionAgg, refundAgg, failedCount, pendingRecon,
             byMode, byStatus, recent, adjustments] = await Promise.all([
        prisma.payment.count({ where: { invoice: { schoolId } } }),
        prisma.payment.aggregate({ where: { invoice: { schoolId }, paidAt: { gte: monthStart } }, _sum: { amount: true } }),
        prisma.feeRefund.aggregate({ where: { schoolId, status: "PROCESSED" }, _sum: { amount: true } }),
        prisma.paymentReconciliation.count({ where: { schoolId, status: "MISMATCH" } }),
        prisma.paymentReconciliation.count({ where: { schoolId, status: "PENDING" } }),
        prisma.payment.groupBy({ by: ["method"], where: { invoice: { schoolId }, paidAt: { gte: monthStart } }, _sum: { amount: true }, _count: true }),
        prisma.invoice.groupBy({ by: ["status"], where: { schoolId }, _count: true, _sum: { totalAmount: true } }),
        prisma.payment.findMany({ where: { invoice: { schoolId } }, orderBy: { paidAt: "desc" }, take: 8,
          include: { invoice: { include: { student: { include: { user: { select: { name: true } } } } } }, receivedBy: { select: { name: true } } } }),
        prisma.txnAdjustment.count({ where: { schoolId, status: "PENDING" } }),
      ]);

      // Daily collection last 7 days
      const daily7: {day:string;amount:number}[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(todayStart.getTime() - i*86400000);
        const d2 = new Date(d.getTime() + 86400000);
        const agg = await prisma.payment.aggregate({ where: { invoice: { schoolId }, paidAt: { gte: d, lt: d2 } }, _sum: { amount: true } });
        daily7.push({ day: d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }), amount: Number(agg._sum.amount ?? 0) });
      }

      return reply.send({ success: true, data: {
        kpi: {
          totalTransactions: totalTxns,
          collectionThisMonth: Number(collectionAgg._sum.amount ?? 0),
          refundsTotal: Number(refundAgg._sum.amount ?? 0),
          failedTransactions: failedCount,
          pendingReconciliation: pendingRecon,
          pendingAdjustments: adjustments,
        },
        byMode: byMode.map(b => ({ mode: b.method, amount: Number(b._sum.amount ?? 0), count: b._count })),
        byStatus: byStatus.map(b => ({ status: b.status, count: b._count, amount: Number(b._sum.totalAmount ?? 0) })),
        recentTransactions: recent.map(p => ({
          id: p.id, receiptNo: p.receiptNumber,
          studentName: p.invoice.student?.user?.name,
          amount: Number(p.amount), method: p.method,
          paidAt: p.paidAt, collectedBy: p.receivedBy?.name,
        })),
        daily7,
      }});
    }
  );

  // ─── ALL TRANSACTIONS (immutable ledger) ───────────────────
  app.get("/admin/transactions", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; mode?: string; from?: string; to?: string; search?: string; classId?: string; academicYearId?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      const where: any = { invoice: { schoolId } };
      if (q.mode)          where.method = q.mode;
      if (q.classId)       where.invoice.student = { classId: parseInt(q.classId) };
      if (q.academicYearId) where.invoice.academicYearId = parseInt(q.academicYearId);
      if (q.from || q.to) { where.paidAt = {}; if (q.from) where.paidAt.gte = new Date(q.from); if (q.to) where.paidAt.lte = new Date(q.to); }
      if (q.search) where.OR = [
        { receiptNumber: { contains: q.search, mode: "insensitive" } },
        { invoice: { student: { user: { name: { contains: q.search, mode: "insensitive" } } } } },
        { invoice: { invoiceNumber: { contains: q.search, mode: "insensitive" } } },
      ];
      const [payments, total, totalAmt] = await Promise.all([
        prisma.payment.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { paidAt: "desc" },
          include: { invoice: { include: { items: true, student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } } } }, receivedBy: { select: { name: true } } } }),
        prisma.payment.count({ where }),
        prisma.payment.aggregate({ where, _sum: { amount: true } }),
      ]);
      return reply.send({ success: true, data: { payments, total, totalPages: Math.ceil(total/limit), totalAmount: Number(totalAmt._sum.amount ?? 0) } });
    }
  );

  // ─── TRANSACTION DETAIL ────────────────────────────────────
  app.get("/admin/transactions/:id", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const payment = await prisma.payment.findFirst({ where: { id: parseInt(id), invoice: { schoolId } },
        include: { invoice: { include: { items: true, student: { include: { user: true, class: true, parentDetail: true } } } }, receivedBy: { select: { name: true } } } });
      if (!payment) return reply.status(404).send({ success: false, message: "Transaction not found." });
      // Check for adjustments on this invoice
      const adjustments = await prisma.txnAdjustment.findMany({ where: { invoiceId: payment.invoiceId, schoolId } });
      // Check for receipt
      const receipt = await prisma.feeReceipt.findFirst({ where: { paymentId: parseInt(id) } });
      // Check for refunds
      const refund = await prisma.feeRefund.findFirst({ where: { invoiceId: payment.invoiceId, schoolId } });
      return reply.send({ success: true, data: { payment, adjustments, receipt, refund } });
    }
  );

  // ─── RECEIPTS ──────────────────────────────────────────────
  app.get("/admin/transactions/receipts", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; isVoid?: string; search?: string; from?: string; to?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.isVoid !== undefined) where.isVoid = q.isVoid === "true";
      if (q.from || q.to) { where.createdAt = {}; if (q.from) where.createdAt.gte = new Date(q.from); if (q.to) where.createdAt.lte = new Date(q.to); }
      if (q.search) where.OR = [
        { receiptNo: { contains: q.search, mode: "insensitive" } },
        { student: { user: { name: { contains: q.search, mode: "insensitive" } } } },
      ];
      const [receipts, total] = await Promise.all([
        prisma.feeReceipt.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" },
          include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, payment: { include: { receivedBy: { select: { name: true } } } }, invoice: { include: { items: true } } } }),
        prisma.feeReceipt.count({ where }),
      ]);
      return reply.send({ success: true, data: { receipts, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── REFUNDS ───────────────────────────────────────────────
  app.get("/admin/transactions/refunds", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; status?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status) where.status = q.status;
      const [refunds, total, pendingAmt] = await Promise.all([
        prisma.feeRefund.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" },
          include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, approvedBy: { select: { name: true } }, processedBy: { select: { name: true } } } }),
        prisma.feeRefund.count({ where }),
        prisma.feeRefund.aggregate({ where: { schoolId, status: { in: ["REQUESTED","UNDER_REVIEW","APPROVED"] } }, _sum: { amount: true } }),
      ]);
      return reply.send({ success: true, data: { refunds, total, totalPages: Math.ceil(total/limit), pendingRefundAmount: Number(pendingAmt._sum.amount ?? 0) } });
    }
  );

  app.patch("/admin/transactions/refunds/:id/approve", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any; const { id } = req.params as { id: string };
      await prisma.feeRefund.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "APPROVED", approvedById: userId, approvedAt: new Date() } });
      return reply.send({ success: true, message: "Refund approved." });
    }
  );

  app.patch("/admin/transactions/refunds/:id/process", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any; const { id } = req.params as { id: string };
      const { paymentMode, transactionRef } = req.body as { paymentMode: string; transactionRef?: string };
      await prisma.feeRefund.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "PROCESSED", processedById: userId, processedAt: new Date(), paymentMode: paymentMode as any, transactionRef: transactionRef ?? null } });
      return reply.send({ success: true, message: "Refund processed." });
    }
  );

  // ─── ADJUSTMENTS ───────────────────────────────────────────
  app.get("/admin/transactions/adjustments", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; status?: string; type?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status) where.status = q.status;
      if (q.type)   where.adjustmentType = q.type;
      const [adjustments, total] = await Promise.all([
        prisma.txnAdjustment.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" },
          include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, createdBy: { select: { name: true } }, approvedBy: { select: { name: true } } } }),
        prisma.txnAdjustment.count({ where }),
      ]);
      return reply.send({ success: true, data: { adjustments, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  app.post("/admin/transactions/adjustments", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { studentId: number; invoiceId?: number; adjustmentType: string; amount: number; description: string; notes?: string };
      if (!body.studentId || !body.amount || !body.description) return reply.status(400).send({ success: false, message: "studentId, amount, description required." });
      const adjNo = await genAdjNo(schoolId);
      const adj = await prisma.txnAdjustment.create({ data: { schoolId, createdById: userId, adjustmentNo: adjNo, studentId: body.studentId, invoiceId: body.invoiceId ?? null, adjustmentType: body.adjustmentType as any, amount: body.amount, description: body.description, notes: body.notes ?? null, status: "PENDING" } });
      return reply.status(201).send({ success: true, message: "Adjustment created.", data: { id: adj.id, adjustmentNo: adjNo } });
    }
  );

  app.patch("/admin/transactions/adjustments/:id/approve", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any; const { id } = req.params as { id: string };
      await prisma.txnAdjustment.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "APPROVED", approvedById: userId, approvedAt: new Date() } });
      return reply.send({ success: true, message: "Adjustment approved." });
    }
  );

  app.patch("/admin/transactions/adjustments/:id/apply", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const adj = await prisma.txnAdjustment.findFirst({ where: { id: parseInt(id), schoolId, status: "APPROVED" } });
      if (!adj) return reply.status(400).send({ success: false, message: "Adjustment not approved." });
      // Mark as applied (immutable after this)
      await prisma.txnAdjustment.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "APPLIED", isApplied: true, appliedAt: new Date() } });
      return reply.send({ success: true, message: "Adjustment applied and locked." });
    }
  );

  // ─── RECONCILIATION ────────────────────────────────────────
  app.get("/admin/transactions/reconciliation", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { status?: string; page?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status) where.status = q.status;
      const [records, total] = await Promise.all([
        prisma.paymentReconciliation.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" },
          include: { invoice: { include: { student: { include: { user: { select: { name: true } } } } } } } }),
        prisma.paymentReconciliation.count({ where }),
      ]);
      return reply.send({ success: true, data: { records, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  app.patch("/admin/transactions/reconciliation/:id/resolve", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any; const { id } = req.params as { id: string };
      const { resolution } = req.body as { resolution: string };
      await prisma.paymentReconciliation.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "MANUAL_MATCHED", resolvedById: userId, resolvedAt: new Date(), mismatchReason: resolution } });
      return reply.send({ success: true, message: "Reconciliation resolved." });
    }
  );

  // ─── AUDIT TRAIL ───────────────────────────────────────────
  app.get("/admin/transactions/audit", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string; search?: string; page?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      const where: any = { invoice: { schoolId } };
      if (q.from || q.to) { where.paidAt = {}; if (q.from) where.paidAt.gte = new Date(q.from); if (q.to) where.paidAt.lte = new Date(q.to); }
      if (q.search) where.OR = [{ receiptNumber: { contains: q.search, mode: "insensitive" } }, { invoice: { invoiceNumber: { contains: q.search, mode: "insensitive" } } }];
      const [payments, total] = await Promise.all([
        prisma.payment.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { paidAt: "desc" },
          include: { invoice: { select: { invoiceNumber: true, status: true, student: { include: { user: { select: { name: true } } } } } }, receivedBy: { select: { name: true } } } }),
        prisma.payment.count({ where }),
      ]);
      return reply.send({ success: true, data: { trail: payments.map(p => ({ id: p.id, receiptNo: p.receiptNumber, invoiceNo: p.invoice.invoiceNumber, student: p.invoice.student?.user?.name, amount: Number(p.amount), method: p.method, collectedBy: p.receivedBy?.name, paidAt: p.paidAt, invoiceStatus: p.invoice.status, isImmutable: true })), total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── REPORTS ───────────────────────────────────────────────
  app.get("/admin/transactions/reports", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string };
      const payWhere: any = { invoice: { schoolId } };
      if (q.from || q.to) { payWhere.paidAt = {}; if (q.from) payWhere.paidAt.gte = new Date(q.from); if (q.to) payWhere.paidAt.lte = new Date(q.to); }

      const [byMode, byDay, totalColl, cashColl, onlineColl, refundTotal] = await Promise.all([
        prisma.payment.groupBy({ by: ["method"], where: payWhere, _sum: { amount: true }, _count: true }),
        prisma.$queryRaw<{day:string;amount:number}[]>`
          SELECT DATE("paidAt") as day, SUM(p.amount) as amount
          FROM payments p JOIN invoices i ON p."invoiceId" = i.id
          WHERE i."schoolId" = ${schoolId}
          ${q.from ? prisma.$raw`AND p."paidAt" >= ${new Date(q.from!)}` : prisma.$raw``}
          ${q.to   ? prisma.$raw`AND p."paidAt" <= ${new Date(q.to!)}` : prisma.$raw``}
          GROUP BY DATE("paidAt") ORDER BY day ASC
        `.catch(() => []),
        prisma.payment.aggregate({ where: payWhere, _sum: { amount: true } }),
        prisma.payment.aggregate({ where: { ...payWhere, method: "CASH" }, _sum: { amount: true } }),
        prisma.payment.aggregate({ where: { ...payWhere, method: { in: ["UPI","ONLINE","BANK_TRANSFER"] } }, _sum: { amount: true } }),
        prisma.feeRefund.aggregate({ where: { schoolId, status: "PROCESSED" }, _sum: { amount: true } }),
      ]);

      return reply.send({ success: true, data: {
        byMode: byMode.map(b => ({ mode: b.method, amount: Number(b._sum.amount ?? 0), count: b._count })),
        byDay:  Array.isArray(byDay) ? byDay.map((d: any) => ({ day: d.day, amount: Number(d.amount) })) : [],
        summary: { totalCollection: Number(totalColl._sum.amount ?? 0), cashCollection: Number(cashColl._sum.amount ?? 0), onlineCollection: Number(onlineColl._sum.amount ?? 0), totalRefunds: Number(refundTotal._sum.amount ?? 0) },
      }});
    }
  );
}
