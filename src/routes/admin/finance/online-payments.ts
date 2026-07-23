// apps/api/src/routes/admin/online-payments.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import crypto from "crypto";

function genLinkCode() { return crypto.randomBytes(16).toString("hex"); }

export async function adminOnlinePaymentsRoutes(app: FastifyInstance) {

  // ─── DASHBOARD ─────────────────────────────────────────────
  app.get("/admin/online-payments/dashboard", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const [totalOnline, successful, failed, pendingRecon, refunds,
             todayCollection, byStatus, byMode, gateways, recentTxns, dailyTrend] = await Promise.all([
        prisma.onlinePayment.aggregate({ where: { schoolId }, _sum: { amount: true }, _count: true }),
        prisma.onlinePayment.aggregate({ where: { schoolId, status: "SUCCESS", initiatedAt: { gte: monthStart } }, _sum: { amount: true }, _count: true }),
        prisma.onlinePayment.count({ where: { schoolId, status: "FAILED" } }),
        prisma.onlinePayment.count({ where: { schoolId, status: "SUCCESS", isReconciled: false } }),
        prisma.onlinePayment.aggregate({ where: { schoolId, status: { in: ["REFUNDED","PARTIAL_REFUNDED"] } }, _sum: { refundedAmount: true }, _count: true }),
        prisma.onlinePayment.aggregate({ where: { schoolId, status: "SUCCESS", initiatedAt: { gte: todayStart } }, _sum: { amount: true } }),
        prisma.onlinePayment.groupBy({ by: ["status"], where: { schoolId }, _count: true }),
        prisma.onlinePayment.groupBy({ by: ["mode"], where: { schoolId, status: "SUCCESS" }, _sum: { amount: true }, _count: true }),
        prisma.paymentGateway.findMany({ where: { schoolId }, select: { id: true, name: true, provider: true, status: true, successCount: true, failureCount: true, totalVolume: true } }),
        prisma.onlinePayment.findMany({ where: { schoolId }, orderBy: { initiatedAt: "desc" }, take: 8, include: { student: { include: { user: { select: { name: true } } } }, gateway: { select: { name: true, provider: true } } } }),
        Promise.all(Array.from({length:7},(_,i) => {
          const d1 = new Date(todayStart); d1.setDate(d1.getDate() - (6-i));
          const d2 = new Date(d1); d2.setDate(d2.getDate() + 1);
          return prisma.onlinePayment.aggregate({ where: { schoolId, status: "SUCCESS", completedAt: { gte: d1, lt: d2 } }, _sum: { amount: true } })
            .then(r => ({ day: d1.toLocaleDateString("en-IN",{day:"2-digit",month:"short"}), amount: Number(r._sum.amount ?? 0) }));
        })),
      ]);

      const successRate = (successful._count + failed) > 0 ? (successful._count / (successful._count + failed) * 100).toFixed(1) : "0";

      return reply.send({ success: true, data: {
        kpi: {
          totalOnlineCollection:  Number(successful._sum.amount ?? 0),
          totalTransactions:      successful._count,
          failedPayments:         failed,
          pendingReconciliation:  pendingRecon,
          refundRequests:         refunds._count,
          todayCollection:        Number(todayCollection._sum.amount ?? 0),
          successRate,
        },
        byStatus: byStatus.map(s => ({ status: s.status, count: s._count })),
        byMode: byMode.map(m => ({ mode: m.mode, amount: Number(m._sum.amount ?? 0), count: m._count })),
        gateways, recentTxns, dailyTrend,
      }});
    }
  );

  // ─── GATEWAY MANAGEMENT ────────────────────────────────────
  app.get("/admin/online-payments/gateways", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const gateways = await prisma.paymentGateway.findMany({ where: { schoolId }, orderBy: { isDefault: "desc" } });
      // Never return secrets in listing
      return reply.send({ success: true, data: { gateways: gateways.map(g => ({ ...g, apiSecret: g.apiSecret ? "••••••••" : null, webhookSecret: g.webhookSecret ? "••••••••" : null })) } });
    }
  );

  app.post("/admin/online-payments/gateways", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { name: string; provider: string; status: string; apiKey?: string; apiSecret?: string; webhookSecret?: string; merchantId?: string; isDefault?: boolean; extraConfig?: any };
      if (!body.name || !body.provider) return reply.status(400).send({ success: false, message: "name and provider required." });
      if (body.isDefault) await prisma.paymentGateway.updateMany({ where: { schoolId }, data: { isDefault: false } });
      const g = await prisma.paymentGateway.create({ data: { schoolId, name: body.name, provider: body.provider as any, status: body.status as any ?? "SANDBOX", apiKey: body.apiKey ?? null, apiSecret: body.apiSecret ?? null, webhookSecret: body.webhookSecret ?? null, merchantId: body.merchantId ?? null, isDefault: body.isDefault ?? false, extraConfig: body.extraConfig ?? undefined } });
      return reply.status(201).send({ success: true, data: { id: g.id } });
    }
  );

  app.put("/admin/online-payments/gateways/:id", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const body = req.body as { name?: string; status?: string; apiKey?: string; apiSecret?: string; webhookSecret?: string; merchantId?: string; isDefault?: boolean };
      if (body.isDefault) await prisma.paymentGateway.updateMany({ where: { schoolId }, data: { isDefault: false } });
      // Don't update secret if placeholder sent
      const data: any = { ...body };
      if (data.apiSecret === "••••••••") delete data.apiSecret;
      if (data.webhookSecret === "••••••••") delete data.webhookSecret;
      await prisma.paymentGateway.updateMany({ where: { id: parseInt(id), schoolId }, data });
      return reply.send({ success: true });
    }
  );

  app.delete("/admin/online-payments/gateways/:id", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      await prisma.paymentGateway.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "DEPRECATED" } });
      return reply.send({ success: true });
    }
  );

  // ─── PAYMENT LINKS ─────────────────────────────────────────
  app.get("/admin/online-payments/payment-links", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; status?: string; studentId?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status)    where.status    = q.status;
      if (q.studentId) where.studentId = parseInt(q.studentId);
      const [links, total] = await Promise.all([
        prisma.paymentLink.findMany({ where, skip:(page-1)*limit, take:limit, orderBy:{createdAt:"desc"},
          include:{ student:{ include:{ user:{select:{name:true}}, class:{select:{name:true}} } } } }),
        prisma.paymentLink.count({ where }),
      ]);
      return reply.send({ success: true, data: { links, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  app.post("/admin/online-payments/payment-links", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { studentId: number; invoiceId?: number; amount: number; description?: string; expiryHours?: number; feeHeads?: any[] };
      if (!body.studentId || !body.amount) return reply.status(400).send({ success: false, message: "studentId and amount required." });
      // Get school control for link expiry
      const control = await prisma.financeControl.findUnique({ where: { schoolId } });
      const expiryMinutes = (body.expiryHours ?? 24) * 60;
      const linkCode = genLinkCode();
      const link = await prisma.paymentLink.create({ data: {
        schoolId, studentId: body.studentId, invoiceId: body.invoiceId ?? null,
        linkCode, amount: body.amount,
        description: body.description ?? "Fee Payment",
        feeHeads: body.feeHeads ?? undefined,
        expiresAt: new Date(Date.now() + expiryMinutes * 60000),
        createdById: userId,
      }});
      const shortUrl = `${process.env.NEXT_PUBLIC_PARENT_URL ?? "https://pay.shikshamatrix.in"}/pay/${linkCode}`;
      await prisma.paymentLink.update({ where: { id: link.id }, data: { shortUrl } });
      return reply.status(201).send({ success: true, data: { id: link.id, linkCode, shortUrl, expiresAt: link.expiresAt } });
    }
  );

  app.delete("/admin/online-payments/payment-links/:id", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      await prisma.paymentLink.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "CANCELLED" } });
      return reply.send({ success: true });
    }
  );

  // ─── TRANSACTIONS ──────────────────────────────────────────
  app.get("/admin/online-payments/transactions", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; status?: string; gatewayId?: string; from?: string; to?: string; search?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      const where: any = { schoolId };
      if (q.status)    where.status    = q.status;
      if (q.gatewayId) where.gatewayId = parseInt(q.gatewayId);
      if (q.from || q.to) { where.initiatedAt = {}; if (q.from) where.initiatedAt.gte = new Date(q.from); if (q.to) where.initiatedAt.lte = new Date(q.to); }
      if (q.search) where.OR = [
        { gatewayOrderId:   { contains: q.search, mode: "insensitive" } },
        { gatewayPaymentId: { contains: q.search, mode: "insensitive" } },
        { student: { user: { name: { contains: q.search, mode: "insensitive" } } } },
      ];
      const [txns, total, totalAmt] = await Promise.all([
        prisma.onlinePayment.findMany({ where, skip:(page-1)*limit, take:limit, orderBy:{initiatedAt:"desc"},
          include:{ student:{include:{user:{select:{name:true}},class:{select:{name:true}}}}, gateway:{select:{name:true,provider:true}} } }),
        prisma.onlinePayment.count({ where }),
        prisma.onlinePayment.aggregate({ where: { ...where, status: "SUCCESS" }, _sum: { amount: true } }),
      ]);
      return reply.send({ success: true, data: { txns, total, totalPages: Math.ceil(total/limit), totalAmount: Number(totalAmt._sum.amount ?? 0) } });
    }
  );

  // ─── RECONCILIATION ────────────────────────────────────────
  app.get("/admin/online-payments/reconciliation", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [unreconciled, reconData] = await Promise.all([
        prisma.onlinePayment.findMany({ where: { schoolId, status: "SUCCESS", isReconciled: false }, include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, gateway: { select: { name: true } } }, orderBy: { completedAt: "asc" } }),
        prisma.onlinePayment.groupBy({ by: ["isReconciled"], where: { schoolId, status: "SUCCESS" }, _count: true, _sum: { amount: true } }),
      ]);
      return reply.send({ success: true, data: { unreconciled, summary: reconData.map(r => ({ reconciled: r.isReconciled, count: r._count, amount: Number(r._sum.amount ?? 0) })) } });
    }
  );

  app.patch("/admin/online-payments/reconciliation/:id/mark", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      await prisma.onlinePayment.updateMany({ where: { id: parseInt(id), schoolId }, data: { isReconciled: true, reconciledAt: new Date() } });
      return reply.send({ success: true, message: "Marked as reconciled." });
    }
  );

  app.post("/admin/online-payments/reconciliation/bulk", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { from, to } = req.body as { from?: string; to?: string };
      const where: any = { schoolId, status: "SUCCESS", isReconciled: false };
      if (from || to) { where.completedAt = {}; if (from) where.completedAt.gte = new Date(from); if (to) where.completedAt.lte = new Date(to); }
      const result = await prisma.onlinePayment.updateMany({ where, data: { isReconciled: true, reconciledAt: new Date() } });
      return reply.send({ success: true, message: `${result.count} payments reconciled.` });
    }
  );

  // ─── FAILED PAYMENTS ───────────────────────────────────────
  app.get("/admin/online-payments/failed", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; from?: string; to?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId, status: { in: ["FAILED","EXPIRED"] } };
      if (q.from || q.to) { where.initiatedAt = {}; if (q.from) where.initiatedAt.gte = new Date(q.from); if (q.to) where.initiatedAt.lte = new Date(q.to); }
      const [txns, total] = await Promise.all([
        prisma.onlinePayment.findMany({ where, skip:(page-1)*limit, take:limit, orderBy:{initiatedAt:"desc"},
          include:{ student:{include:{user:{select:{name:true}},class:{select:{name:true}}}}, gateway:{select:{name:true}} } }),
        prisma.onlinePayment.count({ where }),
      ]);
      return reply.send({ success: true, data: { txns, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── REFUND CENTER ─────────────────────────────────────────
  app.get("/admin/online-payments/refunds", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const refunded = await prisma.onlinePayment.findMany({ where: { schoolId, status: { in: ["REFUNDED","PARTIAL_REFUNDED"] } }, orderBy: { refundedAt: "desc" }, take: 50, include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, gateway: { select: { name: true } } } });
      const total = await prisma.onlinePayment.aggregate({ where: { schoolId, status: { in: ["REFUNDED","PARTIAL_REFUNDED"] } }, _sum: { refundedAmount: true }, _count: true });
      return reply.send({ success: true, data: { refunded, totalRefunded: Number(total._sum.refundedAmount ?? 0), count: total._count } });
    }
  );

  // ─── SETTLEMENTS ───────────────────────────────────────────
  app.get("/admin/online-payments/settlements", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { gatewayId?: string; page?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.gatewayId) where.gatewayId = parseInt(q.gatewayId);
      const [settlements, total, summary] = await Promise.all([
        prisma.gatewaySettlement.findMany({ where, skip:(page-1)*limit, take:limit, orderBy:{settlementDate:"desc"},
          include:{ gateway:{select:{name:true,provider:true}} } }),
        prisma.gatewaySettlement.count({ where }),
        prisma.gatewaySettlement.aggregate({ where, _sum:{ settledAmount:true, gatewayFee:true, netAmount:true }, _count:true }),
      ]);
      return reply.send({ success: true, data: {
        settlements, total, totalPages: Math.ceil(total/limit),
        summary: { totalSettled: Number(summary._sum.settledAmount ?? 0), totalFees: Number(summary._sum.gatewayFee ?? 0), totalNet: Number(summary._sum.netAmount ?? 0), count: summary._count },
      }});
    }
  );

  app.post("/admin/online-payments/settlements", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { gatewayId: number; settlementId: string; settledAmount: number; gatewayFee?: number; txnCount?: number; settlementDate: string; bankRefNo?: string };
      if (!body.gatewayId || !body.settlementId || !body.settledAmount || !body.settlementDate) return reply.status(400).send({ success: false, message: "gatewayId, settlementId, settledAmount, settlementDate required." });
      const netAmount = body.settledAmount - (body.gatewayFee ?? 0);
      const s = await prisma.gatewaySettlement.create({ data: { schoolId, gatewayId: body.gatewayId, settlementId: body.settlementId, settledAmount: body.settledAmount, gatewayFee: body.gatewayFee ?? 0, netAmount, txnCount: body.txnCount ?? 0, settlementDate: new Date(body.settlementDate), bankRefNo: body.bankRefNo ?? null, status: "SETTLED" } });
      return reply.status(201).send({ success: true, data: { id: s.id } });
    }
  );

  // ─── ANALYTICS ─────────────────────────────────────────────
  app.get("/admin/online-payments/analytics", { preHandler: [authenticate, requireCapability('finance.onlinePayment')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [byGateway, byMode, successRate6m] = await Promise.all([
        prisma.paymentGateway.findMany({ where: { schoolId }, select: { id: true, name: true, provider: true, successCount: true, failureCount: true, totalVolume: true } }),
        prisma.onlinePayment.groupBy({ by: ["mode"], where: { schoolId, status: "SUCCESS" }, _sum: { amount: true }, _count: true }),
        Promise.all(Array.from({length:6},(_,i) => {
          const d1=new Date(); d1.setDate(1); d1.setMonth(d1.getMonth()-(5-i));
          const d2=new Date(d1); d2.setMonth(d2.getMonth()+1);
          return Promise.all([
            prisma.onlinePayment.count({ where:{ schoolId, status:"SUCCESS", completedAt:{gte:d1,lt:d2} } }),
            prisma.onlinePayment.count({ where:{ schoolId, status:"FAILED", initiatedAt:{gte:d1,lt:d2} } }),
          ]).then(([s,f])=>({ month:d1.toLocaleDateString("en-IN",{month:"short"}), success:s, failed:f, rate:s+f>0?((s/(s+f))*100).toFixed(1):"0" }));
        })),
      ]);
      return reply.send({ success: true, data: {
        byGateway: byGateway.map(g => ({ ...g, successRate: g.successCount+g.failureCount > 0 ? ((g.successCount/(g.successCount+g.failureCount))*100).toFixed(1) : "0", totalVolume: Number(g.totalVolume) })),
        byMode: byMode.map(m => ({ mode: m.mode, amount: Number(m._sum.amount ?? 0), count: m._count })),
        successRate6m,
      }});
    }
  );
}
