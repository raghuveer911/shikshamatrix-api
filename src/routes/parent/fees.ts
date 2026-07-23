// apps/api/src/routes/parent/fees.ts
//
// FULL ENHANCEMENT — Parent Fees module, best-ERP scope.
//
// ⚠️ No payment gateway is configured yet (confirmed). The online-pay
// flow is built GATEWAY-READY: it creates a proper OnlinePayment
// record (status INITIATED) and checks for an active PaymentGateway,
// but the actual "call the gateway's API to create an order" step is
// a clearly marked TODO function (createGatewayOrder). Wire that one
// function when a real gateway (Razorpay/PayU/etc.) is set up — no
// other changes needed elsewhere in this flow.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { z } from "zod";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[parent/fees] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function verifyParentChild(parentUserId: number, studentRecordId: number, schoolId: number): Promise<boolean> {
  const student = await safe("verifyParentChild: student", () =>
    prisma.student.findFirst({ where: { id: studentRecordId, schoolId }, select: { userId: true } }), null);
  if (!student) return false;
  const link = await safe("verifyParentChild: link", () =>
    prisma.parentStudent.findFirst({ where: { parentId: parentUserId, studentId: student.userId } }), null);
  return !!link;
}

// ⚠️ TODO when a real gateway is configured: replace this with an
// actual API call to the gateway (e.g. Razorpay Orders API) using
// gateway.apiKey/apiSecret, and return its real order id.
// For now it just generates a placeholder so the OnlinePayment
// record and UI flow are fully wired and testable end-to-end.
async function createGatewayOrder(gateway: any, amount: number, currency: string): Promise<{ gatewayOrderId: string }> {
  return { gatewayOrderId: `PENDING-${Date.now()}` };
}

const payIntentSchema = z.object({
  studentId: z.number(),
  installmentIds: z.array(z.number()),
  amount: z.number().positive(),
  mode: z.enum(["UPI", "CARD", "NB", "WALLET"]).default("UPI"),
});

const refundRequestSchema = z.object({
  receiptId: z.number(),
  amount: z.number().positive(),
  reason: z.string().min(5),
});

