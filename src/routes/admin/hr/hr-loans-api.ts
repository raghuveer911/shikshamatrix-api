// apps/api/src/routes/admin/hr/hr-loans-api.ts
// Pure TypeScript — NO JSX, NO React, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminHrLoansRoutes(app: FastifyInstance) {

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get("/admin/hr/loans/dashboard", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [
        totalActive, totalAdvances, pendingRequests,
        byType, recentRequests, outstandingAgg
      ] = await Promise.all([
        prisma.hrLoanRequest.count({
          where: { schoolId, status: { in: ["HR_APPROVED","PRINCIPAL_APPROVED","ACCOUNTS_APPROVED","DISBURSED"] }, type: { not: "SALARY_ADVANCE" } },
        }),
        prisma.hrLoanRequest.count({
          where: { schoolId, status: { in: ["HR_APPROVED","PRINCIPAL_APPROVED","ACCOUNTS_APPROVED","DISBURSED"] }, type: "SALARY_ADVANCE" },
        }),
        prisma.hrLoanRequest.count({ where: { schoolId, status: "PENDING" } }),
        prisma.hrLoanRequest.groupBy({
          by:    ["type"],
          where: { schoolId },
          _count: { id: true },
          _sum:   { approvedAmount: true },
        }),
        prisma.hrLoanRequest.findMany({
          where:   { schoolId },
          orderBy: { createdAt: "desc" },
          take:    8,
          include: { staff: { include: { user: { select: { name: true, avatarUrl: true } } } } },
        }),
        prisma.hrLoanRequest.aggregate({
          where: { schoolId, status: "DISBURSED" },
          _sum:  { approvedAmount: true },
        }),
      ]);

      return reply.send({
        success: true,
        data: {
          kpis: {
            totalActive,
            totalAdvances,
            pendingRequests,
            outstanding: outstandingAgg._sum.approvedAmount ?? 0,
          },
          byType,
          recentRequests,
        },
      });
    }
  );

  // ─── LOAN POLICY ──────────────────────────────────────────
  app.get("/admin/hr/loans/policy", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const policies = await prisma.hrLoanPolicy.findMany({ where: { schoolId } });
      return reply.send({ success: true, data: { policies } });
    }
  );

  app.put("/admin/hr/loans/policy", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as Array<{
        loanType: string; maxAmount: number; maxMultiplier: number;
        minServiceMonths: number; maxActiveLoanCount: number;
        interestRate: number; maxEmiMonths: number; isActive: boolean;
      }>;
      if (!Array.isArray(body)) return reply.status(400).send({ success: false, message: "Array expected." });

      for (const p of body) {
        await prisma.hrLoanPolicy.upsert({
          where:  { schoolId_loanType: { schoolId, loanType: p.loanType as any } },
          update: {
            maxAmount:          p.maxAmount,
            maxMultiplier:      p.maxMultiplier,
            minServiceMonths:   p.minServiceMonths,
            maxActiveLoanCount: p.maxActiveLoanCount,
            interestRate:       p.interestRate,
            maxEmiMonths:       p.maxEmiMonths,
            isActive:           p.isActive,
          },
          create: { schoolId, loanType: p.loanType as any, ...p },
        });
      }
      return reply.send({ success: true });
    }
  );

  // ─── ELIGIBILITY CHECK ────────────────────────────────────
  app.get("/admin/hr/loans/eligibility/:staffId", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { staffId } = req.params as { staffId: string };
      const { loanType } = req.query as { loanType?: string };

      const staff = await prisma.hrStaffProfile.findFirst({
        where:   { id: parseInt(staffId), schoolId },
        include: { salaryProfile: true },
      });
      if (!staff) return reply.status(404).send({ success: false, message: "Staff not found." });

      const policy = loanType
        ? await prisma.hrLoanPolicy.findFirst({ where: { schoolId, loanType: loanType as any, isActive: true } })
        : null;

      // Calculate service months
      const joinDate     = new Date(staff.joinDate);
      const serviceMs    = Date.now() - joinDate.getTime();
      const serviceMonths = Math.floor(serviceMs / (1000 * 60 * 60 * 24 * 30.44));

      // Active loans count
      const activeLoans = await prisma.hrLoanRequest.count({
        where: { staffId: parseInt(staffId), schoolId, status: { in: ["DISBURSED", "HR_APPROVED", "PRINCIPAL_APPROVED", "ACCOUNTS_APPROVED"] } },
      });

      const monthlySalary = staff.salaryProfile?.grossSalary ?? 0;
      const maxByMultiplier = policy ? monthlySalary * policy.maxMultiplier : monthlySalary * 3;

      const checks = {
        serviceMonths,
        minRequired:        policy?.minServiceMonths ?? 12,
        servicePassed:      serviceMonths >= (policy?.minServiceMonths ?? 12),
        activeLoans,
        maxAllowed:         policy?.maxActiveLoanCount ?? 1,
        loanCountPassed:    activeLoans < (policy?.maxActiveLoanCount ?? 1),
        monthlySalary,
        maxLoanByPolicy:    policy?.maxAmount ?? maxByMultiplier,
        maxLoanByMultiplier: maxByMultiplier,
        maxEmiMonths:       policy?.maxEmiMonths ?? 12,
        interestRate:       policy?.interestRate ?? 0,
        eligible:           serviceMonths >= (policy?.minServiceMonths ?? 12) && activeLoans < (policy?.maxActiveLoanCount ?? 1),
      };

      return reply.send({ success: true, data: { checks, staff: { name: (staff as any).user?.name, serviceMonths } } });
    }
  );

  // ─── LOAN REQUESTS ────────────────────────────────────────
  app.get("/admin/hr/loans/requests", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; status?: string; type?: string; staffId?: string };
      const page  = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 20;
      const where: any = { schoolId };
      if (q.status)  where.status  = q.status;
      if (q.type)    where.type    = q.type;
      if (q.staffId) where.staffId = parseInt(q.staffId);

      const [requests, total] = await Promise.all([
        prisma.hrLoanRequest.findMany({
          where, skip: (page-1)*limit, take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            staff: {
              include: {
                user:        { select: { name: true, avatarUrl: true } },
                department:  { select: { name: true } },
                salaryProfile: { select: { grossSalary: true } },
              },
            },
          },
        }),
        prisma.hrLoanRequest.count({ where }),
      ]);
      return reply.send({ success: true, data: { requests, total, totalPages: Math.ceil(total / limit) } });
    }
  );

  app.post("/admin/hr/loans/requests", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as {
        staffId: number; type: string; requestedAmount: number;
        reason: string; requiredDate?: string; emiMonths?: number; attachment?: string;
      };
      if (!body.staffId || !body.type || !body.requestedAmount || !body.reason) {
        return reply.status(400).send({ success: false, message: "staffId, type, requestedAmount, reason required." });
      }

      // Auto eligibility check
      const staff = await prisma.hrStaffProfile.findFirst({ where: { id: body.staffId, schoolId } });
      if (!staff) return reply.status(404).send({ success: false, message: "Staff not found." });

      const policy = await prisma.hrLoanPolicy.findFirst({
        where: { schoolId, loanType: body.type as any, isActive: true },
      });

      if (policy) {
        const joinDate     = new Date(staff.joinDate);
        const serviceMonths = Math.floor((Date.now() - joinDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
        if (serviceMonths < policy.minServiceMonths) {
          return reply.status(400).send({
            success: false,
            message: `Minimum service required: ${policy.minServiceMonths} months. Current: ${serviceMonths} months.`,
          });
        }
        const activeLoans = await prisma.hrLoanRequest.count({
          where: { staffId: body.staffId, schoolId, status: { in: ["DISBURSED", "HR_APPROVED", "PRINCIPAL_APPROVED", "ACCOUNTS_APPROVED"] } },
        });
        if (activeLoans >= policy.maxActiveLoanCount) {
          return reply.status(400).send({
            success: false,
            message: `Active loan limit reached (max ${policy.maxActiveLoanCount}).`,
          });
        }
        if (body.requestedAmount > policy.maxAmount) {
          return reply.status(400).send({
            success: false,
            message: `Requested amount exceeds policy limit of ₹${policy.maxAmount.toLocaleString("en-IN")}.`,
          });
        }
      }

      const request = await prisma.hrLoanRequest.create({
        data: {
          schoolId,
          staffId:         body.staffId,
          type:            body.type as any,
          requestedAmount: body.requestedAmount,
          reason:          body.reason,
          requiredDate:    body.requiredDate ? new Date(body.requiredDate) : null,
          emiMonths:       body.emiMonths ?? null,
          attachment:      body.attachment ?? null,
          interestRate:    policy?.interestRate ?? 0,
          status:          "PENDING",
        },
      });
      return reply.status(201).send({ success: true, data: { id: request.id } });
    }
  );

  // ─── APPROVE / REJECT ─────────────────────────────────────
  app.patch("/admin/hr/loans/requests/:id/approve", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId, role } = req.user as any;
      const { id } = req.params as { id: string };
      const { action, note, approvedAmount, emiMonths } = req.body as {
        action: "APPROVED" | "REJECTED"; note?: string;
        approvedAmount?: number; emiMonths?: number;
      };

      const request = await prisma.hrLoanRequest.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!request) return reply.status(404).send({ success: false, message: "Request not found." });

      const updateData: any = {};
      const isHr         = ["HR", "ADMIN", "SUPERADMIN"].includes(role);
      const isPrincipal  = ["PRINCIPAL"].includes(role);
      const isAccounts   = ["ACCOUNTANT"].includes(role);

      if (action === "REJECTED") {
        updateData.status = "REJECTED";
        if (isHr)        { updateData.hrNote = note; updateData.hrApprovedById = userId; updateData.hrApprovedAt = new Date(); }
        else if (isPrincipal) { updateData.principalNote = note; updateData.principalApprovedById = userId; updateData.principalApprovedAt = new Date(); }
        else if (isAccounts) { updateData.accountsNote = note; updateData.accountsApprovedById = userId; updateData.accountsApprovedAt = new Date(); }
      } else {
        if (isHr && request.status === "PENDING") {
          updateData.status            = "HR_APPROVED";
          updateData.hrApprovedById    = userId;
          updateData.hrApprovedAt      = new Date();
          updateData.hrNote            = note ?? null;
          if (approvedAmount) updateData.approvedAmount = approvedAmount;
          if (emiMonths)      updateData.emiMonths      = emiMonths;
        } else if (isPrincipal && request.status === "HR_APPROVED") {
          updateData.status                   = "PRINCIPAL_APPROVED";
          updateData.principalApprovedById    = userId;
          updateData.principalApprovedAt      = new Date();
          updateData.principalNote            = note ?? null;
        } else if (isAccounts && request.status === "PRINCIPAL_APPROVED") {
          updateData.status                 = "ACCOUNTS_APPROVED";
          updateData.accountsApprovedById   = userId;
          updateData.accountsApprovedAt     = new Date();
          updateData.accountsNote           = note ?? null;
        } else {
          return reply.status(400).send({ success: false, message: "Not authorized for this approval stage." });
        }
      }

      await prisma.hrLoanRequest.update({ where: { id: parseInt(id) }, data: updateData });
      return reply.send({ success: true, message: `Request ${action.toLowerCase()}.` });
    }
  );

  // ─── DISBURSE ─────────────────────────────────────────────
  app.patch("/admin/hr/loans/requests/:id/disburse", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const request = await prisma.hrLoanRequest.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!request) return reply.status(404).send({ success: false, message: "Not found." });
      if (request.status !== "ACCOUNTS_APPROVED") {
        return reply.status(400).send({ success: false, message: "Request must be Accounts Approved before disbursement." });
      }
      await prisma.hrLoanRequest.update({
        where: { id: parseInt(id) },
        data:  { status: "DISBURSED", disbursedAt: new Date(), disbursedById: userId },
      });
      return reply.send({ success: true, message: "Marked as disbursed." });
    }
  );

  // ─── LOAN REGISTER REPORT ─────────────────────────────────
  app.get("/admin/hr/loans/reports/register", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { status, type } = req.query as { status?: string; type?: string };
      const where: any = { schoolId };
      if (status) where.status = status;
      if (type)   where.type   = type;

      const requests = await prisma.hrLoanRequest.findMany({
        where, orderBy: { createdAt: "desc" },
        include: {
          staff: {
            include: {
              user:       { select: { name: true } },
              department: { select: { name: true } },
            },
          },
        },
      });

      const totalRequested  = requests.reduce((s, r) => s + r.requestedAmount, 0);
      const totalApproved   = requests.reduce((s, r) => s + (r.approvedAmount ?? 0), 0);
      const totalDisbursed  = requests.filter(r => r.status === "DISBURSED").reduce((s, r) => s + (r.approvedAmount ?? 0), 0);

      return reply.send({
        success: true,
        data: {
          requests, totalRequested, totalApproved, totalDisbursed,
          count: requests.length, generatedAt: new Date().toISOString(),
        },
      });
    }
  );
}
