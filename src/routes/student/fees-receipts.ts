// apps/api/src/routes/student/fees-receipts.ts
//
// Receipts + Payment History — FeeReceipt (confirmed) + OnlinePayment
// attempts (confirmed) for full transaction transparency.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/fees-receipts] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function getStudentId(userId: number, schoolId: number): Promise<number | null> {
  const s = await safe("student lookup", () =>
    prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true } }), null);
  return s?.id ?? null;
}

export async function studentFeesReceiptsRoutes(app: FastifyInstance) {

  // ── GET /student/fees/receipts ────────────────────────────────
  app.get("/student/fees/receipts",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const receipts = await safe("receipts", () =>
        prisma.feeReceipt.findMany({
          where: { studentId: sid, schoolId, isVoid: false },
          orderBy: { createdAt: "desc" },
          select: {
            id: true, receiptNo: true, amount: true, createdAt: true, printCount: true,
            payment: { select: { method: true, transactionId: true } },
          },
        }), [] as any[]);

      return reply.send({
        success: true,
        data: {
          receipts: receipts.map((r: any) => ({
            id: r.id, receiptNo: r.receiptNo, amount: r.amount, createdAt: r.createdAt,
            printCount: r.printCount, paymentMode: r.payment?.method, transactionId: r.payment?.transactionId,
          })),
        },
      });
    }
  );

  // ── GET /student/fees/receipts/:id — detail ───────────────────
  app.get("/student/fees/receipts/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { id } = req.params as { id: string };
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const receipt = await safe("receipt detail", () =>
        prisma.feeReceipt.findFirst({
          where: { id: parseInt(id), schoolId, studentId: sid },
          include: { invoice: { include: { items: true } }, payment: true },
        }), null);
      if (!receipt) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      await safe("increment print", () =>
        prisma.feeReceipt.update({ where: { id: parseInt(id) }, data: { printCount: { increment: 1 } } }), null);

      return reply.send({ success: true, data: { receipt } });
    }
  );

  // ── GET /student/fees/payment-history — all online payment attempts ──
  app.get("/student/fees/payment-history",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const history = await safe("payment history", () =>
        prisma.onlinePayment.findMany({
          where: { studentId: sid, schoolId },
          orderBy: { initiatedAt: "desc" }, take: 30,
          select: { id: true, amount: true, mode: true, status: true, initiatedAt: true, completedAt: true, failureReason: true },
        }), [] as any[]);

      return reply.send({ success: true, data: { history } });
    }
  );
}