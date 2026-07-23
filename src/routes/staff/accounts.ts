import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { requireCapability } from "../../middleware/checkCapability.js";

async function genReqNo(schoolId: number): Promise<string> {
  const count = await prisma.reimbursement.count({ where: { schoolId } });
  const y = new Date().getFullYear().toString().slice(-2);
  const m = String(new Date().getMonth() + 1).padStart(2, "0");
  return `REQ-${y}${m}-${String(count + 1).padStart(4, "0")}`;
}
async function genLoanNo(schoolId: number): Promise<string> {
  const count = await prisma.staffLoan.count({ where: { schoolId } });
  return `LOAN-${String(count + 1).padStart(4, "0")}`;
}
function calcEmi(principal: number, annualRate: number, months: number) {
  if (annualRate <= 0) {
    const emi = Math.round((principal / months) * 100) / 100;
    return { emi, total: principal };
  }
  const r = annualRate / 12 / 100;
  const emi = Math.round(((principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1)) * 100) / 100;
  return { emi, total: Math.round(emi * months * 100) / 100 };
}

export async function staffAccountsRoutes(app: FastifyInstance) {
  const P = "/staff/accounts";

  // ── GET /staff/accounts/overview ────────────────────────
  app.get(`${P}/overview`, { preHandler: [appAuth, requireCapability("accounts.basic")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { staffId } = req as any;

      const [pendingReim, approvedReim, paidReimTotal, activeLoan, pendingEmis] = await Promise.all([
        prisma.reimbursement.count({ where: { staffId, status: { in: ["SUBMITTED", "UNDER_REVIEW"] } } }),
        prisma.reimbursement.count({ where: { staffId, status: "APPROVED" } }),
        prisma.reimbursement.aggregate({ where: { staffId, status: "PAID" }, _sum: { amount: true } }),
        prisma.staffLoan.findFirst({ where: { staffId, status: { in: ["ACTIVE", "DISBURSED"] } }, orderBy: { createdAt: "desc" } }),
        prisma.staffLoan.findFirst({ where: { staffId, status: { in: ["ACTIVE", "DISBURSED"] } } }).then(async (loan) => {
          if (!loan) return 0;
          return prisma.loanEmi.count({ where: { loanId: loan.id, status: "PENDING" } });
        }),
      ]);

      return reply.send({
        success: true,
        data: {
          reimbursements: {
            pending: pendingReim, approved: approvedReim,
            totalPaid: Number(paidReimTotal._sum.amount ?? 0),
          },
          activeLoan: activeLoan ? {
            id: activeLoan.id, loanNo: activeLoan.loanNo,
            outstanding: Number(activeLoan.outstandingAmount ?? 0),
            emiAmount: Number(activeLoan.emiAmount ?? 0),
            pendingEmis,
          } : null,
        },
      });
    }
  );

  // ── GET /staff/accounts/reimbursements ──────────────────
  app.get(`${P}/reimbursements`, { preHandler: [appAuth, requireCapability("accounts.basic")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { staffId } = req as any;
      const q = req.query as { page?: string; status?: string };
      const page = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 20;
      const where: any = { staffId };
      if (q.status) where.status = q.status;

      const [items, total] = await Promise.all([
        prisma.reimbursement.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: "desc" } }),
        prisma.reimbursement.count({ where }),
      ]);

      return reply.send({ success: true, data: { items, total, totalPages: Math.ceil(total / limit) } });
    }
  );

  // ── GET /staff/accounts/reimbursements/:id ──────────────
  app.get(`${P}/reimbursements/:id`, { preHandler: [appAuth, requireCapability("accounts.basic")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { staffId } = req as any;
      const { id } = req.params as { id: string };
      const item = await prisma.reimbursement.findFirst({
        where: { id: parseInt(id), staffId },
        include: { paidBy: { select: { name: true } }, rejectedBy: { select: { name: true } } },
      });
      if (!item) return reply.status(404).send({ success: false, message: "Request not found." });
      return reply.send({ success: true, data: { item } });
    }
  );

  // ── POST /staff/accounts/reimbursements ─────────────────
  app.post(`${P}/reimbursements`, { preHandler: [appAuth, requireCapability("accounts.basic")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId, userId } = req as any;
      const body = req.body as { category: string; amount: number; expenseDate: string; description: string; attachmentUrls?: string[]; priority?: string };

      if (!body.amount || !body.expenseDate || !body.description?.trim()) {
        return reply.status(400).send({ success: false, message: "amount, expenseDate and description are required." });
      }

      const requestNo = await genReqNo(schoolId);
      const item = await prisma.reimbursement.create({
        data: {
          schoolId, createdById: userId, requestNo, staffId,
          category: body.category as any ?? "OTHER",
          amount: body.amount, expenseDate: new Date(body.expenseDate),
          description: body.description, attachmentUrls: body.attachmentUrls ?? [],
          priority: body.priority as any ?? "MEDIUM", status: "SUBMITTED",
        },
      });
      return reply.status(201).send({ success: true, message: "Reimbursement request submitted.", data: { id: item.id, requestNo } });
    }
  );

  // ── GET /staff/accounts/loans ────────────────────────────
  app.get(`${P}/loans`, { preHandler: [appAuth, requireCapability("accounts.basic")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { staffId } = req as any;
      const loans = await prisma.staffLoan.findMany({ where: { staffId }, orderBy: { createdAt: "desc" } });
      return reply.send({ success: true, data: { loans } });
    }
  );

  // ── GET /staff/accounts/loans/:id ────────────────────────
  app.get(`${P}/loans/:id`, { preHandler: [appAuth, requireCapability("accounts.basic")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { staffId } = req as any;
      const { id } = req.params as { id: string };
      const loan = await prisma.staffLoan.findFirst({
        where: { id: parseInt(id), staffId },
        include: { emis: { orderBy: { emiNumber: "asc" } } },
      });
      if (!loan) return reply.status(404).send({ success: false, message: "Loan not found." });
      return reply.send({ success: true, data: { loan } });
    }
  );

  // ── POST /staff/accounts/loans ───────────────────────────
  app.post(`${P}/loans`, { preHandler: [appAuth, requireCapability("accounts.basic")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId, userId } = req as any;
      const body = req.body as {
        loanType: string; requestedAmount: number; reason: string; tenureMonths: number;
      };

      if (!body.requestedAmount || !body.reason?.trim() || !body.tenureMonths) {
        return reply.status(400).send({ success: false, message: "requestedAmount, reason and tenureMonths are required." });
      }

      // Staff self-service loans are always interest-free (school policy) —
      // only the admin/accounts web flow supports custom interest terms.
      const loanNo = await genLoanNo(schoolId);
      const { emi, total } = calcEmi(body.requestedAmount, 0, body.tenureMonths);
      const loan = await prisma.staffLoan.create({
        data: {
          schoolId, createdById: userId, loanNo, staffId,
          loanType: body.loanType as any ?? "PERSONAL",
          requestedAmount: body.requestedAmount, reason: body.reason, tenureMonths: body.tenureMonths,
          isInterestFree: true, interestRate: 0,
          emiAmount: emi, totalPayable: total, outstandingAmount: body.requestedAmount,
          status: "PENDING",
        },
      });
      return reply.status(201).send({ success: true, message: "Loan request submitted.", data: { id: loan.id, loanNo, emi, total } });
    }
  );
}
