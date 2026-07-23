import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// Default settings seed
const DEFAULT_SETTINGS = {
  currency: "INR", numberFormat: "en-IN", dateFormat: "DD-MM-YYYY",
  fyStartMonth: 4, fyEndMonth: 3,
  payrollCycle: "MONTHLY", salaryGenDay: 25,
  attendanceIntegration: false, leaveDeductionEnabled: true, latePenaltyEnabled: false,
  payslipTemplate: "STANDARD", salaryApprovalRequired: true, salaryLockAfterPay: true,
  reimCategories: ["TRAVEL","FUEL","STATIONERY","TRAINING","EVENT","MEDICAL","OTHER"],
  reimReceiptMandatory: true, reimMaxLimits: { FUEL: 3000, TRAVEL: 10000, MEDICAL: 5000 },
  loanTypes: ["SALARY_ADVANCE","EMERGENCY","MEDICAL","FESTIVAL","PERSONAL","EDUCATION"],
  maxLoanMultiple: 3, defaultInterestRate: 0, loanRecoveryMode: "PAYROLL_DEDUCTION",
  expenseCategories: ["STATIONERY","FURNITURE","MAINTENANCE","UTILITIES","EVENT","OTHER"],
  expenseAutoApproveLimit: 5000, expenseBudgetControl: true,
  vendorCategories: ["BOOKS","UNIFORMS","TRANSPORT","IT","ELECTRICITY","MAINTENANCE","OTHER"],
  vendorCodePrefix: "VND", vendorContractAlertDays: 30,
  docAllowedTypes: ["PDF","IMAGE","EXCEL","WORD"], docMaxSizeMb: 10, docAutoArchiveDays: 365,
  salaryApprovalFlow: ["ACCOUNTANT","PRINCIPAL","MANAGEMENT"],
  expenseApprovalFlow: ["DEPT_HEAD","PRINCIPAL","ACCOUNTS"],
  vendorApprovalFlow:  ["ACCOUNTS","PRINCIPAL"],
  loanApprovalFlow:    ["PRINCIPAL","ACCOUNTS","MANAGEMENT"],
  notifyOnSalaryGenerated: true, notifyOnExpenseApproved: true, notifyOnLoanApproved: true,
  notifyOnVendorPayment: true, notifyOnComplianceDue: true,
  logRetentionYears: 7, auditAlertEnabled: true, sensitiveActionMonitoring: true,
};

