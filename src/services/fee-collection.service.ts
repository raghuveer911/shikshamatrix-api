import { prisma } from "../lib/prisma.js";

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

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[fee-collection.service] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function searchStudentsForFeeCollection(schoolId: number, q: string) {
  if (!q?.trim() || q.trim().length < 2) return [];

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

  return students.map(s => ({
    id: s.id, name: s.user.name, avatar: s.user.avatarUrl,
    admissionNumber: s.admissionNumber, rollNumber: s.rollNumber,
    className: s.class?.name ?? "—",
    fatherName: s.parentDetail?.fatherName ?? "", fatherPhone: s.parentDetail?.fatherPhone ?? "",
  }));
}

export async function getStudentFeeDetails(schoolId: number, studentId: number) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId },
    include: {
      user: { select: { name: true, avatarUrl: true } },
      class: { select: { name: true } },
      parentDetail: { select: { fatherName: true, fatherPhone: true } },
    },
  });
  if (!student) return null;

  const currentYear = await safe("current academic year", () =>
    prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } }), null);

  const studentPlan = await safe("studentFeePlan lookup", () =>
    prisma.studentFeePlan.findFirst({
      where: { studentId, schoolId, isActive: true, ...(currentYear ? { academicYearId: currentYear.id } : {}) },
      include: {
        plan: { select: { name: true } },
        installments: {
          include: { installment: { select: { name: true, installmentNo: true, dueDate: true } } },
          orderBy: { dueDate: "asc" },
        },
      },
    }), null);

  const [discounts, fines, refunds, pastReceipts] = await Promise.all([
    safe("discounts", () => prisma.feeDiscount.findMany({ where: { studentId, schoolId, isActive: true } }), [] as any[]),
    safe("fines", () => prisma.feeFine.findMany({ where: { studentId, schoolId, isPaid: false } }), [] as any[]),
    safe("refunds", () => prisma.feeRefund.findMany({ where: { studentId, schoolId, status: { not: "REJECTED" } }, orderBy: { createdAt: "desc" }, take: 3 }), [] as any[]),
    safe("past receipts", () => prisma.feeReceipt.findMany({
      where: { studentId, schoolId, isVoid: false }, orderBy: { createdAt: "desc" }, take: 5,
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

  return {
    student: {
      id: student.id, name: student.user.name, avatar: student.user.avatarUrl,
      admissionNumber: student.admissionNumber, rollNumber: student.rollNumber,
      className: student.class?.name, fatherName: student.parentDetail?.fatherName,
      fatherPhone: student.parentDetail?.fatherPhone,
    },
    academicYearId: currentYear?.id ?? null,
    studentPlanId: studentPlan?.id ?? null,
    summary, installments, discounts, fines, refunds, pastReceipts,
    noPlanAssigned: !studentPlan,
  };
}

export interface CollectPaymentInput {
  studentId: number;
  academicYearId: number;
  installmentIds: number[];
  paymentAmount: number;
  paymentMode: string;
  upiRef?: string; chequeNo?: string; bankName?: string; utrNo?: string; transactionId?: string;
  discountAmount?: number; discountReason?: string;
  fineAmount?: number; fineReason?: string;
  remarks?: string;
}

export class FeeCollectionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function collectFeePayment(schoolId: number, collectedById: number, body: CollectPaymentInput) {
  if (!body.studentId || !body.installmentIds?.length || !body.paymentAmount) {
    throw new FeeCollectionError(400, "studentId, installmentIds and paymentAmount required.");
  }

  const installments = await prisma.studentFeeInstallment.findMany({
    where: { id: { in: body.installmentIds }, studentId: body.studentId, schoolId },
    include: { installment: { select: { name: true } } },
    orderBy: { dueDate: "asc" },
  });
  if (installments.length === 0) throw new FeeCollectionError(404, "No matching installments found.");

  let adHocFine = body.fineAmount ?? 0;
  let adHocDiscount = body.discountAmount ?? 0;

  const fineAllocations = new Map<number, number>();
  const discountAllocations = new Map<number, number>();
  let remFine = adHocFine, remDisc = adHocDiscount;
  for (const inst of installments) {
    if (remFine > 0) { fineAllocations.set(inst.id, remFine); remFine = 0; }
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
        createdById: collectedById, invoiceNumber: invoiceNo,
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
        invoiceId: invoice.id, receivedById: collectedById,
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

    const studentPlanId = installments[0]?.studentPlanId;
    if (studentPlanId) {
      if (adHocFine > 0 && body.fineReason) {
        const fineNo = await genFineNo(schoolId);
        await tx.feeFine.create({
          data: { schoolId, studentId: body.studentId, invoiceId: invoice.id, fineNo, reason: body.fineReason, fineType: "LATE_PAYMENT", amount: adHocFine, isPaid: true, paidAt: new Date(), createdById: collectedById },
        });
      }
      if (adHocDiscount > 0 && body.discountReason) {
        await tx.feeDiscount.create({
          data: { schoolId, studentId: body.studentId, studentPlanId, name: body.discountReason, discountType: "FIXED_AMOUNT", category: "CUSTOM", value: adHocDiscount, isActive: true, approvedById: collectedById, approvedAt: new Date() },
        });
      }

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

  return {
    invoiceId: result.invoice.id, receiptId: result.receipt.id, receiptNo,
    paymentId: result.payment.id, status: invoiceStatus, amountPaid: body.paymentAmount, dueAfter,
  };
}

export async function getReceiptDetail(schoolId: number, receiptId: number) {
  const receipt = await prisma.feeReceipt.findFirst({
    where: { id: receiptId, schoolId },
    include: { student: { include: { user: true, class: true, parentDetail: true } }, invoice: { include: { items: true } }, payment: true },
  });
  if (!receipt) return null;
  await prisma.feeReceipt.update({ where: { id: receiptId }, data: { printCount: { increment: 1 } } });
  return receipt;
}
