// apps/api/src/routes/student/fees-payment.ts
//
// Online Payment — same gateway-ready pattern as the Parent Fees
// module (OnlinePayment/PaymentGateway), scoped to the student's own
// account directly.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { z } from "zod";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/fees-payment] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function getStudentId(userId: number, schoolId: number): Promise<number | null> {
  const s = await safe("student lookup", () =>
    prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true } }), null);
  return s?.id ?? null;
}

// ⚠️ TODO when a real gateway is configured: replace with an actual
// call to the gateway's Order-creation API. Same placeholder pattern
// used in the Parent Fees module.
async function createGatewayOrder(gateway: any, amount: number): Promise<{ gatewayOrderId: string }> {
  return { gatewayOrderId: `PENDING-${Date.now()}` };
}

const payIntentSchema = z.object({
  installmentIds: z.array(z.number()), amount: z.number().positive(),
  mode: z.enum(["UPI", "CARD", "NB", "WALLET"]).default("UPI"),
});

export async function studentFeesPaymentRoutes(app: FastifyInstance) {

  app.get("/student/fees/gateway-status",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const gateway = await safe("gateway check", () =>
        prisma.paymentGateway.findFirst({ where: { schoolId, isActive: true, status: "ACTIVE" } }), null);
      return reply.send({ success: true, data: { gatewayAvailable: !!gateway } });
    }
  );

  app.post("/student/fees/pay-intent",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const parsed = payIntentSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });
      const { amount, mode } = parsed.data;

      const gateway = await safe("active gateway", () =>
        prisma.paymentGateway.findFirst({ where: { schoolId, isActive: true, status: "ACTIVE" }, orderBy: { isDefault: "desc" } }), null);

      if (!gateway) {
        return reply.status(400).send({
          success: false, error: "GATEWAY_NOT_CONFIGURED",
          message: "Online payment is not set up yet. Please pay at the school office.",
        });
      }

      const { gatewayOrderId } = await createGatewayOrder(gateway, amount);
      const onlinePayment = await prisma.onlinePayment.create({
        data: { schoolId, studentId: sid, gatewayId: gateway.id, gatewayOrderId, amount, currency: "INR", mode, status: "INITIATED" },
      });

      return reply.status(201).send({
        success: true, message: "Payment initiated — gateway checkout not yet wired up.",
        data: { onlinePaymentId: onlinePayment.id, gatewayOrderId, status: "INITIATED" },
      });
    }
  );

  app.get("/student/fees/payment-status/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { id } = req.params as { id: string };
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const payment = await safe("payment status", () =>
        prisma.onlinePayment.findFirst({
          where: { id: parseInt(id), schoolId, studentId: sid },
          select: { id: true, status: true, amount: true, failureReason: true, completedAt: true },
        }), null);
      if (!payment) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      return reply.send({ success: true, data: { payment } });
    }
  );
}