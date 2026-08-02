import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { requireCapability } from "../../middleware/checkCapability.js";
import {
  searchStudentsForFeeCollection, getStudentFeeDetails, collectFeePayment,
  getReceiptDetail, FeeCollectionError,
} from "../../services/fee-collection.service.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[staff/finance] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function staffFinanceRoutes(app: FastifyInstance) {
  const P = "/staff/finance";

  // ── GET /staff/finance/overview ─────────────────────────
  app.get(`${P}/overview`, { preHandler: [appAuth, requireCapability("finance.collection")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const [todayAgg, monthAgg, recentReceipts, dueAgg, overdueCount] = await Promise.all([
        safe("today", () => prisma.feeReceipt.aggregate({ where: { schoolId, isVoid: false, createdAt: { gte: todayStart } }, _sum: { amount: true }, _count: true }), { _sum: { amount: null }, _count: 0 } as any),
        safe("month", () => prisma.feeReceipt.aggregate({ where: { schoolId, isVoid: false, createdAt: { gte: monthStart } }, _sum: { amount: true } }), { _sum: { amount: null } } as any),
        safe("recent", () => prisma.feeReceipt.findMany({
          where: { schoolId, isVoid: false }, orderBy: { createdAt: "desc" }, take: 5,
          include: { student: { include: { user: { select: { name: true } } } } },
        }), [] as any[]),
        safe("dues", () => prisma.studentFeeInstallment.aggregate({
          where: { schoolId, status: { in: ["PENDING", "PARTIAL", "OVERDUE"] }, studentPlan: { isActive: true } },
          _sum: { dueAmount: true, paidAmount: true, fineAmount: true, discountAmount: true }, _count: true,
        }), { _sum: { dueAmount: null, paidAmount: null, fineAmount: null, discountAmount: null }, _count: 0 } as any),
        safe("overdue", () => prisma.studentFeeInstallment.count({
          where: { schoolId, status: { in: ["PENDING", "PARTIAL"] }, dueDate: { lt: now }, studentPlan: { isActive: true } },
        }), 0),
      ]);

      const totalDueRaw = Number(dueAgg._sum.dueAmount ?? 0) + Number(dueAgg._sum.fineAmount ?? 0)
        - Number(dueAgg._sum.discountAmount ?? 0) - Number(dueAgg._sum.paidAmount ?? 0);

      return reply.send({
        success: true,
        data: {
          today: { collection: Number(todayAgg._sum.amount ?? 0), txnCount: todayAgg._count ?? 0 },
          month: { collection: Number(monthAgg._sum.amount ?? 0) },
          pending: { amount: Math.max(0, totalDueRaw), students: dueAgg._count ?? 0, overdue: overdueCount },
          recentTransactions: recentReceipts.map((r: any) => ({
            id: r.id, receiptNo: r.receiptNo, amount: Number(r.amount),
            studentName: r.student.user.name, createdAt: r.createdAt,
          })),
        },
      });
    }
  );

  // ── GET /staff/finance/students/search?q= ───────────────
  app.get(`${P}/students/search`, { preHandler: [appAuth, requireCapability("finance.collection")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { q } = req.query as { q: string };
      const students = await searchStudentsForFeeCollection(schoolId, q);
      return reply.send({ success: true, data: { students } });
    }
  );

  // ── GET /staff/finance/students/:id/fees ────────────────
  app.get(`${P}/students/:id/fees`, { preHandler: [appAuth, requireCapability("finance.collection")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };
      const details = await getStudentFeeDetails(schoolId, parseInt(id));
      if (!details) return reply.status(404).send({ success: false, message: "Student not found." });
      return reply.send({ success: true, data: details });
    }
  );

  // ── POST /staff/finance/collect ─────────────────────────
  app.post(`${P}/collect`, { preHandler: [appAuth, requireCapability("finance.collection")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req as any;
      try {
        const result = await collectFeePayment(schoolId, userId, req.body as any);
        return reply.status(201).send({ success: true, message: "Payment collected successfully!", data: result });
      } catch (err) {
        if (err instanceof FeeCollectionError) {
          return reply.status(err.status).send({ success: false, message: err.message });
        }
        console.error("[staff/finance] collect failed:", err);
        return reply.status(500).send({ success: false, message: "Couldn't collect payment. Please try again." });
      }
    }
  );

  // ── GET /staff/finance/receipt/:id ──────────────────────
  app.get(`${P}/receipt/:id`, { preHandler: [appAuth, requireCapability("finance.collection")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };
      const receipt = await getReceiptDetail(schoolId, parseInt(id));
      if (!receipt) return reply.status(404).send({ success: false, message: "Receipt not found." });
      return reply.send({ success: true, data: { receipt } });
    }
  );

  // ── GET /staff/finance/dues ──────────────────────────────
  // Uses StudentFeeInstallment directly (the corrected source of truth),
  // not the older Invoice-based due list the admin web app still has.
  app.get(`${P}/dues`, { preHandler: [appAuth, requireCapability("finance.collection")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = req.query as { page?: string; classId?: string; overdue?: string; search?: string };
      const now = new Date();
      const page = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 20;

      const where: any = { schoolId, status: { in: ["PENDING", "PARTIAL", "OVERDUE"] } };
      if (q.overdue === "true") where.dueDate = { lt: now };
      where.studentPlan = {
        isActive: true,
        ...(q.classId || q.search ? {
          student: {
            ...(q.classId ? { classId: parseInt(q.classId) } : {}),
            ...(q.search ? { OR: [
              { user: { name: { contains: q.search, mode: "insensitive" } } },
              { admissionNumber: { contains: q.search, mode: "insensitive" } },
              { rollNumber: { contains: q.search, mode: "insensitive" } },
            ] } : {}),
          },
        } : {}),
      };

      const [installments, total] = await Promise.all([
        prisma.studentFeeInstallment.findMany({
          where, skip: (page - 1) * limit, take: limit, orderBy: { dueDate: "asc" },
          include: {
            installment: { select: { name: true } },
            studentPlan: { include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } } } },
          },
        }),
        prisma.studentFeeInstallment.count({ where }),
      ]);

      const enriched = installments.map((i) => ({
        id: i.id,
        studentId: i.studentPlan.student.id,
        studentName: i.studentPlan.student.user.name,
        className: i.studentPlan.student.class?.name ?? "—",
        installmentName: i.installment.name,
        dueDate: i.dueDate,
        netDue: Math.max(0, Number(i.dueAmount) + Number(i.fineAmount) - Number(i.discountAmount) - Number(i.paidAmount)),
        isOverdue: new Date(i.dueDate) < now,
        daysOverdue: new Date(i.dueDate) < now ? Math.floor((now.getTime() - new Date(i.dueDate).getTime()) / 86400000) : 0,
      }));

      return reply.send({ success: true, data: { dues: enriched, total, totalPages: Math.ceil(total / limit) } });
    }
  );

  // ── GET /staff/finance/transactions ─────────────────────
  app.get(`${P}/transactions`, { preHandler: [appAuth, requireCapability("finance.collection")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = req.query as { page?: string; from?: string; to?: string; mode?: string; search?: string };
      const page = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 20;

      const where: any = { schoolId, isVoid: false };
      if (q.from || q.to) {
        where.createdAt = {};
        if (q.from) where.createdAt.gte = new Date(q.from);
        if (q.to) where.createdAt.lte = new Date(q.to);
      }
      if (q.search) {
        where.OR = [
          { receiptNo: { contains: q.search, mode: "insensitive" } },
          { student: { user: { name: { contains: q.search, mode: "insensitive" } } } },
        ];
      }

      const [receipts, total] = await Promise.all([
        prisma.feeReceipt.findMany({
          where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: "desc" },
          include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, payment: { select: { method: true } } },
        }),
        prisma.feeReceipt.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: {
          transactions: receipts.map((r) => ({
            id: r.id, receiptNo: r.receiptNo, amount: Number(r.amount), createdAt: r.createdAt,
            studentName: r.student.user.name, className: r.student.class?.name ?? "—",
            mode: r.payment?.method ?? "—",
          })),
          total, totalPages: Math.ceil(total / limit),
        },
      });
    }
  );
}