export async function parentFeesRoutes(app: FastifyInstance) {

  // ══════════════════════════════════════════════════════════
  // GET /parent/fees — full summary with discounts/fines/scholarships
  // ══════════════════════════════════════════════════════════
  app.get("/parent/fees",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { studentId } = req.query as { studentId: string };
      const sid = parseInt(studentId);

      if (!(await verifyParentChild(userId, sid, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      const [feePlan, receipts, discounts, fines, scholarships, onlineHistory, refunds, activeGateway] = await Promise.all([
        safe("studentFeePlan.findFirst", () =>
          prisma.studentFeePlan.findFirst({
            where: { studentId: sid, isActive: true },
            include: {
              plan: { select: { name: true } },
              installments: { include: { installment: true }, orderBy: { dueDate: "asc" } },
            },
          }), null),

        safe("feeReceipt.findMany", () =>
          prisma.feeReceipt.findMany({
            where: { studentId: sid, isVoid: false },
            orderBy: { createdAt: "desc" }, take: 15,
            select: {
              id: true, receiptNo: true, amount: true, createdAt: true, printCount: true,
              payment: { select: { method: true, transactionId: true } },
            },
          }), [] as any[]),

        safe("feeDiscount.findMany", () =>
          prisma.feeDiscount.findMany({
            where: { studentId: sid, isActive: true },
            select: {
              id: true, name: true, discountType: true, category: true, value: true,
              applicableHeads: true, remarks: true, approvedAt: true,
            },
          }), [] as any[]),

        safe("feeFine.findMany", () =>
          prisma.feeFine.findMany({
            where: { studentId: sid },
            orderBy: { createdAt: "desc" },
            select: { id: true, fineNo: true, reason: true, fineType: true, amount: true, isPaid: true, waived: true, createdAt: true },
          }), [] as any[]),

        safe("studentScholarship.findMany", () =>
          prisma.studentScholarship.findMany({
            where: { studentId: sid, isActive: true },
            select: {
              id: true, name: true, discountType: true, discountValue: true,
              originalFee: true, benefitAmount: true, finalFee: true,
              status: true, validFrom: true, validUntil: true,
              program: { select: { name: true } },
            },
          }), [] as any[]),

        safe("onlinePayment.findMany", () =>
          prisma.onlinePayment.findMany({
            where: { studentId: sid },
            orderBy: { initiatedAt: "desc" }, take: 10,
            select: { id: true, amount: true, mode: true, status: true, initiatedAt: true, completedAt: true, failureReason: true },
          }), [] as any[]),

        safe("feeRefund.findMany", () =>
          prisma.feeRefund.findMany({
            where: { studentId: sid },
            orderBy: { createdAt: "desc" }, take: 10,
            select: { id: true, refundNo: true, amount: true, reason: true, status: true, rejectedReason: true, createdAt: true },
          }), [] as any[]),

        safe("paymentGateway: any active", () =>
          prisma.paymentGateway.findFirst({ where: { schoolId, isActive: true, status: "ACTIVE" } }), null),
      ]);

      return reply.send({
        success: true,
        data: {
          summary: feePlan ? {
            planName: feePlan.plan.name,
            totalAmount: feePlan.totalAmount, paidAmount: feePlan.paidAmount,
            dueAmount: feePlan.dueAmount, discountAmount: feePlan.discountAmount,
          } : null,
          installments: feePlan?.installments.map((i: any) => ({
            id: i.id, name: i.installment.name, dueDate: i.dueDate,
            dueAmount: i.dueAmount, paidAmount: i.paidAmount,
            fineAmount: i.fineAmount, discountAmount: i.discountAmount,
            netDue: Number(i.dueAmount) + Number(i.fineAmount) - Number(i.discountAmount) - Number(i.paidAmount),
            status: i.status, isOverdue: i.status !== "PAID" && i.status !== "WAIVED" && new Date(i.dueDate) < new Date(),
          })) ?? [],
          receipts: receipts.map((r: any) => ({
            id: r.id, receiptNo: r.receiptNo, amount: r.amount, createdAt: r.createdAt,
            printCount: r.printCount, paymentMode: r.payment?.method, transactionId: r.payment?.transactionId,
          })),
          discounts: discounts.map((d: any) => ({
            id: d.id, name: d.name, discountType: d.discountType, category: d.category,
            value: d.value, applicableHeads: d.applicableHeads, remarks: d.remarks,
            isApproved: !!d.approvedAt,
          })),
          fines: fines.map((f: any) => ({
            id: f.id, fineNo: f.fineNo, reason: f.reason, fineType: f.fineType,
            amount: f.amount, isPaid: f.isPaid, waived: f.waived, createdAt: f.createdAt,
          })),
          scholarships: scholarships.map((s: any) => ({
            id: s.id, name: s.name, programName: s.program?.name ?? null,
            discountType: s.discountType, discountValue: s.discountValue,
            originalFee: s.originalFee, benefitAmount: s.benefitAmount, finalFee: s.finalFee,
            status: s.status, validFrom: s.validFrom, validUntil: s.validUntil,
          })),
          onlinePaymentHistory: onlineHistory,
          refunds,
          gatewayAvailable: !!activeGateway,
        },
      });
    }
  );

  // ══════════════════════════════════════════════════════════
  // POST /parent/fees/pay-intent — initiate online payment
  // ══════════════════════════════════════════════════════════
  app.post("/parent/fees/pay-intent",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const parsed = payIntentSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });
      const { studentId, amount, mode } = parsed.data;

      if (!(await verifyParentChild(userId, studentId, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      const gateway = await safe("active gateway lookup", () =>
        prisma.paymentGateway.findFirst({ where: { schoolId, isActive: true, status: "ACTIVE" }, orderBy: { isDefault: "desc" } }), null);

      if (!gateway) {
        return reply.status(400).send({
          success: false, error: "GATEWAY_NOT_CONFIGURED",
          message: "Online payment is not set up yet for this school. Please pay at the school office.",
        });
      }

      const { gatewayOrderId } = await createGatewayOrder(gateway, amount, "INR");

      const onlinePayment = await prisma.onlinePayment.create({
        data: {
          schoolId, studentId, gatewayId: gateway.id,
          gatewayOrderId, amount, currency: "INR", mode,
          status: "INITIATED",
        },
      });

      // ⚠️ Once a real gateway is wired, return whatever data its SDK
      // needs on the frontend to open checkout (e.g. order id, key,
      // amount) instead of this placeholder message.
      return reply.status(201).send({
        success: true,
        message: "Payment initiated — gateway checkout not yet wired up.",
        data: { onlinePaymentId: onlinePayment.id, gatewayOrderId, status: "INITIATED" },
      });
    }
  );

  // ── GET /parent/fees/payment-status/:id — poll online payment status ──
  app.get("/parent/fees/payment-status/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { id } = req.params as { id: string };

      const payment = await prisma.onlinePayment.findFirst({
        where: { id: parseInt(id), schoolId },
        select: { id: true, studentId: true, status: true, amount: true, failureReason: true, completedAt: true },
      });
      if (!payment) return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      if (!(await verifyParentChild(userId, payment.studentId, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      return reply.send({ success: true, data: { payment } });
    }
  );

  // ══════════════════════════════════════════════════════════
  // POST /parent/fees/refund-request
  // ══════════════════════════════════════════════════════════
  app.post("/parent/fees/refund-request",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const parsed = refundRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });
      const { receiptId, amount, reason } = parsed.data;

      const receipt = await prisma.feeReceipt.findFirst({
        where: { id: receiptId, schoolId },
        select: { studentId: true, invoiceId: true, amount: true },
      });
      if (!receipt) return reply.status(404).send({ success: false, error: "RECEIPT_NOT_FOUND" });
      if (!(await verifyParentChild(userId, receipt.studentId, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      if (amount > Number(receipt.amount)) {
        return reply.status(400).send({ success: false, error: "AMOUNT_EXCEEDS_RECEIPT", message: "Refund amount cannot exceed the receipt amount." });
      }

      const refundNo = `REF-${Date.now()}`;
      const refund = await prisma.feeRefund.create({
        data: {
          schoolId, refundNo, studentId: receipt.studentId, invoiceId: receipt.invoiceId,
          amount, reason, status: "REQUESTED",
        },
      });

      return reply.status(201).send({ success: true, message: "Refund request submitted", data: { id: refund.id } });
    }
  );

  // ── PATCH /parent/fees/receipts/:id/print — increment print/view count ──
  app.patch("/parent/fees/receipts/:id/print",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      await safe("printCount increment", () =>
        prisma.feeReceipt.update({ where: { id: parseInt(id) }, data: { printCount: { increment: 1 } } }), null);
      return reply.send({ success: true });
    }
  );
}