export async function adminAccountsSettingsRoutes(app: FastifyInstance) {

  // ─── GET /admin/accounts-settings ────────────────────────
  app.get("/admin/accounts-settings", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      let settings = await prisma.accountSetting.findUnique({ where: { schoolId } });

      // Auto-seed defaults on first access
      if (!settings) {
        settings = await prisma.accountSetting.create({ data: { schoolId, ...DEFAULT_SETTINGS as any } });
      }
      return reply.send({ success: true, data: { settings } });
    }
  );

  // ─── PATCH /admin/accounts-settings/general ──────────────
  app.patch("/admin/accounts-settings/general", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { currency?: string; numberFormat?: string; dateFormat?: string; fyStartMonth?: number; fyEndMonth?: number };
      await prisma.accountSetting.upsert({ where: { schoolId }, create: { schoolId, ...DEFAULT_SETTINGS as any, ...body }, update: body });
      return reply.send({ success: true, message: "General settings saved." });
    }
  );

  // ─── PATCH /admin/accounts-settings/payroll ──────────────
  app.patch("/admin/accounts-settings/payroll", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { payrollCycle?: string; salaryGenDay?: number; attendanceIntegration?: boolean; leaveDeductionEnabled?: boolean; latePenaltyEnabled?: boolean };
      await prisma.accountSetting.upsert({ where: { schoolId }, create: { schoolId, ...DEFAULT_SETTINGS as any, ...body }, update: body });
      return reply.send({ success: true, message: "Payroll settings saved." });
    }
  );

  // ─── PATCH /admin/accounts-settings/salary ───────────────
  app.patch("/admin/accounts-settings/salary", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { payslipTemplate?: string; salaryApprovalRequired?: boolean; salaryLockAfterPay?: boolean };
      await prisma.accountSetting.upsert({ where: { schoolId }, create: { schoolId, ...DEFAULT_SETTINGS as any, ...body }, update: body });
      return reply.send({ success: true, message: "Salary settings saved." });
    }
  );

  // ─── PATCH /admin/accounts-settings/reimbursement ────────
  app.patch("/admin/accounts-settings/reimbursement", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { reimCategories?: string[]; reimReceiptMandatory?: boolean; reimMaxLimits?: Record<string,number> };
      await prisma.accountSetting.upsert({ where: { schoolId }, create: { schoolId, ...DEFAULT_SETTINGS as any, ...body }, update: body });
      return reply.send({ success: true, message: "Reimbursement settings saved." });
    }
  );

  // ─── PATCH /admin/accounts-settings/loan ─────────────────
  app.patch("/admin/accounts-settings/loan", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { loanTypes?: string[]; maxLoanMultiple?: number; defaultInterestRate?: number; loanRecoveryMode?: string };
      await prisma.accountSetting.upsert({ where: { schoolId }, create: { schoolId, ...DEFAULT_SETTINGS as any, ...body }, update: body });
      return reply.send({ success: true, message: "Loan settings saved." });
    }
  );

  // ─── PATCH /admin/accounts-settings/expense ──────────────
  app.patch("/admin/accounts-settings/expense", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { expenseCategories?: string[]; expenseAutoApproveLimit?: number; expenseBudgetControl?: boolean };
      await prisma.accountSetting.upsert({ where: { schoolId }, create: { schoolId, ...DEFAULT_SETTINGS as any, ...body }, update: body });
      return reply.send({ success: true, message: "Expense settings saved." });
    }
  );

  // ─── PATCH /admin/accounts-settings/vendor ───────────────
  app.patch("/admin/accounts-settings/vendor", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { vendorCategories?: string[]; vendorCodePrefix?: string; vendorContractAlertDays?: number };
      await prisma.accountSetting.upsert({ where: { schoolId }, create: { schoolId, ...DEFAULT_SETTINGS as any, ...body }, update: body });
      return reply.send({ success: true, message: "Vendor settings saved." });
    }
  );

  // ─── PATCH /admin/accounts-settings/documents ────────────
  app.patch("/admin/accounts-settings/documents", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { docAllowedTypes?: string[]; docMaxSizeMb?: number; docAutoArchiveDays?: number };
      await prisma.accountSetting.upsert({ where: { schoolId }, create: { schoolId, ...DEFAULT_SETTINGS as any, ...body }, update: body });
      return reply.send({ success: true, message: "Document settings saved." });
    }
  );

  // ─── PATCH /admin/accounts-settings/approval ─────────────
  app.patch("/admin/accounts-settings/approval", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { salaryApprovalFlow?: string[]; expenseApprovalFlow?: string[]; vendorApprovalFlow?: string[]; loanApprovalFlow?: string[] };
      await prisma.accountSetting.upsert({ where: { schoolId }, create: { schoolId, ...DEFAULT_SETTINGS as any, ...body as any }, update: body as any });
      return reply.send({ success: true, message: "Approval workflow saved." });
    }
  );

  // ─── PATCH /admin/accounts-settings/notifications ────────
  app.patch("/admin/accounts-settings/notifications", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { notifyOnSalaryGenerated?: boolean; notifyOnExpenseApproved?: boolean; notifyOnLoanApproved?: boolean; notifyOnVendorPayment?: boolean; notifyOnComplianceDue?: boolean };
      await prisma.accountSetting.upsert({ where: { schoolId }, create: { schoolId, ...DEFAULT_SETTINGS as any, ...body }, update: body });
      return reply.send({ success: true, message: "Notification settings saved." });
    }
  );

  // ─── PATCH /admin/accounts-settings/audit ────────────────
  app.patch("/admin/accounts-settings/audit", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { logRetentionYears?: number; auditAlertEnabled?: boolean; sensitiveActionMonitoring?: boolean };
      await prisma.accountSetting.upsert({ where: { schoolId }, create: { schoolId, ...DEFAULT_SETTINGS as any, ...body }, update: body });
      return reply.send({ success: true, message: "Audit settings saved." });
    }
  );

  // ─── PATCH /admin/accounts-settings/financial-year ───────
  app.patch("/admin/accounts-settings/financial-year", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { fyStartMonth?: number; fyEndMonth?: number; action?: "OPEN" | "CLOSE" | "LOCK" };
      await prisma.accountSetting.upsert({ where: { schoolId }, create: { schoolId, ...DEFAULT_SETTINGS as any, ...body }, update: body });
      return reply.send({ success: true, message: `Financial year ${body.action ? body.action.toLowerCase() + "d" : "updated"}.` });
    }
  );

  // ─── POST /admin/accounts-settings/reset ─────────────────
  app.post("/admin/accounts-settings/reset", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      await prisma.accountSetting.upsert({ where: { schoolId }, create: { schoolId, ...DEFAULT_SETTINGS as any }, update: DEFAULT_SETTINGS as any });
      return reply.send({ success: true, message: "Settings reset to defaults." });
    }
  );
}
