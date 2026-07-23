import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";

export async function financeOverviewRoutes(app: FastifyInstance) {

  app.get("/finance/overview",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;

      const today      = new Date();
      const todayStart = new Date(today); todayStart.setHours(0,0,0,0);
      const todayEnd   = new Date(today); todayEnd.setHours(23,59,59,999);
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

      try {
        // Today's collection via FeeReceipt
        const [todayReceipts, monthReceipts, totalDue, overdueInstallments] =
          await Promise.all([
            prisma.feeReceipt.aggregate({
              where: {
                schoolId,
                isVoid: false,
                createdAt: { gte: todayStart, lte: todayEnd },
              },
              _sum: { amount: true },
              _count: true,
            }),
            prisma.feeReceipt.aggregate({
              where: {
                schoolId,
                isVoid: false,
                createdAt: { gte: monthStart, lte: todayEnd },
              },
              _sum: { amount: true },
              _count: true,
            }),
            prisma.studentFeeInstallment.aggregate({
              where: {
                schoolId,
                status: { in: ["PENDING", "OVERDUE", "PARTIAL"] },
              },
              _sum: { dueAmount: true },
              _count: true,
            }),
            prisma.studentFeeInstallment.count({
              where: {
                schoolId,
                status: "OVERDUE",
                dueDate: { lt: todayStart },
              },
            }),
          ]);

        return reply.send({
          success: true,
          data: {
            today: {
              collection: todayReceipts._sum.amount ?? 0,
              txnCount:   todayReceipts._count,
            },
            month: {
              collection: monthReceipts._sum.amount ?? 0,
              txnCount:   monthReceipts._count,
            },
            pending: {
              amount:     totalDue._sum.dueAmount ?? 0,
              students:   totalDue._count,
              overdue:    overdueInstallments,
            },
          },
        });
      } catch (err) {
        console.error(err);
        return reply.status(500).send({ success: false, error: "SERVER_ERROR" });
      }
    }
  );

  // ── GET /finance/transactions — Recent payments ─────────────
  app.get("/finance/transactions",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { page = "1", limit = "20", date } =
        req.query as Record<string, string>;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const where: any = { schoolId, isVoid: false };

      if (date) {
        const d = new Date(date);
        const s = new Date(d); s.setHours(0,0,0,0);
        const e = new Date(d); e.setHours(23,59,59,999);
        where.createdAt = { gte: s, lte: e };
      }

      const [receipts, total] = await Promise.all([
        prisma.feeReceipt.findMany({
          where,
          skip,
          take: parseInt(limit),
          orderBy: { createdAt: "desc" },
          select: {
            id:        true,
            receiptNo: true,
            amount:    true,
            createdAt: true,
            student: {
              select: {
                admissionNo: true,
                user: { select: { name: true } },
                class: { select: { name: true, section: true } },
              },
            },
          },
        }),
        prisma.feeReceipt.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: {
          transactions: receipts.map((r) => ({
            id:          r.id,
            receiptNo:   r.receiptNo,
            amount:      r.amount,
            createdAt:   r.createdAt,
            studentName: r.student.user.name,
            admissionNo: r.student.admissionNo,
            class:       `${r.student.class?.name ?? "—"} ${r.student.class?.section ?? ""}`,
          })),
          pagination: {
            total,
            page:       parseInt(page),
            totalPages: Math.ceil(total / parseInt(limit)),
          },
        },
      });
    }
  );
}
