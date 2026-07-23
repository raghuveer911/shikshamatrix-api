import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { z } from "zod";

const collectSchema = z.object({
  studentId:      z.number(),
  installmentIds: z.array(z.number()).min(1),
  amount:         z.number().positive(),
  paymentMode:    z.enum(["CASH", "UPI", "CHEQUE", "NEFT", "CARD", "DD"]),
  transactionRef: z.string().optional(),
  remarks:        z.string().optional(),
});

export async function financeCollectRoutes(app: FastifyInstance) {

  // ── POST /finance/collect — Collect fee ─────────────────────
  app.post("/finance/collect",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req as any;

      const parsed = collectSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.errors[0]?.message,
        });
      }

      const { studentId, installmentIds, amount, paymentMode, transactionRef, remarks } =
        parsed.data;

      // Fetch installments to validate
      const installments = await prisma.studentFeeInstallment.findMany({
        where: {
          id:        { in: installmentIds },
          studentId,
          schoolId,
          status:    { notIn: ["PAID"] },
        },
      });

      if (installments.length === 0) {
        return reply.status(400).send({ success: false, error: "NO_PENDING_INSTALLMENTS" });
      }

      const totalDue = installments.reduce(
        (sum, i) => sum + (Number(i.dueAmount) - Number(i.paidAmount)), 0
      );

      // Create Invoice + Payment + Receipt in transaction
      const result = await prisma.$transaction(async (tx) => {
        // Generate receipt number
        const count = await tx.feeReceipt.count({ where: { schoolId } });
        const receiptNo = `RCP${schoolId}-${String(count + 1).padStart(5, "0")}`;

        // Create Invoice
        const invoice = await tx.invoice.create({
          data: {
            schoolId,
            studentId,
            invoiceNo:   `INV${schoolId}-${String(count + 1).padStart(5, "0")}`,
            amount,
            status:      "PAID",
            invoiceType: "FEE",
            createdById: userId,
          },
        });

        // Create Payment
        const payment = await tx.payment.create({
          data: {
            schoolId,
            studentId,
            invoiceId:     invoice.id,
            amount,
            paymentMode,
            transactionRef: transactionRef ?? null,
            remarks:        remarks ?? null,
            status:         "SUCCESS",
            collectedById:  userId,
          },
        });

        // Create Receipt
        const receipt = await tx.feeReceipt.create({
          data: {
            schoolId,
            receiptNo,
            invoiceId:  invoice.id,
            paymentId:  payment.id,
            studentId,
            amount,
          },
        });

        // Update installments — distribute payment
        let remaining = amount;
        for (const inst of installments) {
          if (remaining <= 0) break;
          const instDue = Number(inst.dueAmount) - Number(inst.paidAmount);
          const toPay   = Math.min(remaining, instDue);
          remaining    -= toPay;

          const newPaid = Number(inst.paidAmount) + toPay;
          const isPaid  = newPaid >= Number(inst.dueAmount);

          await tx.studentFeeInstallment.update({
            where: { id: inst.id },
            data: {
              paidAmount: newPaid,
              status:     isPaid ? "PAID" : "PARTIAL",
              paidAt:     isPaid ? new Date() : undefined,
            },
          });
        }

        // Update StudentFeePlan totals
        await tx.studentFeePlan.updateMany({
          where: { studentId, schoolId, isActive: true },
          data: {
            paidAmount: { increment: amount },
            dueAmount:  { decrement: amount },
          },
        });

        return receipt;
      });

      // Fetch full receipt for response
      const fullReceipt = await prisma.feeReceipt.findUnique({
        where: { id: result.id },
        include: {
          student: {
            select: {
              admissionNo: true,
              rollNumber:  true,
              user:  { select: { name: true, phone: true } },
              class: { select: { name: true, section: true } },
            },
          },
          invoice: {
            select: { invoiceNo: true, invoiceType: true },
          },
          payment: {
            select: { paymentMode: true, transactionRef: true, remarks: true },
          },
        },
      });

      return reply.status(201).send({
        success: true,
        message: `Fee of ₹${amount} collected successfully`,
        data:    { receipt: fullReceipt },
      });
    }
  );

  // ── GET /finance/receipt/:id — Receipt detail ───────────────
  app.get("/finance/receipt/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };

      const receipt = await prisma.feeReceipt.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          student: {
            select: {
              admissionNo: true,
              rollNumber:  true,
              user:  { select: { name: true, phone: true } },
              class: { select: { name: true, section: true } },
            },
          },
          invoice: {
            select: { invoiceNo: true, invoiceType: true },
          },
          payment: {
            select: {
              paymentMode:    true,
              transactionRef: true,
              remarks:        true,
              createdAt:      true,
            },
          },
        },
      });

      if (!receipt) {
        return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      }

      return reply.send({ success: true, data: { receipt } });
    }
  );
}
