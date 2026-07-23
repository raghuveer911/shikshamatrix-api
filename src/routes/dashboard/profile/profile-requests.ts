// apps/api/src/routes/staff/profile-requests.ts
//
// Reimbursements, Loan Requests, Comp-Off balance.
//
// ⚠️ ReimbursementCategory, ReimbursementPriority (beyond MEDIUM default),
// LoanRequestType exact enum values weren't confirmed. Creation is
// wrapped in try/catch — if the enum value you send doesn't match your
// schema exactly, you'll get a clear 400 instead of a 500 crash.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { z } from "zod";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[profile/requests] "${label}" failed:`, err?.message ?? err); return fallback; }
}

const reimbursementSchema = z.object({
  category:    z.string().default("OTHER"),   // ⚠️ confirm ReimbursementCategory enum
  amount:      z.number().positive(),
  expenseDate: z.string(),
  description: z.string().min(5),
  attachmentUrls: z.array(z.string()).optional(),
  priority:    z.string().default("MEDIUM"),
});

const loanRequestSchema = z.object({
  type:            z.string().default("PERSONAL"), // ⚠️ confirm LoanRequestType enum
  requestedAmount: z.number().positive(),
  reason:          z.string().min(5),
  requiredDate:    z.string().optional(),
  emiMonths:       z.number().optional(),
});

// Generate a request number like REQ-2607-0001 (best-effort sequence)
async function nextRequestNo(schoolId: number) {
  const count = await safe("reimbursement.count (seq)", () =>
    prisma.reimbursement.count({ where: { schoolId } }), 0);
  const ym = new Date().toISOString().slice(2, 7).replace("-", "");
  return `REQ-${ym}-${String(count + 1).padStart(4, "0")}`;
}

export async function profileRequestsRoutes(app: FastifyInstance) {

  // ── GET /profile/requests — reimbursements + loans + comp-off ──
  app.get("/profile/requests",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const staff = await prisma.staff.findFirst({ where: { userId, schoolId }, select: { id: true } });
      if (!staff) return reply.status(404).send({ success: false, error: "STAFF_NOT_FOUND" });

      const [reimbursements, loanRequests, compOffs] = await Promise.all([
        safe("reimbursement.findMany", () =>
          prisma.reimbursement.findMany({
            where: { staffId: staff.id },
            orderBy: { createdAt: "desc" }, take: 20,
            select: {
              id: true, requestNo: true, category: true, amount: true,
              expenseDate: true, description: true, priority: true, status: true,
              rejectionReason: true, paymentDate: true, createdAt: true,
            },
          }), [] as any[]),
        safe("hrLoanRequest.findMany", () =>
          prisma.hrLoanRequest.findMany({
            where: { staffId: staff.id },
            orderBy: { createdAt: "desc" }, take: 20,
            select: {
              id: true, type: true, requestedAmount: true, approvedAmount: true,
              reason: true, status: true, emiMonths: true, interestRate: true,
              hrNote: true, principalNote: true, accountsNote: true,
              disbursedAt: true, createdAt: true,
            },
          }), [] as any[]),
        safe("hrCompOff.findMany", () =>
          prisma.hrCompOff.findMany({
            where: { staffId: staff.id },
            orderBy: { workedDate: "desc" }, take: 20,
            select: { id: true, workedDate: true, earnedDays: true, usedDays: true,
              expiryDate: true, reason: true, isActive: true },
          }), [] as any[]),
      ]);

      const compOffAvailable = compOffs
        .filter((c: any) => c.isActive)
        .reduce((s: number, c: any) => s + (Number(c.earnedDays) - Number(c.usedDays)), 0);

      return reply.send({
        success: true,
        data: { reimbursements, loanRequests, compOffs, compOffAvailable },
      });
    }
  );

  // ── POST /profile/requests/reimbursement ──────────────────────
  app.post("/profile/requests/reimbursement",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const parsed = reimbursementSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });

      const staff = await prisma.staff.findFirst({ where: { userId, schoolId }, select: { id: true } });
      if (!staff) return reply.status(404).send({ success: false, error: "STAFF_NOT_FOUND" });

      const { category, amount, expenseDate, description, attachmentUrls, priority } = parsed.data;
      const requestNo = await nextRequestNo(schoolId);

      try {
        const reim = await prisma.reimbursement.create({
          data: {
            schoolId, requestNo, staffId: staff.id,
            category: category as any, amount, expenseDate: new Date(expenseDate),
            description, attachmentUrls: attachmentUrls ?? [],
            priority: priority as any, status: "SUBMITTED",
            createdById: userId,
          },
        });
        return reply.status(201).send({ success: true, data: { reimbursement: reim } });
      } catch (err: any) {
        return reply.status(400).send({
          success: false, error: "CREATE_FAILED",
          message: `Check that category "${category}" / priority "${priority}" match your enum values exactly.`,
        });
      }
    }
  );

  // ── POST /profile/requests/loan ─────────────────────────────────
  app.post("/profile/requests/loan",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const parsed = loanRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });

      const staff = await prisma.staff.findFirst({ where: { userId, schoolId }, select: { id: true } });
      if (!staff) return reply.status(404).send({ success: false, error: "STAFF_NOT_FOUND" });

      const { type, requestedAmount, reason, requiredDate, emiMonths } = parsed.data;

      try {
        const loan = await prisma.hrLoanRequest.create({
          data: {
            schoolId, staffId: staff.id, type: type as any,
            requestedAmount, reason,
            requiredDate: requiredDate ? new Date(requiredDate) : null,
            emiMonths: emiMonths ?? null, status: "PENDING",
          },
        });
        return reply.status(201).send({ success: true, data: { loan } });
      } catch (err: any) {
        return reply.status(400).send({
          success: false, error: "CREATE_FAILED",
          message: `Check that loan type "${type}" matches your LoanRequestType enum exactly.`,
        });
      }
    }
  );
}