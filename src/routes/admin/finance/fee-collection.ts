// apps/api/src/routes/admin/finance/fee-collection.ts
//
// FIXED — the core bug: this file was treating Invoice as the source
// of truth for dues, completely disconnected from
// StudentFeePlan/StudentFeeInstallment (which is what the Parent app
// reads and what actually tracks per-installment dues). This caused:
//   1. Fees showing 0/0 (Invoice history was empty for most students)
//   2. Admin typing free-form "fee items" instead of picking real
//      installments
//   3. Payments never reflecting back into StudentFeeInstallment, so
//      the Parent app's dues view never synced with what was collected
//
// FIX: GET .../fees now reads from StudentFeePlan/StudentFeeInstallment
// (real dues). POST .../collect now takes installmentIds (which
// specific installments are being paid), and — critically — updates
// StudentFeeInstallment.paidAmount/status AND StudentFeePlan's
// aggregates, IN ADDITION TO creating the Invoice/Payment/Receipt
// (which still exist, purely as the billing/receipt record for this
// transaction).
//
// ⚠️ ASSUMPTION (flagged, not guessed silently): InvoiceItem.category
// is required but an installment doesn't carry a natural single
// category (it bundles multiple fee heads). Defaulted to "OTHER" —
// tell me if you want per-head proportional splitting instead.
//
// ADDED (this pass):
//   • POST /collect now notifies the parent (in-app Notification row +
//     push) once the payment is saved — category "FEES", clickable
//     through to /parent/fees for that student.
//   • GET /receipt/:id/pdf — a properly designed, downloadable/printable
//     receipt PDF (was previously JSON-only; nothing rendered a receipt
//     that looked like a receipt).
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { generateFeeReceiptPdf } from "../../../lib/fee-receipt.js";
import { resolveParentUserIdsForStudent } from "../../../lib/parent-lookup.js";
import { fanOutNotification } from "../../../services/notification-fanout.service.js";

