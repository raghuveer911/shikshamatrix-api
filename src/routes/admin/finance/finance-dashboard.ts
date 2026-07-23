// apps/api/src/routes/admin/finance-dashboard.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminFinanceDashboardRoutes(app: FastifyInstance) {

  // ─── GET /admin/finance/dashboard ─────────────────────────
  app.get("/admin/finance/dashboard", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const yearStart  = new Date(now.getFullYear(), 0, 1);

      const [
        totalStudents,
        collectedAll,
        paidToday,
        onlineTotal,
        pendingInvoices,
        overdueInvoices,
        discountTotal,
        fineCollected,
        refundTotal,
        byPaymentMode,
        recentPayments,
        classWise,
        alerts,
      ] = await Promise.all([
        // Total active students
        prisma.student.count({ where: { schoolId, isActive: true } }),

        // Total collected (all time, current year)
        prisma.payment.aggregate({
          where: { invoice: { schoolId, academicYear: { startDate: { gte: yearStart } } } },
          _sum: { amount: true },
        }),

        // Collected today
        prisma.payment.aggregate({
          where: { invoice: { schoolId }, paidAt: { gte: todayStart } },
          _sum: { amount: true },
        }),

        // Online collections (UPI + ONLINE + BANK_TRANSFER this month)
        prisma.payment.aggregate({
          where: { invoice: { schoolId }, method: { in: ["UPI","ONLINE","BANK_TRANSFER"] }, paidAt: { gte: monthStart } },
          _sum: { amount: true },
        }),

        // Pending invoices amount
        prisma.invoice.aggregate({
          where: { schoolId, status: { in: ["PENDING","PARTIAL"] } },
          _sum: { dueAmount: true }, _count: true,
        }),

        // Overdue invoices
        prisma.invoice.aggregate({
          where: { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] }, dueDate: { lt: now } },
          _sum: { dueAmount: true }, _count: true,
        }),

        // Total discounts given
        prisma.feeDiscount.aggregate({
          where: { schoolId, isActive: true },
          _sum: { value: true },
        }),

        // Fines collected
        prisma.feeFine.aggregate({
          where: { schoolId, isPaid: true },
          _sum: { amount: true },
        }),

        // Refunds processed
        prisma.feeRefund.aggregate({
          where: { schoolId, status: "PROCESSED" },
          _sum: { amount: true },
        }),

        // By payment mode (this month)
        prisma.payment.groupBy({
          by: ["method"],
          where: { invoice: { schoolId }, paidAt: { gte: monthStart } },
          _sum: { amount: true },
          _count: true,
        }),

        // Recent 10 transactions
        prisma.payment.findMany({
          where: { invoice: { schoolId } },
          orderBy: { paidAt: "desc" },
          take: 10,
          include: {
            invoice: {
              include: { student: { include: { user: { select: { name: true } } } } },
            },
            receivedBy: { select: { name: true } },
          },
        }),

        // Class-wise collection (top 8 classes)
        prisma.$queryRaw<{ classId: number; className: string; collected: number; due: number }[]>`
          SELECT
            c.id AS "classId",
            CONCAT(c.name) AS "className",
            COALESCE(SUM(p.amount), 0) AS collected,
            COALESCE(SUM(i."dueAmount"), 0) AS due
          FROM classes c
          LEFT JOIN students s ON s."classId" = c.id AND s."schoolId" = ${schoolId}
          LEFT JOIN invoices i ON i."studentId" = s.id AND i."schoolId" = ${schoolId}
          LEFT JOIN payments p ON p."invoiceId" = i.id
          WHERE c."schoolId" = ${schoolId} AND c."isActive" = true
          GROUP BY c.id, c.name
          ORDER BY collected DESC
          LIMIT 8
        `.catch(() => [] as any[]),

        // Alerts
        Promise.all([
          prisma.invoice.count({ where: { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] }, dueDate: { lt: now } } }),
          prisma.payment.count({ where: { invoice: { schoolId }, method: "CHEQUE", paidAt: { gte: monthStart } } }),
          prisma.feeRefund.count({ where: { schoolId, status: { in: ["REQUESTED","UNDER_REVIEW"] } } }),
        ]),
      ]);

      // 6-month revenue trend
      const trend: { label: string; collected: number; pending: number }[] = [];
      for (let i = 5; i >= 0; i--) {
        const d1 = new Date(); d1.setDate(1); d1.setMonth(d1.getMonth() - i);
        const d2 = new Date(d1); d2.setMonth(d2.getMonth() + 1);
        const [col, pen] = await Promise.all([
          prisma.payment.aggregate({ where: { invoice: { schoolId }, paidAt: { gte: d1, lt: d2 } }, _sum: { amount: true } }),
          prisma.invoice.aggregate({ where: { schoolId, issuedDate: { gte: d1, lt: d2 }, status: { not: "CANCELLED" } }, _sum: { dueAmount: true } }),
        ]);
        trend.push({
          label: d1.toLocaleDateString("en-IN", { month: "short", year: "2-digit" }),
          collected: Number(col._sum.amount ?? 0),
          pending:   Number(pen._sum.dueAmount ?? 0),
        });
      }

      return reply.send({ success: true, data: {
        kpi: {
          totalStudents,
          feesCollected:   Number(collectedAll._sum.amount ?? 0),
          feesPending:     Number(pendingInvoices._sum.dueAmount ?? 0),
          pendingCount:    pendingInvoices._count,
          collectionToday: Number(paidToday._sum.amount ?? 0),
          overdueAmount:   Number(overdueInvoices._sum.dueAmount ?? 0),
          overdueCount:    overdueInvoices._count,
          onlineCollections: Number(onlineTotal._sum.amount ?? 0),
          discountsGiven:  Number(discountTotal._sum.value ?? 0),
          finesCollected:  Number(fineCollected._sum.amount ?? 0),
          refundsProcessed: Number(refundTotal._sum.amount ?? 0),
        },
        trend,
        byPaymentMode: byPaymentMode.map(b => ({ mode: b.method, amount: Number(b._sum.amount ?? 0), count: b._count })),
        classWise: Array.isArray(classWise) ? classWise.map(c => ({ ...c, collected: Number(c.collected), due: Number(c.due) })) : [],
        recentPayments: recentPayments.map(p => ({
          receiptNo: p.receiptNumber,
          studentName: p.invoice.student?.user.name,
          amount: Number(p.amount),
          mode: p.method,
          paidAt: p.paidAt,
          paidBy: p.receivedBy?.name,
        })),
        alerts: {
          overdueStudents: alerts[0],
          chequePending:   alerts[1],
          refundRequests:  alerts[2],
        },
      }});
    }
  );

  // ─── GET /admin/finance/dashboard/class-collection ────────
  app.get("/admin/finance/dashboard/class-collection", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { academicYearId?: string };
      const where: any = { schoolId };
      if (q.academicYearId) where.academicYearId = parseInt(q.academicYearId);

      const classes = await prisma.class.findMany({ where: { schoolId, isActive: true }, select: { id: true, name: true } });
      const result = await Promise.all(classes.map(async cls => {
        const [collected, pending] = await Promise.all([
          prisma.payment.aggregate({ where: { invoice: { ...where, student: { classId: cls.id } } }, _sum: { amount: true } }),
          prisma.invoice.aggregate({ where: { ...where, student: { classId: cls.id }, status: { not: "CANCELLED" } }, _sum: { dueAmount: true } }),
        ]);
        return { classId: cls.id, className: cls.name, collected: Number(collected._sum.amount ?? 0), pending: Number(pending._sum.dueAmount ?? 0) };
      }));
      return reply.send({ success: true, data: { classes: result.sort((a,b) => b.collected - a.collected) } });
    }
  );

  // ─── GET /admin/finance/dashboard/collection-by-date ──────
  app.get("/admin/finance/dashboard/collection-by-date", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string };
      const from = q.from ? new Date(q.from) : new Date(new Date().setDate(1));
      const to   = q.to   ? new Date(q.to)   : new Date();

      const data = await prisma.$queryRaw<{ day: string; amount: number }[]>`
        SELECT
          DATE("paidAt") AS day,
          SUM(p.amount) AS amount
        FROM payments p
        JOIN invoices i ON p."invoiceId" = i.id
        WHERE i."schoolId" = ${schoolId}
          AND p."paidAt" >= ${from}
          AND p."paidAt" <= ${to}
        GROUP BY DATE("paidAt")
        ORDER BY day ASC
      `.catch(() => []);

      return reply.send({ success: true, data: { dailyCollection: Array.isArray(data) ? data.map(d => ({ day: d.day, amount: Number(d.amount) })) : [] } });
    }
  );

  // ─── GET /admin/finance/academic-years ────────────────────
  app.get("/admin/finance/academic-years", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const years = await prisma.academicYear.findMany({ where: { schoolId }, orderBy: { startDate: "desc" } });
      return reply.send({ success: true, data: { years } });
    }
  );
}
