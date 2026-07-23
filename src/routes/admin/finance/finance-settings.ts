// apps/api/src/routes/admin/finance-settings.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ─── Helper: get or create FinanceControl ────────────────────
async function getOrCreateControl(schoolId: number) {
  let ctrl = await prisma.financeControl.findUnique({ where: { schoolId } });
  if (!ctrl) ctrl = await prisma.financeControl.create({ data: { schoolId } });
  return ctrl;
}

export async function adminFinanceSettingsRoutes(app: FastifyInstance) {

  // ─── GET ALL SETTINGS (full flat object) ──────────────────
  app.get("/admin/finance-settings", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [control, counters, years] = await Promise.all([
        getOrCreateControl(schoolId),
        prisma.collectionCounter.findMany({ where: { schoolId, isActive: true }, orderBy: { id: "asc" } }),
        prisma.academicYear.findMany({ where: { schoolId }, orderBy: { startDate: "desc" }, select: { id: true, name: true, isCurrent: true, startDate: true, endDate: true } }),
      ]);
      return reply.send({ success: true, data: { control, counters, years } });
    }
  );

  // ─── UPDATE SETTINGS (partial update by section) ──────────
  app.put("/admin/finance-settings", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as Record<string, any>;
      // Whitelist of updateable fields (guards against injections)
      const ALLOWED = [
        "allowPartialPayment","allowOverPayment","allowAdvancePayment","minPartialPaymentPercent",
        "autoFineEnabled","autoReceiptGeneration","autoDueReminder","duReminderDaysBefore",
        "autoSmsEnabled","autoWhatsappEnabled","autoEmailEnabled",
        "receiptPrefix","invoicePrefix","feeCodePrefix","showSchoolLogo","showQrOnReceipt",
        "discountApprovalRequired","discountApprovalAbove","refundApprovalRequired","waiverApprovalLevels",
        "financialYearStartMonth","lockTransactionsOnClose","allowBackdatedEntry","backdatedDaysAllowed",
        "defaultCurrency","dateFormat","paymentLinkExpiry","autoCarryForward",
        "notifyOnFeeCreation","notifyOnPayment","notifyOnRefund","notifyOnScholarship",
        "logRetentionYears","sensitiveActionTracking",
        "allowFeeEdit","allowReceiptCancel","refundPermissionRoles",
        "activeGatewayId",
      ];
      const safeData: Record<string, any> = {};
      ALLOWED.forEach(k => { if (body[k] !== undefined) safeData[k] = body[k]; });
      if (!Object.keys(safeData).length) return reply.status(400).send({ success: false, message: "No valid fields to update." });
      await prisma.financeControl.upsert({ where: { schoolId }, update: safeData, create: { schoolId, ...safeData } });
      return reply.send({ success: true, message: "Settings saved." });
    }
  );

  // ─── COLLECTION COUNTERS ───────────────────────────────────
  app.get("/admin/finance-settings/counters", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const counters = await prisma.collectionCounter.findMany({ where: { schoolId }, orderBy: { id: "asc" } });
      return reply.send({ success: true, data: { counters } });
    }
  );

  app.post("/admin/finance-settings/counters", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { name, description, isOnline } = req.body as { name: string; description?: string; isOnline?: boolean };
      if (!name) return reply.status(400).send({ success: false, message: "name required." });
      const c = await prisma.collectionCounter.create({ data: { schoolId, name, description: description ?? null, isOnline: isOnline ?? false } });
      return reply.status(201).send({ success: true, data: { id: c.id } });
    }
  );

  app.put("/admin/finance-settings/counters/:id", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const body = req.body as { name?: string; description?: string; isOnline?: boolean; isActive?: boolean };
      await prisma.collectionCounter.updateMany({ where: { id: parseInt(id), schoolId }, data: body });
      return reply.send({ success: true });
    }
  );

  app.delete("/admin/finance-settings/counters/:id", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      await prisma.collectionCounter.updateMany({ where: { id: parseInt(id), schoolId }, data: { isActive: false } });
      return reply.send({ success: true });
    }
  );

  // ─── SESSION CLONE ─────────────────────────────────────────
  app.post("/admin/finance-settings/clone-session", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { fromYearId, toYearName, toStartDate, toEndDate } = req.body as { fromYearId: number; toYearName: string; toStartDate: string; toEndDate: string };
      if (!fromYearId || !toYearName || !toStartDate || !toEndDate) return reply.status(400).send({ success: false, message: "fromYearId, toYearName, toStartDate, toEndDate required." });

      // Check target year doesn't already exist
      const existsCheck = await prisma.academicYear.findFirst({ where: { schoolId, name: toYearName } });
      if (existsCheck) return reply.status(409).send({ success: false, message: `Academic year "${toYearName}" already exists.` });

      // Clone academic year
      const newYear = await prisma.academicYear.create({ data: { schoolId, name: toYearName, startDate: new Date(toStartDate), endDate: new Date(toEndDate), isCurrent: false } });

      // Clone fee plans (structure only, no student assignments)
      const feePlans = await prisma.feePlan.findMany({ where: { schoolId, academicYearId: fromYearId }, include: { heads: true, installments: true } });
      let clonedPlans = 0;
      for (const plan of feePlans) {
        const newPlan = await prisma.feePlan.create({ data: {
          schoolId, name: plan.name, description: plan.description ?? undefined,
          academicYearId: newYear.id, feeGroupId: plan.feeGroupId ?? undefined,
          totalAmount: plan.totalAmount, frequency: plan.frequency,
          status: "DRAFT", createdById: userId,
        }});
        // Clone heads
        for (const head of plan.heads) {
          await prisma.feePlanHead.create({ data: { schoolId, planId: newPlan.id, name: head.name, category: head.category, amount: head.amount, order: head.order, isRequired: head.isRequired, description: head.description ?? undefined } });
        }
        // Clone installments
        for (const inst of plan.installments) {
          await prisma.feePlanInstallment.create({ data: { planId: newPlan.id, installmentNo: inst.installmentNo, name: inst.name, dueDate: new Date(new Date(inst.dueDate).setFullYear(new Date(toStartDate).getFullYear())), amount: inst.amount, lateFineMode: inst.lateFineMode, lateFineValue: inst.lateFineValue ?? undefined, lateFineDays: inst.lateFineDays } });
        }
        clonedPlans++;
      }

      return reply.send({ success: true, message: `Session cloned successfully. ${clonedPlans} fee plan${clonedPlans!==1?"s":""} copied as drafts.`, data: { newYearId: newYear.id, clonedPlans } });
    }
  );

  // ─── NOTIFICATION PREFERENCES ─────────────────────────────
  app.get("/admin/finance-settings/notifications", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const ctrl = await getOrCreateControl(schoolId);
      return reply.send({ success: true, data: { notifyOnFeeCreation: ctrl.notifyOnFeeCreation, notifyOnPayment: ctrl.notifyOnPayment, notifyOnRefund: ctrl.notifyOnRefund, notifyOnScholarship: ctrl.notifyOnScholarship, autoSmsEnabled: ctrl.autoSmsEnabled, autoWhatsappEnabled: ctrl.autoWhatsappEnabled, autoEmailEnabled: ctrl.autoEmailEnabled } });
    }
  );

  // ─── SECURITY SETTINGS ─────────────────────────────────────
  app.get("/admin/finance-settings/security", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const ctrl = await getOrCreateControl(schoolId);
      return reply.send({ success: true, data: { allowFeeEdit: ctrl.allowFeeEdit, allowReceiptCancel: ctrl.allowReceiptCancel, refundPermissionRoles: ctrl.refundPermissionRoles, logRetentionYears: ctrl.logRetentionYears, sensitiveActionTracking: ctrl.sensitiveActionTracking } });
    }
  );

  // ─── ACADEMIC YEARS (Settings view) ───────────────────────
  app.get("/admin/finance-settings/academic-years", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const years = await prisma.academicYear.findMany({ where: { schoolId }, orderBy: { startDate: "desc" }, include: { sessionFinanceControl: { select: { status: true } } } });
      return reply.send({ success: true, data: { years } });
    }
  );

  app.put("/admin/finance-settings/academic-years/:id/current", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      await prisma.academicYear.updateMany({ where: { schoolId }, data: { isCurrent: false } });
      await prisma.academicYear.updateMany({ where: { id: parseInt(id), schoolId }, data: { isCurrent: true } });
      return reply.send({ success: true, message: "Current academic year updated." });
    }
  );

  // ─── RESET TO DEFAULTS ─────────────────────────────────────
  app.post("/admin/finance-settings/reset-defaults", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      await prisma.financeControl.upsert({
        where: { schoolId },
        update: { allowPartialPayment: true, allowOverPayment: false, autoFineEnabled: false, autoReceiptGeneration: true, autoDueReminder: false, receiptPrefix: "RCP", invoicePrefix: "INV", feeCodePrefix: "FEE", showSchoolLogo: true, showQrOnReceipt: true, discountApprovalRequired: true, refundApprovalRequired: true, waiverApprovalLevels: 3, lockTransactionsOnClose: true, allowBackdatedEntry: false, sensitiveActionTracking: true },
        create: { schoolId },
      });
      return reply.send({ success: true, message: "Settings reset to defaults." });
    }
  );
}
