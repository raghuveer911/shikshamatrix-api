// apps/api/src/routes/admin/finance/finance-dashboard.ts
//
// FIXED — same root cause as the fee-collection.ts fix: every "due /
// pending / overdue" figure here was computed from Invoice.dueAmount,
// but Invoice rows only exist for transactions that have actually
// happened. A student who was assigned a fee plan but hasn't paid
// anything yet has ZERO Invoice rows — so they contributed nothing to
// "Fees Pending" even though they may owe the most. That's why this
// dashboard showed ₹6K pending and most classes at ₹0/₹0, while the
// main Dashboard (which already read StudentFeeInstallment correctly)
// showed the real number, ₹3,88,000, for the same school.
//
// FIX: every due/pending/overdue figure now sources from
// StudentFeeInstallment / StudentFeePlan — the real per-installment
// ledger — matching what fee-collection.ts writes to and what the
// main dashboard already reads. "Collected" figures keep reading from
// Payment/FeeReceipt, which — unlike Invoice — really are created for
// every real transaction, so those were never the problem.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log("[finance-dashboard]", err?.message ?? err); return fallback; }
}

/** dueAmount + fineAmount - discountAmount - paidAmount, floored at 0 —
 *  the same "net still owed" formula used everywhere else in Finance. */
function netDue(agg: { dueAmount: any; paidAmount: any; fineAmount: any; discountAmount: any }) {
  return Math.max(0, Number(agg.dueAmount ?? 0) + Number(agg.fineAmount ?? 0) - Number(agg.discountAmount ?? 0) - Number(agg.paidAmount ?? 0));
}

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
        dueAgg,
        overdueAgg,
        overduePlanCount,
        pendingPlanCount,
        discountTotal,
        fineCollected,
        refundTotal,
        byPaymentMode,
        recentPayments,
        classWise,
        alerts,
      ] = await Promise.all([
        // Total active students
        safe(() => prisma.student.count({ where: { schoolId, isActive: true } }), 0),

        // Total collected (all time, current year) — real transactions, Payment is fine
        safe(() => prisma.payment.aggregate({
          where: { invoice: { schoolId, academicYear: { startDate: { gte: yearStart } } } },
          _sum: { amount: true },
        }), { _sum: { amount: null } } as any),

        // Collected today
        safe(() => prisma.payment.aggregate({
          where: { invoice: { schoolId }, paidAt: { gte: todayStart } },
          _sum: { amount: true },
        }), { _sum: { amount: null } } as any),

        // Online collections (UPI + ONLINE + BANK_TRANSFER this month)
        safe(() => prisma.payment.aggregate({
          where: { invoice: { schoolId }, method: { in: ["UPI","ONLINE","BANK_TRANSFER"] }, paidAt: { gte: monthStart } },
          _sum: { amount: true },
        }), { _sum: { amount: null } } as any),

        // FIXED: total still owed across every unpaid/partial installment —
        // this is the real "Fees Pending" figure, not Invoice.dueAmount.
        safe(() => prisma.studentFeeInstallment.aggregate({
          where: { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] }, studentPlan: { isActive: true } },
          _sum: { dueAmount: true, paidAmount: true, fineAmount: true, discountAmount: true },
        }), { _sum: { dueAmount: null, paidAmount: null, fineAmount: null, discountAmount: null } } as any),

        // FIXED: overdue = past due date and not fully settled — same source.
        safe(() => prisma.studentFeeInstallment.aggregate({
          where: { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] }, dueDate: { lt: now }, studentPlan: { isActive: true } },
          _sum: { dueAmount: true, paidAmount: true, fineAmount: true, discountAmount: true },
        }), { _sum: { dueAmount: null, paidAmount: null, fineAmount: null, discountAmount: null } } as any),

        // Distinct students overdue (for the alert count) rather than
        // installment count — "3 students have overdue fees" reads better
        // than "3 installments", and matches how the banner phrases it.
        safe(async () => {
          const rows = await prisma.studentFeeInstallment.findMany({
            where: { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] }, dueDate: { lt: now }, studentPlan: { isActive: true } },
            select: { studentId: true }, distinct: ["studentId"],
          });
          return rows.length;
        }, 0),

        safe(async () => {
          const rows = await prisma.studentFeeInstallment.findMany({
            where: { schoolId, status: { in: ["PENDING","PARTIAL"] }, studentPlan: { isActive: true } },
            select: { studentId: true }, distinct: ["studentId"],
          });
          return rows.length;
        }, 0),

        // Total discounts given
        safe(() => prisma.feeDiscount.aggregate({
          where: { schoolId, isActive: true },
          _sum: { value: true },
        }), { _sum: { value: null } } as any),

        // Fines collected
        safe(() => prisma.feeFine.aggregate({
          where: { schoolId, isPaid: true },
          _sum: { amount: true },
        }), { _sum: { amount: null } } as any),

        // Refunds processed
        safe(() => prisma.feeRefund.aggregate({
          where: { schoolId, status: "PROCESSED" },
          _sum: { amount: true },
        }), { _sum: { amount: null } } as any),

        // By payment mode (this month)
        safe(() => prisma.payment.groupBy({
          by: ["method"],
          where: { invoice: { schoolId }, paidAt: { gte: monthStart } },
          _sum: { amount: true },
          _count: true,
        }), [] as any[]),

        // Recent 10 transactions
        safe(() => prisma.payment.findMany({
          where: { invoice: { schoolId } },
          orderBy: { paidAt: "desc" },
          take: 10,
          include: {
            invoice: {
              include: { student: { include: { user: { select: { name: true } } } } },
            },
            receivedBy: { select: { name: true } },
          },
        }), [] as any[]),

        // FIXED: class-wise collected vs due, now via
        // StudentFeeInstallment so a class full of students who
        // haven't paid yet still shows its real due amount instead of
        // ₹0 (Invoice rows didn't exist for them at all before).
        safe(() => prisma.$queryRaw<{ classId: number; className: string; collected: number; due: number }[]>`
          SELECT
            c.id AS "classId",
            c.name AS "className",
            COALESCE(pay.collected, 0) AS collected,
            COALESCE(inst.due, 0) AS due
          FROM classes c
          LEFT JOIN (
            SELECT s."classId" AS "classId", SUM(p.amount) AS collected
            FROM payments p
            JOIN invoices i ON i.id = p."invoiceId"
            JOIN students s ON s.id = i."studentId"
            WHERE i."schoolId" = ${schoolId}
            GROUP BY s."classId"
          ) pay ON pay."classId" = c.id
          LEFT JOIN (
            SELECT s."classId" AS "classId",
              SUM(GREATEST(0, sfi."dueAmount" + sfi."fineAmount" - sfi."discountAmount" - sfi."paidAmount")) AS due
            FROM student_fee_installments sfi
            JOIN students s ON s.id = sfi."studentId"
            JOIN student_fee_plans sfp ON sfp.id = sfi."studentPlanId" AND sfp."isActive" = true
            WHERE sfi."schoolId" = ${schoolId} AND sfi.status IN ('PENDING','PARTIAL','OVERDUE')
            GROUP BY s."classId"
          ) inst ON inst."classId" = c.id
          WHERE c."schoolId" = ${schoolId} AND c."isActive" = true
          ORDER BY due DESC, collected DESC
          LIMIT 8
        `, [] as any[]),

        // Alerts
        Promise.all([
          safe(async () => {
            const rows = await prisma.studentFeeInstallment.findMany({
              where: { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] }, dueDate: { lt: now }, studentPlan: { isActive: true } },
              select: { studentId: true }, distinct: ["studentId"],
            });
            return rows.length;
          }, 0),
          safe(() => prisma.payment.count({ where: { invoice: { schoolId }, method: "CHEQUE", paidAt: { gte: monthStart } } }), 0),
          safe(() => prisma.feeRefund.count({ where: { schoolId, status: { in: ["REQUESTED","UNDER_REVIEW"] } } }), 0),
        ]),
      ]);

      // 6-month revenue trend — collected stays Payment-based (real
      // transactions that happened in that month); pending is now the
      // installments that fell due in that month, same fixed source.
      const trend: { label: string; collected: number; pending: number }[] = [];
      for (let i = 5; i >= 0; i--) {
        const d1 = new Date(); d1.setDate(1); d1.setMonth(d1.getMonth() - i); d1.setHours(0,0,0,0);
        const d2 = new Date(d1); d2.setMonth(d2.getMonth() + 1);
        const [col, pen] = await Promise.all([
          safe(() => prisma.payment.aggregate({ where: { invoice: { schoolId }, paidAt: { gte: d1, lt: d2 } }, _sum: { amount: true } }), { _sum: { amount: null } } as any),
          safe(() => prisma.studentFeeInstallment.aggregate({
            where: { schoolId, dueDate: { gte: d1, lt: d2 }, studentPlan: { isActive: true } },
            _sum: { dueAmount: true, paidAmount: true, fineAmount: true, discountAmount: true },
          }), { _sum: { dueAmount: null, paidAmount: null, fineAmount: null, discountAmount: null } } as any),
        ]);
        trend.push({
          label: d1.toLocaleDateString("en-IN", { month: "short", year: "2-digit" }),
          collected: Number(col._sum.amount ?? 0),
          pending: netDue(pen._sum),
        });
      }

      const feesPending = netDue(dueAgg._sum);
      const overdueAmount = netDue(overdueAgg._sum);

      return reply.send({ success: true, data: {
        kpi: {
          totalStudents,
          feesCollected:   Number(collectedAll._sum.amount ?? 0),
          feesPending,
          pendingCount:    pendingPlanCount,
          collectionToday: Number(paidToday._sum.amount ?? 0),
          overdueAmount,
          overdueCount:    overduePlanCount,
          onlineCollections: Number(onlineTotal._sum.amount ?? 0),
          discountsGiven:  Number(discountTotal._sum.value ?? 0),
          finesCollected:  Number(fineCollected._sum.amount ?? 0),
          refundsProcessed: Number(refundTotal._sum.amount ?? 0),
        },
        trend,
        byPaymentMode: byPaymentMode.map((b: any) => ({ mode: b.method, amount: Number(b._sum.amount ?? 0), count: b._count })),
        classWise: Array.isArray(classWise) ? classWise.map((c: any) => ({ ...c, collected: Number(c.collected), due: Number(c.due) })) : [],
        recentPayments: recentPayments.map((p: any) => ({
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
  // FIXED: same Invoice→StudentFeeInstallment swap for "pending".
  app.get("/admin/finance/dashboard/class-collection", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { academicYearId?: string };

      const classes = await prisma.class.findMany({ where: { schoolId, isActive: true }, select: { id: true, name: true } });
      const result = await Promise.all(classes.map(async cls => {
        const [collected, pending] = await Promise.all([
          safe(() => prisma.payment.aggregate({ where: { invoice: { schoolId, student: { classId: cls.id } } }, _sum: { amount: true } }), { _sum: { amount: null } } as any),
          safe(() => prisma.studentFeeInstallment.aggregate({
            where: {
              schoolId, student: { classId: cls.id }, status: { in: ["PENDING","PARTIAL","OVERDUE"] },
              studentPlan: { isActive: true, ...(q.academicYearId ? { academicYearId: parseInt(q.academicYearId) } : {}) },
            },
            _sum: { dueAmount: true, paidAmount: true, fineAmount: true, discountAmount: true },
          }), { _sum: { dueAmount: null, paidAmount: null, fineAmount: null, discountAmount: null } } as any),
        ]);
        return { classId: cls.id, className: cls.name, collected: Number(collected._sum.amount ?? 0), pending: netDue(pending._sum) };
      }));
      return reply.send({ success: true, data: { classes: result.sort((a,b) => b.collected - a.collected) } });
    }
  );

  // ─── GET /admin/finance/dashboard/collection-by-date ──────
  // Unchanged — this one was always Payment-based, which is correct.
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