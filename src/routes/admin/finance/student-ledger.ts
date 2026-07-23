// apps/api/src/routes/admin/student-ledger.ts
// FIX: Student model mein `section` relation nahi hai — removed from all includes
// Section name already student.class.sections se ya sectionName field se aata hai

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminStudentLedgerRoutes(app: FastifyInstance) {

  // ─── SEARCH ────────────────────────────────────────────────
  app.get("/admin/student-ledger/search", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { q } = req.query as { q: string };
      if (!q?.trim() || q.length < 2) return reply.send({ success: true, data: { students: [] } });

      const students = await prisma.student.findMany({
        where: {
          schoolId, isActive: true,
          OR: [
            { admissionNumber: { contains: q, mode: "insensitive" } },
            { rollNumber:      { contains: q, mode: "insensitive" } },
            { user:            { name: { contains: q, mode: "insensitive" } } },
            { parentDetail:    { fatherPhone: { contains: q } } },
            { parentDetail:    { motherPhone: { contains: q } } },
          ],
        },
        include: {
          user:         { select: { name: true, avatarUrl: true } },
          class:        { select: { name: true } },
          // ❌ section REMOVED — Student model mein ye relation nahi hai
          parentDetail: { select: { fatherName: true, fatherPhone: true } },
        },
        take: 10,
      });
      return reply.send({ success: true, data: { students: students.map(s => ({
        id: s.id,
        name: s.user.name,
        avatar: s.user.avatarUrl,
        admissionNumber: s.admissionNumber,
        rollNumber: s.rollNumber,
        className: s.class?.name,
        // sectionName: s.sectionId ?? null,  // agar sectionId field ho to yahan use karo
        fatherName: s.parentDetail?.fatherName,
        fatherPhone: s.parentDetail?.fatherPhone,
      }))}});
    }
  );

  // ─── FULL LEDGER ───────────────────────────────────────────
  app.get("/admin/student-ledger/:studentId", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { studentId } = req.params as { studentId: string };
      const sid = parseInt(studentId);
      const { academicYearId } = req.query as { academicYearId?: string };

      const student = await prisma.student.findFirst({
        where: { id: sid, schoolId },
        include: {
          user:         { select: { name: true, avatarUrl: true, email: true } },
          class:        { select: { name: true } },
          // ❌ section REMOVED
          parentDetail: true,
        },
      });
      if (!student) return reply.status(404).send({ success: false, message: "Student not found." });

      const invWhere: any = { studentId: sid, schoolId };
      if (academicYearId) invWhere.academicYearId = parseInt(academicYearId);

      const [invoices, payments, discounts, scholarships, fines, refunds, carryForwards, feePlan] = await Promise.all([
        prisma.invoice.findMany({ where: invWhere, include: { items: true, payments: true }, orderBy: { issuedDate: "asc" } }),
        prisma.payment.findMany({ where: { invoice: invWhere }, orderBy: { paidAt: "asc" }, include: { receivedBy: { select: { name: true } } } }),
        prisma.feeDiscount.findMany({ where: { studentId: sid, schoolId, isActive: true }, orderBy: { createdAt: "asc" } }),
        prisma.studentScholarship.findMany({ where: { studentId: sid, schoolId, isActive: true }, include: { program: { select: { name: true, scholarshipType: true } } }, orderBy: { createdAt: "asc" } }),
        prisma.feeFine.findMany({ where: { studentId: sid, schoolId }, orderBy: { createdAt: "asc" } }),
        prisma.feeRefund.findMany({ where: { studentId: sid, schoolId }, orderBy: { createdAt: "asc" } }),
        prisma.carryForward.findMany({ where: { studentId: sid, schoolId }, include: { fromAcademicYear: { select: { name: true } }, toAcademicYear: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
        prisma.studentFeePlan.findFirst({ where: { studentId: sid, schoolId }, include: { plan: { include: { heads: true } }, installments: { include: { installment: true }, orderBy: { installment: { installmentNo: "asc" } } } }, orderBy: { assignedAt: "desc" } }),
      ]);

      const totalFee      = invoices.reduce((s,i) => s + Number(i.totalAmount), 0);
      const totalPaid     = invoices.reduce((s,i) => s + Number(i.paidAmount), 0);
      const totalDue      = invoices.reduce((s,i) => s + Number(i.dueAmount), 0);
      const totalDiscount = discounts.reduce((s,d) => s + Number(d.value), 0) + scholarships.reduce((s,sch) => s + Number(sch.benefitAmount ?? 0), 0);
      const totalFine     = fines.reduce((s,f) => s + Number(f.amount), 0);
      const totalRefund   = refunds.filter(r => r.status === "PROCESSED").reduce((s,r) => s + Number(r.amount), 0);

      return reply.send({ success: true, data: {
        student: {
          id: student.id,
          name: student.user.name,
          avatar: student.user.avatarUrl,
          email: student.user.email,
          admissionNumber: student.admissionNumber,
          rollNumber: student.rollNumber,
          className: student.class?.name,
          // ❌ sectionName removed — add if your schema has it differently
          parentDetail: student.parentDetail,
          openingDue: Number((student as any).openingDueBalance ?? 0),
        },
        summary: { totalFee, totalPaid, totalDue, totalDiscount, totalFine, totalRefund },
        invoices, payments, discounts, scholarships, fines, refunds, carryForwards, feePlan,
      }});
    }
  );

  // ─── LEDGER TIMELINE (Passbook) ────────────────────────────
  app.get("/admin/student-ledger/:studentId/timeline", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { studentId } = req.params as { studentId: string };
      const sid = parseInt(studentId);
      const { academicYearId } = req.query as { academicYearId?: string };

      const invWhere: any = { studentId: sid, schoolId };
      if (academicYearId) invWhere.academicYearId = parseInt(academicYearId);

      const [invoices, payments, fines, refunds, discounts, carryForwards] = await Promise.all([
        prisma.invoice.findMany({ where: invWhere, include: { items: true }, orderBy: { issuedDate: "asc" } }),
        prisma.payment.findMany({ where: { invoice: invWhere }, orderBy: { paidAt: "asc" } }),
        prisma.feeFine.findMany({ where: { studentId: sid, schoolId }, orderBy: { createdAt: "asc" } }),
        prisma.feeRefund.findMany({ where: { studentId: sid, schoolId, status: "PROCESSED" }, orderBy: { processedAt: "asc" } }),
        prisma.feeDiscount.findMany({ where: { studentId: sid, schoolId, isActive: true }, orderBy: { createdAt: "asc" } }),
        prisma.carryForward.findMany({ where: { studentId: sid, schoolId, status: "APPLIED" }, orderBy: { appliedAt: "asc" } }),
      ]);

      const events: {date: Date; type: string; description: string; debit: number; credit: number; reference?: string}[] = [];

      invoices.forEach(inv => {
        events.push({ date: new Date(inv.issuedDate), type: "INVOICE", description: `Fee generated — ${inv.invoiceNumber}`, debit: Number(inv.totalAmount), credit: 0, reference: inv.invoiceNumber });
      });
      payments.forEach(p => {
        events.push({ date: new Date(p.paidAt), type: "PAYMENT", description: `Payment received — ${p.receiptNumber ?? ""} (${p.method})`, debit: 0, credit: Number(p.amount), reference: p.receiptNumber ?? undefined });
      });
      fines.forEach(f => {
        events.push({ date: new Date(f.createdAt), type: "FINE", description: `Fine applied — ${f.reason}`, debit: Number(f.amount), credit: 0 });
      });
      refunds.forEach(r => {
        events.push({ date: new Date(r.processedAt ?? r.createdAt), type: "REFUND", description: `Refund processed — ${r.refundNo}`, debit: 0, credit: Number(r.amount), reference: r.refundNo });
      });
      discounts.forEach(d => {
        events.push({ date: new Date(d.createdAt), type: "DISCOUNT", description: `Discount applied — ${d.name}`, debit: 0, credit: Number(d.value) });
      });
      carryForwards.forEach(cf => {
        events.push({ date: new Date(cf.appliedAt ?? cf.createdAt), type: "CARRY_FORWARD", description: `Due carried forward from ${(cf as any).fromAcademicYear?.name ?? "prev session"}`, debit: Number(cf.carriedAmount), credit: 0 });
      });

      events.sort((a, b) => a.date.getTime() - b.date.getTime());

      let balance = 0;
      const timeline = events.map(ev => {
        balance = balance + ev.debit - ev.credit;
        return { ...ev, date: ev.date.toISOString(), balance: Math.max(0, balance) };
      });

      return reply.send({ success: true, data: { timeline, finalBalance: Math.max(0, balance) } });
    }
  );

  // ─── YEAR-WISE SUMMARY ─────────────────────────────────────
  app.get("/admin/student-ledger/:studentId/year-wise", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { studentId } = req.params as { studentId: string };
      const sid = parseInt(studentId);

      const years = await prisma.academicYear.findMany({ where: { schoolId }, orderBy: { startDate: "desc" } });
      const summary = await Promise.all(years.map(async y => {
        const [inv, pay, disc, fine] = await Promise.all([
          prisma.invoice.aggregate({ where: { studentId: sid, schoolId, academicYearId: y.id }, _sum: { totalAmount: true, paidAmount: true, dueAmount: true } }),
          prisma.payment.count({ where: { invoice: { studentId: sid, schoolId, academicYearId: y.id } } }),
          prisma.feeDiscount.aggregate({ where: { studentId: sid, schoolId, academicYearId: y.id }, _sum: { value: true } }),
          prisma.feeFine.aggregate({ where: { studentId: sid, schoolId }, _sum: { amount: true } }),
        ]);
        return {
          yearId: y.id, yearName: y.name,
          totalFee:     Number(inv._sum.totalAmount ?? 0),
          totalPaid:    Number(inv._sum.paidAmount ?? 0),
          totalDue:     Number(inv._sum.dueAmount ?? 0),
          payments:     pay,
          discounts:    Number(disc._sum.value ?? 0),
          fines:        Number(fine._sum.amount ?? 0),
        };
      }));
      return reply.send({ success: true, data: { years: summary.filter(s => s.totalFee > 0) } });
    }
  );

  // ─── DOCUMENTS & RECEIPTS ──────────────────────────────────
  app.get("/admin/student-ledger/:studentId/documents", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { studentId } = req.params as { studentId: string };
      const sid = parseInt(studentId);

      const [receipts, refunds] = await Promise.all([
        prisma.feeReceipt.findMany({ where: { studentId: sid, schoolId, isVoid: false }, orderBy: { createdAt: "desc" },
          include: { payment: { include: { receivedBy: { select: { name: true } } } }, invoice: { include: { items: true } } } }),
        prisma.feeRefund.findMany({ where: { studentId: sid, schoolId }, orderBy: { createdAt: "desc" } }),
      ]);
      return reply.send({ success: true, data: { receipts, refunds } });
    }
  );

  // ─── REPORT DATA (for PDF) ─────────────────────────────────
  app.get("/admin/student-ledger/:studentId/report", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { studentId } = req.params as { studentId: string };
      const sid = parseInt(studentId);

      const [student, school, invoices, payments, discounts, scholarships, fines, refunds] = await Promise.all([
        prisma.student.findFirst({ where: { id: sid, schoolId },
          include: {
            user:         true,
            class:        true,
            // ❌ section REMOVED
            parentDetail: true,
          }
        }),
        prisma.school.findUnique({ where: { id: schoolId }, select: { name: true, address: true, phone: true, logo: true } }),
        prisma.invoice.findMany({ where: { studentId: sid, schoolId }, include: { items: true }, orderBy: { issuedDate: "asc" } }),
        prisma.payment.findMany({ where: { invoice: { studentId: sid, schoolId } }, orderBy: { paidAt: "asc" } }),
        prisma.feeDiscount.findMany({ where: { studentId: sid, schoolId, isActive: true } }),
        prisma.studentScholarship.findMany({ where: { studentId: sid, schoolId, status: "APPROVED" } }),
        prisma.feeFine.findMany({ where: { studentId: sid, schoolId } }),
        prisma.feeRefund.findMany({ where: { studentId: sid, schoolId, status: "PROCESSED" } }),
      ]);

      // Build timeline
      const evts: any[] = [];
      invoices.forEach(inv => evts.push({ date: inv.issuedDate, type: "INVOICE", description: "Fee Created", amount: Number(inv.totalAmount), isDebit: true }));
      payments.forEach(pay => evts.push({ date: pay.paidAt, type: "PAYMENT", description: `Payment (${pay.method})`, amount: Number(pay.amount), isDebit: false }));
      evts.sort((a,b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      let bal = 0;
      const timeline = evts.map(e => { bal += e.isDebit ? e.amount : -e.amount; return { ...e, balance: Math.max(0, bal) }; });

      return reply.send({ success: true, data: {
        generatedAt: new Date().toISOString(),
        school,
        student: { ...student, className: student?.class?.name },
        summary: {
          totalFee:      invoices.reduce((s,i) => s + Number(i.totalAmount), 0),
          totalPaid:     payments.reduce((s,p) => s + Number(p.amount), 0),
          totalDue:      invoices.reduce((s,i) => s + Number(i.dueAmount), 0),
          totalDiscount: discounts.reduce((s,d) => s + Number(d.value), 0),
          totalFine:     fines.reduce((s,f) => s + Number(f.amount), 0),
          totalRefund:   refunds.reduce((s,r) => s + Number(r.amount), 0),
        },
        invoices, payments, discounts, scholarships, fines, refunds, timeline,
      }});
    }
  );

  // ─── ACADEMIC YEARS (for filter dropdown) ──────────────────
  app.get("/admin/student-ledger/academic-years", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const years = await prisma.academicYear.findMany({ where: { schoolId }, orderBy: { startDate: "desc" } });
      return reply.send({ success: true, data: { years } });
    }
  );
}