async function genReceiptNo(schoolId: number): Promise<string> {
  const cnt = await prisma.feeReceipt.count({ where: { schoolId } });
  const y = new Date().getFullYear().toString().slice(-2);
  const m = String(new Date().getMonth() + 1).padStart(2, "0");
  return `RCP-${y}${m}-${String(cnt + 1).padStart(5, "0")}`;
}
async function genInvoiceNo(schoolId: number): Promise<string> {
  const cnt = await prisma.invoice.count({ where: { schoolId } });
  const y = new Date().getFullYear().toString().slice(-2);
  const m = String(new Date().getMonth() + 1).padStart(2, "0");
  return `INV-${y}${m}-${String(cnt + 1).padStart(5, "0")}`;
}
async function genFineNo(schoolId: number): Promise<string> {
  const cnt = await prisma.feeFine.count({ where: { schoolId } });
  return `FINE-${String(cnt + 1).padStart(5, "0")}`;
}
async function genRefundNo(schoolId: number): Promise<string> {
  const cnt = await prisma.feeRefund.count({ where: { schoolId } });
  return `REF-${String(cnt + 1).padStart(5, "0")}`;
}

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[fee-collection] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function adminFeeCollectionRoutes(app: FastifyInstance) {

  // ─── GET /admin/fee-collection/search — unchanged ─────────
  app.get("/admin/fee-collection/search", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { q } = req.query as { q: string };
      if (!q?.trim() || q.trim().length < 2) return reply.send({ success: true, data: { students: [] } });

      const students = await prisma.student.findMany({
        where: {
          schoolId, isActive: true,
          OR: [
            { admissionNumber: { contains: q, mode: "insensitive" } },
            { rollNumber: { contains: q, mode: "insensitive" } },
            { user: { name: { contains: q, mode: "insensitive" } } },
            { parentDetail: { fatherPhone: { contains: q } } },
            { parentDetail: { motherPhone: { contains: q } } },
          ],
        },
        include: {
          user: { select: { name: true, avatarUrl: true } },
          class: { select: { name: true } },
          parentDetail: { select: { fatherName: true, fatherPhone: true, motherPhone: true } },
        },
        take: 10,
      });

      return reply.send({ success: true, data: { students: students.map(s => ({
        id: s.id, name: s.user.name, avatar: s.user.avatarUrl,
        admissionNumber: s.admissionNumber, rollNumber: s.rollNumber,
        className: s.class?.name ?? "—",
        fatherName: s.parentDetail?.fatherName ?? "", fatherPhone: s.parentDetail?.fatherPhone ?? "",
      }))}});
    }
  );

  // ═══════════════════════════════════════════════════════════
  // ─── GET /admin/fee-collection/student/:id/fees — FIXED ───
  // Now reads REAL dues from StudentFeePlan/StudentFeeInstallment
  // instead of the disconnected Invoice history.
  // ═══════════════════════════════════════════════════════════
  app.get("/admin/fee-collection/student/:id/fees", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const sid = parseInt(id);

      const student = await prisma.student.findFirst({
        where: { id: sid, schoolId },
        include: {
          user: { select: { name: true, avatarUrl: true } },
          class: { select: { name: true } },
          parentDetail: { select: { fatherName: true, fatherPhone: true } },
        },
      });
      if (!student) return reply.status(404).send({ success: false, message: "Student not found." });

      const currentYear = await safe("current academic year", () =>
        prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } }), null);

      // ── Real dues: StudentFeePlan + its installments ──
      const studentPlan = await safe("studentFeePlan lookup", () =>
        prisma.studentFeePlan.findFirst({
          where: { studentId: sid, schoolId, isActive: true, ...(currentYear ? { academicYearId: currentYear.id } : {}) },
          orderBy: { assignedAt: "desc" },
          include: {
            plan: { select: { name: true } },
            installments: {
              include: { installment: { select: { name: true, installmentNo: true, dueDate: true } } },
              orderBy: { dueDate: "asc" },
            },
          },
        }), null);

      // ── Reference data (fines, discounts, refunds, past receipts) ──
      const [discounts, fines, refunds, pastReceipts] = await Promise.all([
        safe("discounts", () => prisma.feeDiscount.findMany({ where: { studentId: sid, schoolId, isActive: true } }), [] as any[]),
        safe("fines", () => prisma.feeFine.findMany({ where: { studentId: sid, schoolId, isPaid: false } }), [] as any[]),
        safe("refunds", () => prisma.feeRefund.findMany({ where: { studentId: sid, schoolId, status: { not: "REJECTED" } }, orderBy: { createdAt: "desc" }, take: 3 }), [] as any[]),
        safe("past receipts", () => prisma.feeReceipt.findMany({
          where: { studentId: sid, schoolId, isVoid: false }, orderBy: { createdAt: "desc" }, take: 5,
          select: { id: true, receiptNo: true, amount: true, createdAt: true },
        }), [] as any[]),
      ]);

      const installments = (studentPlan?.installments ?? []).map((i: any) => ({
        id: i.id, name: i.installment.name, installmentNo: i.installment.installmentNo,
        dueDate: i.dueDate, dueAmount: i.dueAmount, paidAmount: i.paidAmount,
        fineAmount: i.fineAmount, discountAmount: i.discountAmount,
        netDue: Math.max(0, Number(i.dueAmount) + Number(i.fineAmount) - Number(i.discountAmount) - Number(i.paidAmount)),
        status: i.status, isOverdue: i.status !== "PAID" && i.status !== "WAIVED" && new Date(i.dueDate) < new Date(),
      }));

      const summary = studentPlan ? {
        planName: studentPlan.plan.name,
        totalFee: Number(studentPlan.totalAmount), totalPaid: Number(studentPlan.paidAmount),
        totalDue: Number(studentPlan.dueAmount), totalFine: Number(studentPlan.fineAmount),
        totalDiscount: Number(studentPlan.discountAmount),
      } : { planName: null, totalFee: 0, totalPaid: 0, totalDue: 0, totalFine: 0, totalDiscount: 0 };

      return reply.send({
        success: true,
        data: {
          student: {
            id: student.id, name: student.user.name, avatar: student.user.avatarUrl,
            admissionNumber: student.admissionNumber, rollNumber: student.rollNumber,
            className: student.class?.name, fatherName: student.parentDetail?.fatherName,
            fatherPhone: student.parentDetail?.fatherPhone,
          },
          studentPlanId: studentPlan?.id ?? null,
          summary, installments, discounts, fines, refunds, pastReceipts,
          noPlanAssigned: !studentPlan,
        },
      });
    }
  );

  // ═══════════════════════════════════════════════════════════
  // ─── POST /admin/fee-collection/collect — FIXED ───────────
  // Now takes installmentIds (real StudentFeeInstallment rows).
  // Updates the installments' paidAmount/status AND the parent
  // StudentFeePlan's aggregates, alongside creating the
  // Invoice/Payment/Receipt (billing + receipt record).
  //
  // ADDED: notifies the parent once the transaction commits.
  // ═══════════════════════════════════════════════════════════
  app.post("/admin/fee-collection/collect", { preHandler: [authenticate, requireCapability('finance.collection')] },
  async (req: FastifyRequest, reply: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const body = req.body as {
      studentId: number;
      academicYearId: number;
      installmentIds: number[];
      paymentAmount: number;
      paymentMode: string;
      upiRef?: string; chequeNo?: string; bankName?: string; utrNo?: string; transactionId?: string;
      discountAmount?: number; discountReason?: string;
      fineAmount?: number; fineReason?: string;
      remarks?: string;
    };
 
    if (!body.studentId || !body.installmentIds?.length || !body.paymentAmount) {
      return reply.status(400).send({ success: false, message: "studentId, installmentIds and paymentAmount required." });
    }
 
    const installments = await prisma.studentFeeInstallment.findMany({
      where: { id: { in: body.installmentIds }, studentId: body.studentId, schoolId },
      include: { installment: { select: { name: true } } },
      orderBy: { dueDate: "asc" },
    });
    if (installments.length === 0) return reply.status(404).send({ success: false, message: "No matching installments found." });
 
    let adHocFine = body.fineAmount ?? 0;
    let adHocDiscount = body.discountAmount ?? 0;
 
    // ── Pre-compute how fine/discount will distribute across installments
    // (due-date order) so we know the REAL net due before splitting payment ──
    const fineAllocations = new Map<number, number>();
    const discountAllocations = new Map<number, number>();
    let remFine = adHocFine, remDisc = adHocDiscount;
    for (const inst of installments) {
      if (remFine > 0) { fineAllocations.set(inst.id, remFine); remFine = 0; } // simplest: whole fine on first installment
      if (remDisc > 0) {
        const currentNetDue = Math.max(0, Number(inst.dueAmount) + Number(inst.fineAmount) - Number(inst.discountAmount) - Number(inst.paidAmount));
        const applied = Math.min(remDisc, currentNetDue);
        if (applied > 0) { discountAllocations.set(inst.id, applied); remDisc -= applied; }
      }
    }
 
    const totalNetDue = installments.reduce((s, i) => {
      const fineAdd = fineAllocations.get(i.id) ?? 0;
      const discAdd = discountAllocations.get(i.id) ?? 0;
      return s + Math.max(0, Number(i.dueAmount) + Number(i.fineAmount) + fineAdd - Number(i.discountAmount) - discAdd - Number(i.paidAmount));
    }, 0);
 
    const invoiceNo = await genInvoiceNo(schoolId);
    const receiptNo = await genReceiptNo(schoolId);
    const dueAfter = Math.max(0, totalNetDue - body.paymentAmount);
    const invoiceStatus = dueAfter <= 0 ? "PAID" : "PARTIAL";
 
    let transactionRef = body.transactionId ?? body.utrNo ?? body.chequeNo ?? null;
    let notes = [body.bankName ? `Bank: ${body.bankName}` : null, body.remarks].filter(Boolean).join(" | ");
 
    const result = await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          schoolId, studentId: body.studentId, academicYearId: body.academicYearId,
          createdById: userId, invoiceNumber: invoiceNo,
          totalAmount: totalNetDue, paidAmount: body.paymentAmount, dueAmount: dueAfter,
          status: invoiceStatus as any, dueDate: new Date(),
          notes: notes || null,
          items: {
            create: installments.map((i) => ({
              category: "OTHER" as any,
              description: i.installment.name,
              amount: Math.max(0, Number(i.dueAmount) + Number(i.fineAmount) + (fineAllocations.get(i.id) ?? 0) - Number(i.discountAmount) - (discountAllocations.get(i.id) ?? 0) - Number(i.paidAmount)),
            })),
          },
        },
      });
 
      const payment = await tx.payment.create({
        data: {
          invoiceId: invoice.id, receivedById: userId,
          amount: body.paymentAmount, method: body.paymentMode as any,
          receiptNumber: receiptNo, transactionId: transactionRef ?? undefined, notes: notes || null,
        },
      });
 
      const receipt = await tx.feeReceipt.create({
        data: {
          schoolId, receiptNo, invoiceId: invoice.id, paymentId: payment.id,
          studentId: body.studentId, amount: body.paymentAmount,
          qrCode: `${process.env.APP_URL ?? "https://shikshamatrix.in"}/verify-receipt/${receiptNo}`,
        },
      });
 
      // ── STEP 1: Apply fine/discount allocations onto each installment's
      // OWN fineAmount/discountAmount fields — this is the actual fix ──
      // ── STEP 2: Distribute payment across the now-updated net dues ──
      let remainingPayment = body.paymentAmount;
      for (const inst of installments) {
        const fineAdd = fineAllocations.get(inst.id) ?? 0;
        const discAdd = discountAllocations.get(inst.id) ?? 0;
        const newFineAmount = Number(inst.fineAmount) + fineAdd;
        const newDiscountAmount = Number(inst.discountAmount) + discAdd;
        const instNetDue = Math.max(0, Number(inst.dueAmount) + newFineAmount - newDiscountAmount - Number(inst.paidAmount));
 
        const applied = instNetDue > 0 ? Math.min(remainingPayment, instNetDue) : 0;
        const newPaid = Number(inst.paidAmount) + applied;
        const newNetDue = instNetDue - applied;
        remainingPayment -= applied;
 
        await tx.studentFeeInstallment.update({
          where: { id: inst.id },
          data: {
            fineAmount: newFineAmount,
            discountAmount: newDiscountAmount,
            paidAmount: newPaid,
            status: newNetDue <= 0 ? "PAID" : (newPaid > 0 ? "PARTIAL" : inst.status),
            paidAt: newNetDue <= 0 ? new Date() : undefined,
          },
        });
      }
 
      // ── Record the ad-hoc fine/discount for audit trail (unchanged) ──
      const studentPlanId = installments[0]?.studentPlanId;
      if (studentPlanId) {
        if (adHocFine > 0 && body.fineReason) {
          const fineNo = await genFineNo(schoolId);
          await tx.feeFine.create({
            data: { schoolId, studentId: body.studentId, invoiceId: invoice.id, fineNo, reason: body.fineReason, fineType: "LATE_PAYMENT", amount: adHocFine, isPaid: true, paidAt: new Date(), createdById: userId },
          });
        }
        if (adHocDiscount > 0 && body.discountReason) {
          await tx.feeDiscount.create({
            data: { schoolId, studentId: body.studentId, studentPlanId, name: body.discountReason, discountType: "FIXED_AMOUNT", category: "CUSTOM", value: adHocDiscount, isActive: true, approvedById: userId, approvedAt: new Date() },
          });
        }
 
        // ── Recompute StudentFeePlan aggregates from its (now-updated) installments ──
        const allInstallments = await tx.studentFeeInstallment.findMany({ where: { studentPlanId } });
        const planPaid = allInstallments.reduce((s, i) => s + Number(i.paidAmount), 0);
        const planFine = allInstallments.reduce((s, i) => s + Number(i.fineAmount), 0);
        const planDiscount = allInstallments.reduce((s, i) => s + Number(i.discountAmount), 0);
        const plan = await tx.studentFeePlan.findFirst({ where: { id: studentPlanId } });
        const planTotal = Number(plan?.totalAmount ?? 0);
        await tx.studentFeePlan.update({
          where: { id: studentPlanId },
          data: {
            paidAmount: planPaid, fineAmount: planFine, discountAmount: planDiscount,
            dueAmount: Math.max(0, planTotal + planFine - planDiscount - planPaid),
          },
        });
      }
 
      return { invoice, payment, receipt };
    });

    // ── Notify the parent — after the transaction commits, so a push
    // failure can never roll back or block the actual payment record.
    // Runs in the background; the API response doesn't wait on it. ──
    (async () => {
      try {
        const parentUserIds = await resolveParentUserIdsForStudent(body.studentId);
        if (parentUserIds.length === 0) return;
        const student = await prisma.student.findFirst({
          where: { id: body.studentId }, include: { user: { select: { name: true } } },
        });
        await fanOutNotification({
          schoolId,
          audienceType: "CUSTOM_SEGMENT",
          targetUserIds: parentUserIds,
          sourceType: "SYSTEM",
          sourceId: result.receipt.id,
          category: "FEES",
          priority: "NORMAL",
          title: "Fee payment received",
          body: `₹${body.paymentAmount.toLocaleString("en-IN")} received for ${student?.user?.name ?? "your child"}. Receipt ${receiptNo}.${dueAfter > 0 ? ` ₹${dueAfter.toLocaleString("en-IN")} still due.` : ""}`,
          actionUrl: `/parent/fees?studentId=${body.studentId}`,
        });
      } catch (err: any) {
        console.log("[fee-collection] parent notification failed:", err?.message ?? err);
      }
    })();
 
    return reply.status(201).send({
      success: true, message: "Payment collected successfully!",
      data: { invoiceId: result.invoice.id, receiptId: result.receipt.id, receiptNo, paymentId: result.payment.id, status: invoiceStatus, amountPaid: body.paymentAmount, dueAfter },
    });
  }
);

  // ─── GET /admin/fee-collection/receipts — unchanged ───────
  app.get("/admin/fee-collection/receipts", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; date?: string; mode?: string; search?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId, isVoid: false };
      if (q.date) { const d = new Date(q.date); const d2 = new Date(d); d2.setDate(d2.getDate()+1); where.createdAt = { gte: d, lt: d2 }; }
      if (q.search) where.OR = [{ receiptNo: { contains: q.search, mode: "insensitive" } }, { student: { user: { name: { contains: q.search, mode: "insensitive" } } } }];
      const [receipts, total] = await Promise.all([
        prisma.feeReceipt.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" },
          include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, payment: { include: { receivedBy: { select: { name: true } } } } } }),
        prisma.feeReceipt.count({ where }),
      ]);
      return reply.send({ success: true, data: { receipts, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── GET /admin/fee-collection/receipt/:id — unchanged ────
  app.get("/admin/fee-collection/receipt/:id", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const receipt = await prisma.feeReceipt.findFirst({ where: { id: parseInt(id), schoolId },
        include: { student: { include: { user: true, class: true, parentDetail: true } }, invoice: { include: { items: true } }, payment: true } });
      if (!receipt) return reply.status(404).send({ success: false, message: "Receipt not found." });
      await prisma.feeReceipt.update({ where: { id: parseInt(id) }, data: { printCount: { increment: 1 } } });
      return reply.send({ success: true, data: { receipt } });
    }
  );

  // ═══════════════════════════════════════════════════════════
  // ─── GET /admin/fee-collection/receipt/:id/pdf — ADDED ────
  // A real, properly designed receipt PDF — school letterhead, amount
  // banner, itemized breakdown, amount in words, verify link. Streams
  // straight to the browser so "Print" and "Download" both just work.
  // ═══════════════════════════════════════════════════════════
  app.get("/admin/fee-collection/receipt/:id/pdf", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const [receipt, school] = await Promise.all([
        prisma.feeReceipt.findFirst({
          where: { id: parseInt(id), schoolId },
          include: {
            student: { include: { user: true, class: true, parentDetail: true } },
            invoice: { include: { items: true, academicYear: { select: { name: true } } } },
            payment: { include: { receivedBy: { select: { name: true } } } },
          },
        }),
        prisma.school.findUnique({ where: { id: schoolId } }),
      ]);
      if (!receipt) return reply.status(404).send({ success: false, message: "Receipt not found." });

      const pdfBuffer = await generateFeeReceiptPdf({
        receiptNo: receipt.receiptNo,
        issuedAt: receipt.createdAt,
        schoolName: school?.name ?? "School",
        schoolAddress: school ? [school.address, school.city, school.state, school.pincode].filter(Boolean).join(", ") : null,
        schoolPhone: school?.phone ?? null,
        schoolEmail: school?.email ?? null,

        studentName: receipt.student.user.name,
        admissionNumber: receipt.student.admissionNumber,
        rollNumber: receipt.student.rollNumber,
        className: receipt.student.class?.name ?? null,
        fatherName: receipt.student.parentDetail?.fatherName ?? null,

        academicYear: receipt.invoice?.academicYear?.name ?? "—",
        items: (receipt.invoice?.items ?? []).map((i) => ({ description: i.description, amount: Number(i.amount) })),
        amountPaid: Number(receipt.amount),
        dueAfter: Number(receipt.invoice?.dueAmount ?? 0),

        paymentMode: receipt.payment?.method ?? "—",
        transactionRef: receipt.payment?.transactionId ?? null,
        remarks: receipt.payment?.notes ?? null,
        receivedBy: receipt.payment?.receivedBy?.name ?? null,

        verifyUrl: receipt.qrCode ?? `${process.env.APP_URL ?? "https://shikshamatrix.in"}/verify-receipt/${receipt.receiptNo}`,
      });

      await prisma.feeReceipt.update({ where: { id: parseInt(id) }, data: { printCount: { increment: 1 } } });

      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `inline; filename="${receipt.receiptNo}.pdf"`)
        .send(pdfBuffer);
    }
  );

  // ─── PATCH /admin/fee-collection/receipt/:id/void — unchanged ──
  app.patch("/admin/fee-collection/receipt/:id/void", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };
      if (!reason?.trim()) return reply.status(400).send({ success: false, message: "Void reason required." });
      await prisma.feeReceipt.updateMany({ where: { id: parseInt(id), schoolId }, data: { isVoid: true, voidedAt: new Date(), voidedById: userId, voidReason: reason } });
      return reply.send({ success: true, message: "Receipt voided." });
    }
  );

  // ─── GET /admin/fee-collection/due — unchanged ────────────
  app.get("/admin/fee-collection/due", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; classId?: string; overdue?: string; search?: string; academicYearId?: string };
      const now = new Date();
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      const where: any = { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] } };
      if (q.classId) where.student = { classId: parseInt(q.classId) };
      if (q.academicYearId) where.academicYearId = parseInt(q.academicYearId);
      if (q.overdue === "true") where.dueDate = { lt: now };
      if (q.search) where.OR = [{ invoiceNumber: { contains: q.search, mode: "insensitive" } }, { student: { user: { name: { contains: q.search, mode: "insensitive" } } } }];

      const [invoices, total, totalDue] = await Promise.all([
        prisma.invoice.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { dueDate: "asc" },
          include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } } } }),
        prisma.invoice.count({ where }),
        prisma.invoice.aggregate({ where, _sum: { dueAmount: true } }),
      ]);

      const enriched = invoices.map(inv => ({ ...inv, isOverdue: new Date(inv.dueDate) < now, daysOverdue: new Date(inv.dueDate) < now ? Math.floor((now.getTime() - new Date(inv.dueDate).getTime()) / 86400000) : 0 }));
      return reply.send({ success: true, data: { invoices: enriched, total, totalPages: Math.ceil(total/limit), totalDueAmount: Number(totalDue._sum.dueAmount ?? 0) } });
    }
  );

  // ─── GET /admin/fee-collection/fines — unchanged ──────────
  app.get("/admin/fee-collection/fines", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; isPaid?: string; search?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.isPaid !== undefined) where.isPaid = q.isPaid === "true";
      if (q.search) where.OR = [{ fineNo: { contains: q.search, mode: "insensitive" } }, { student: { user: { name: { contains: q.search, mode: "insensitive" } } } }];
      const [fines, total] = await Promise.all([
        prisma.feeFine.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" },
          include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, createdBy: { select: { name: true } } } }),
        prisma.feeFine.count({ where }),
      ]);
      return reply.send({ success: true, data: { fines, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── POST /admin/fee-collection/fines — unchanged ─────────
  app.post("/admin/fee-collection/fines", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { studentId: number; reason: string; fineType?: string; amount: number };
      if (!body.studentId || !body.amount || !body.reason) return reply.status(400).send({ success: false, message: "studentId, amount, reason required." });
      const fineNo = await genFineNo(schoolId);
      await prisma.feeFine.create({ data: { schoolId, studentId: body.studentId, fineNo, reason: body.reason, fineType: body.fineType as any ?? "CUSTOM", amount: body.amount, createdById: userId } });
      return reply.status(201).send({ success: true, message: "Fine created." });
    }
  );

  // ─── POST /admin/fee-collection/refunds — unchanged ───────
  app.post("/admin/fee-collection/refunds", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { studentId: number; invoiceId: number; amount: number; reason: string };
      if (!body.studentId || !body.invoiceId || !body.amount || !body.reason) return reply.status(400).send({ success: false, message: "All fields required." });
      const refundNo = await genRefundNo(schoolId);
      await prisma.feeRefund.create({ data: { schoolId, refundNo, studentId: body.studentId, invoiceId: body.invoiceId, amount: body.amount, reason: body.reason, status: "REQUESTED" } });
      return reply.status(201).send({ success: true, message: "Refund request created." });
    }
  );

  // ─── PATCH /admin/fee-collection/refunds/:id/approve — unchanged ──
  app.patch("/admin/fee-collection/refunds/:id/approve", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.feeRefund.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "APPROVED", approvedById: userId, approvedAt: new Date() } });
      return reply.send({ success: true, message: "Refund approved." });
    }
  );

  // ─── GET /admin/fee-collection/refunds — unchanged ────────
  app.get("/admin/fee-collection/refunds", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { status?: string; page?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status) where.status = q.status;
      const [refunds, total] = await Promise.all([
        prisma.feeRefund.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" },
          include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, approvedBy: { select: { name: true } } } }),
        prisma.feeRefund.count({ where }),
      ]);
      return reply.send({ success: true, data: { refunds, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── POST /admin/fee-collection/discounts — unchanged ─────
  app.post("/admin/fee-collection/discounts", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { studentId: number; name: string; discountType: string; category?: string; value: number; academicYearId?: number; remarks?: string };
      await prisma.feeDiscount.create({ data: { schoolId, studentId: body.studentId, name: body.name, discountType: body.discountType as any, category: body.category as any ?? "CUSTOM", value: body.value, academicYearId: body.academicYearId ?? null, remarks: body.remarks ?? null, approvedById: userId, approvedAt: new Date() } });
      return reply.status(201).send({ success: true, message: "Discount applied." });
    }
  );
}