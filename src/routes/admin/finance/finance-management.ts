// apps/api/src/routes/admin/finance-management.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminFinanceManagementRoutes(app: FastifyInstance) {

  // ─── FINANCE CONTROL (Settings) ────────────────────────────
  app.get("/admin/finance-mgmt/controls", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      let control = await prisma.financeControl.findUnique({ where: { schoolId } });
      if (!control) {
        control = await prisma.financeControl.create({ data: { schoolId } });
      }
      return reply.send({ success: true, data: { control } });
    }
  );

  app.put("/admin/finance-mgmt/controls", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as Partial<{
        allowPartialPayment: boolean; allowOverPayment: boolean; minPartialPaymentPercent: number;
        autoFineEnabled: boolean; autoReceiptGeneration: boolean; autoDueReminder: boolean; duReminderDaysBefore: number;
        receiptPrefix: string; invoicePrefix: string; showSchoolLogo: boolean; showQrOnReceipt: boolean;
        discountApprovalRequired: boolean; discountApprovalAbove: number; refundApprovalRequired: boolean; waiverApprovalLevels: number;
        financialYearStartMonth: number; lockTransactionsOnClose: boolean; allowBackdatedEntry: boolean; backdatedDaysAllowed: number;
      }>;
      await prisma.financeControl.upsert({ where: { schoolId }, update: body as any, create: { schoolId, ...body } as any });
      return reply.send({ success: true, message: "Finance controls updated." });
    }
  );

  // ─── FINE RULES ────────────────────────────────────────────
  app.get("/admin/finance-mgmt/fine-rules", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const rules = await prisma.fineRule.findMany({ where: { schoolId }, orderBy: { isDefault: "desc" } });
      return reply.send({ success: true, data: { rules } });
    }
  );

  app.post("/admin/finance-mgmt/fine-rules", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { name: string; gracePeriodDays?: number; frequency: string; amount: number; maxAmount?: number; description?: string; isDefault?: boolean };
      if (!body.name || !body.amount) return reply.status(400).send({ success: false, message: "name and amount required." });
      if (body.isDefault) await prisma.fineRule.updateMany({ where: { schoolId }, data: { isDefault: false } });
      const rule = await prisma.fineRule.create({ data: { schoolId, name: body.name, description: body.description ?? null, gracePeriodDays: body.gracePeriodDays ?? 0, frequency: body.frequency as any ?? "FIXED", amount: body.amount, maxAmount: body.maxAmount ?? null, isDefault: body.isDefault ?? false } });
      return reply.status(201).send({ success: true, data: { id: rule.id } });
    }
  );

  app.put("/admin/finance-mgmt/fine-rules/:id", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const body = req.body as any;
      if (body.isDefault) await prisma.fineRule.updateMany({ where: { schoolId }, data: { isDefault: false } });
      await prisma.fineRule.updateMany({ where: { id: parseInt(id), schoolId }, data: body });
      return reply.send({ success: true });
    }
  );

  app.delete("/admin/finance-mgmt/fine-rules/:id", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      await prisma.fineRule.updateMany({ where: { id: parseInt(id), schoolId }, data: { isActive: false } });
      return reply.send({ success: true });
    }
  );

  // ─── SESSION FINANCE CONTROLS ──────────────────────────────
  app.get("/admin/finance-mgmt/sessions", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const years = await prisma.academicYear.findMany({ where: { schoolId }, orderBy: { startDate: "desc" },
        include: { sessionFinanceControl: { include: { lockedBy: { select: { name: true } } } } } });
      return reply.send({ success: true, data: { years } });
    }
  );

  app.post("/admin/finance-mgmt/sessions/:yearId/lock", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any; const { yearId } = req.params as { yearId: string };
      const { notes } = req.body as { notes?: string };
      await prisma.sessionFinanceControl.upsert({
        where: { academicYearId: parseInt(yearId) },
        create: { schoolId, academicYearId: parseInt(yearId), status: "LOCKED", lockedAt: new Date(), lockedById: userId, notes: notes ?? null },
        update: { status: "LOCKED", lockedAt: new Date(), lockedById: userId, notes: notes ?? null },
      });
      return reply.send({ success: true, message: "Session locked. No more transactions allowed." });
    }
  );

  app.post("/admin/finance-mgmt/sessions/:yearId/close", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any; const { yearId } = req.params as { yearId: string };
      await prisma.sessionFinanceControl.upsert({
        where: { academicYearId: parseInt(yearId) },
        create: { schoolId, academicYearId: parseInt(yearId), status: "CLOSED", closedAt: new Date(), closedById: userId },
        update: { status: "CLOSED", closedAt: new Date(), closedById: userId },
      });
      return reply.send({ success: true, message: "Session closed." });
    }
  );

  app.post("/admin/finance-mgmt/sessions/:yearId/open", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { yearId } = req.params as { yearId: string };
      await prisma.sessionFinanceControl.upsert({
        where: { academicYearId: parseInt(yearId) },
        create: { schoolId, academicYearId: parseInt(yearId), status: "OPEN", openedAt: new Date() },
        update: { status: "OPEN", openedAt: new Date() },
      });
      return reply.send({ success: true, message: "Session opened." });
    }
  );

  // ─── CARRY FORWARD ─────────────────────────────────────────
  app.get("/admin/finance-mgmt/carry-forwards", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { status?: string; page?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status) where.status = q.status;
      const [items, total] = await Promise.all([
        prisma.carryForward.findMany({ where, skip:(page-1)*limit, take:limit, orderBy:{createdAt:"desc"},
          include:{ student:{include:{user:{select:{name:true}},class:{select:{name:true}}}}, fromAcademicYear:{select:{name:true}}, toAcademicYear:{select:{name:true}} } }),
        prisma.carryForward.count({ where }),
      ]);
      return reply.send({ success: true, data: { items, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  app.post("/admin/finance-mgmt/carry-forwards", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { studentId: number; fromAcademicYearId: number; toAcademicYearId: number; invoiceId?: number; reason?: string; partial?: boolean; carriedAmount?: number };
      if (!body.studentId || !body.fromAcademicYearId || !body.toAcademicYearId) return reply.status(400).send({ success: false, message: "studentId, fromAcademicYearId, toAcademicYearId required." });
      // Get outstanding due
      const due = await prisma.invoice.aggregate({ where: { studentId: body.studentId, schoolId, academicYearId: body.fromAcademicYearId, status: { in: ["PENDING","PARTIAL","OVERDUE"] } }, _sum: { dueAmount: true } });
      const dueAmt = Number(due._sum.dueAmount ?? 0);
      if (dueAmt === 0) return reply.status(400).send({ success: false, message: "No outstanding due found for this student and session." });
      const carriedAmt = body.carriedAmount ?? dueAmt;
      const cf = await prisma.carryForward.create({ data: { schoolId, studentId: body.studentId, fromAcademicYearId: body.fromAcademicYearId, toAcademicYearId: body.toAcademicYearId, originalInvoiceId: body.invoiceId ?? null, dueAmount: dueAmt, carriedAmount: carriedAmt, reason: body.reason ?? null, createdById: userId } });
      return reply.status(201).send({ success: true, message: "Carry forward created — pending application.", data: { id: cf.id } });
    }
  );

  app.patch("/admin/finance-mgmt/carry-forwards/:id/apply", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any; const { id } = req.params as { id: string };
      const cf = await prisma.carryForward.findFirst({ where: { id: parseInt(id), schoolId, status: "PENDING" } });
      if (!cf) return reply.status(404).send({ success: false, message: "Not found or already applied." });
      // Create new invoice in target session
      const invCount = await prisma.invoice.count({ where: { schoolId } });
      const y = new Date().getFullYear().toString().slice(-2); const m = String(new Date().getMonth()+1).padStart(2,"0");
      const invNo = `CF-${y}${m}-${String(invCount+1).padStart(5,"0")}`;
      const invoice = await prisma.invoice.create({ data: { schoolId, studentId: cf.studentId, academicYearId: cf.toAcademicYearId, createdById: userId, invoiceNumber: invNo, totalAmount: cf.carriedAmount, paidAmount: 0, dueAmount: cf.carriedAmount, status: "PENDING", dueDate: new Date(Date.now() + 30*86400000), notes: `Carry forward from prev session` } });
      await prisma.carryForward.updateMany({ where: { id: parseInt(id) }, data: { status: "APPLIED", appliedAt: new Date(), newInvoiceId: invoice.id } });
      return reply.send({ success: true, message: "Carry forward applied. New invoice created.", data: { invoiceId: invoice.id, invoiceNumber: invNo } });
    }
  );

  // ─── FEE ASSIGNMENT ────────────────────────────────────────
  app.get("/admin/finance-mgmt/fee-assignment", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { classId?: string; planId?: string; academicYearId?: string; unassigned?: string; page?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      if (q.unassigned === "true") {
        // Students without any fee plan in current year
        const currentYear = await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
        const assigned = await prisma.studentFeePlan.findMany({ where: { schoolId, academicYearId: currentYear?.id }, select: { studentId: true } });
        const assignedIds = assigned.map(a => a.studentId);
        const where: any = { schoolId, isActive: true, id: { notIn: assignedIds } };
        if (q.classId) where.classId = parseInt(q.classId);
        const [students, total] = await Promise.all([
          prisma.student.findMany({ where, skip:(page-1)*limit, take:limit, include:{ user:{select:{name:true}}, class:{select:{name:true}} } }),
          prisma.student.count({ where }),
        ]);
        return reply.send({ success: true, data: { students, total, totalPages: Math.ceil(total/limit), type: "unassigned" } });
      }
      const where: any = { schoolId };
      if (q.planId)        where.planId        = parseInt(q.planId);
      if (q.academicYearId) where.academicYearId = parseInt(q.academicYearId);
      if (q.classId)        where.student        = { classId: parseInt(q.classId) };
      const [assignments, total] = await Promise.all([
        prisma.studentFeePlan.findMany({ where, skip:(page-1)*limit, take:limit, orderBy:{assignedAt:"desc"},
          include:{ student:{include:{user:{select:{name:true}},class:{select:{name:true}}}}, plan:{select:{name:true,totalAmount:true}}, installments:{select:{status:true}} } }),
        prisma.studentFeePlan.count({ where }),
      ]);
      return reply.send({ success: true, data: { assignments, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── BULK OPERATIONS ───────────────────────────────────────
  app.get("/admin/finance-mgmt/bulk-operations", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const logs = await prisma.bulkOperationLog.findMany({ where: { schoolId }, orderBy: { createdAt: "desc" }, take: 20, include: { executedBy: { select: { name: true } } } });
      return reply.send({ success: true, data: { logs } });
    }
  );

  app.post("/admin/finance-mgmt/bulk-operations/fine", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { classIds?: number[]; studentIds?: number[]; fineAmount: number; reason: string; fineType?: string };
      if (!body.fineAmount || !body.reason) return reply.status(400).send({ success: false, message: "fineAmount and reason required." });
      const where: any = { schoolId, isActive: true };
      if (body.studentIds?.length) where.id = { in: body.studentIds };
      else if (body.classIds?.length) where.classId = { in: body.classIds };
      const students = await prisma.student.findMany({ where, select: { id: true } });
      const log = await prisma.bulkOperationLog.create({ data: { schoolId, executedById: userId, operationType: "BULK_FINE_APPLY", description: `Bulk fine: ${body.reason}`, parameters: body as any, targetCount: students.length, status: "RUNNING" } });
      let success = 0; let failed = 0;
      for (const s of students) {
        try {
          const cnt = await prisma.feeFine.count({ where: { schoolId } });
          await prisma.feeFine.create({ data: { schoolId, studentId: s.id, fineNo: `FINE-${String(cnt+1).padStart(5,"0")}`, reason: body.reason, fineType: body.fineType as any ?? "CUSTOM", amount: body.fineAmount, createdById: userId } });
          success++;
        } catch { failed++; }
      }
      await prisma.bulkOperationLog.updateMany({ where: { id: log.id }, data: { successCount: success, failedCount: failed, status: "DONE", completedAt: new Date() } });
      return reply.send({ success: true, message: `Fine applied to ${success}/${students.length} students.`, data: { success, failed } });
    }
  );

  app.post("/admin/finance-mgmt/bulk-operations/notice", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { classIds?: number[]; noticeType?: string; delivery?: string; overdueDaysMin?: number };
      const where: any = { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] } };
      if (body.classIds?.length) where.student = { classId: { in: body.classIds } };
      if (body.overdueDaysMin) where.dueDate = { lt: new Date(Date.now() - body.overdueDaysMin*86400000) };
      const invoices = await prisma.invoice.findMany({ where, select: { studentId: true, dueAmount: true, dueDate: true }, distinct: ["studentId"] });
      const log = await prisma.bulkOperationLog.create({ data: { schoolId, executedById: userId, operationType: "BULK_NOTICE", description: `Bulk ${body.noticeType ?? "REMINDER"} notice`, parameters: body as any, targetCount: invoices.length, status: "RUNNING" } });
      let success = 0;
      for (const inv of invoices) {
        try {
          const cnt = await prisma.dueNotice.count({ where: { schoolId } });
          await prisma.dueNotice.create({ data: { schoolId, noticeNo: `NTC-${String(cnt+1).padStart(5,"0")}`, studentId: inv.studentId, noticeType: body.noticeType as any ?? "REMINDER", delivery: body.delivery as any ?? "APP", subject: "Fee Due Reminder", body: `Your fee of ₹${Number(inv.dueAmount).toLocaleString("en-IN")} is due.`, dueAmount: inv.dueAmount, dueDate: inv.dueDate, status: "SENT", sentAt: new Date(), createdById: userId } });
          success++;
        } catch {}
      }
      await prisma.bulkOperationLog.updateMany({ where: { id: log.id }, data: { successCount: success, failedCount: invoices.length - success, status: "DONE", completedAt: new Date() } });
      return reply.send({ success: true, message: `${success} notices sent.`, data: { success } });
    }
  );

  // ─── APPROVALS PENDING (unified view) ──────────────────────
  app.get("/admin/finance-mgmt/approvals", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [refunds, waivers, scholarships, adjustments] = await Promise.all([
        prisma.feeRefund.findMany({ where: { schoolId, status: { in: ["REQUESTED","UNDER_REVIEW"] } }, take: 10, include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } } } }),
        prisma.dueWaiver.findMany({ where: { schoolId, status: "PENDING" }, take: 10, include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } } } }),
        prisma.studentScholarship.findMany({ where: { schoolId, status: "PENDING" }, take: 10, include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } } } }),
        prisma.txnAdjustment.findMany({ where: { schoolId, status: "PENDING" }, take: 10, include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } } } }),
      ]);
      return reply.send({ success: true, data: {
        refunds: { count: refunds.length, items: refunds },
        waivers: { count: waivers.length, items: waivers },
        scholarships: { count: scholarships.length, items: scholarships },
        adjustments: { count: adjustments.length, items: adjustments },
        total: refunds.length + waivers.length + scholarships.length + adjustments.length,
      }});
    }
  );

  // ─── FEE REVISION ──────────────────────────────────────────
  app.post("/admin/finance-mgmt/fee-revision", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { planId: number; headId: number; newAmount: number; effectiveFrom?: string; reason?: string };
      if (!body.planId || !body.headId || !body.newAmount) return reply.status(400).send({ success: false, message: "planId, headId, newAmount required." });
      // Update the fee head amount
      const head = await prisma.feePlanHead.findFirst({ where: { id: body.headId, planId: body.planId, schoolId } });
      if (!head) return reply.status(404).send({ success: false, message: "Fee head not found." });
      const oldAmount = head.amount;
      await prisma.feePlanHead.updateMany({ where: { id: body.headId }, data: { amount: body.newAmount } });
      // Recalculate plan total
      const allHeads = await prisma.feePlanHead.findMany({ where: { planId: body.planId, schoolId } });
      const newTotal = allHeads.reduce((s,h) => s + Number(h.amount), 0);
      await prisma.feePlan.updateMany({ where: { id: body.planId, schoolId }, data: { totalAmount: newTotal } });
      return reply.send({ success: true, message: `Fee revised from ₹${oldAmount} → ₹${body.newAmount}. Plan total updated to ₹${newTotal}.` });
    }
  );
}
