// apps/api/src/routes/admin/due-management.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

async function genNoticeNo(schoolId: number) {
  const cnt = await prisma.dueNotice.count({ where: { schoolId } });
  return `NTC-${String(cnt + 1).padStart(5, "0")}`;
}
async function genWaiverNo(schoolId: number) {
  const cnt = await prisma.dueWaiver.count({ where: { schoolId } });
  return `WVR-${String(cnt + 1).padStart(5, "0")}`;
}

export async function adminDueManagementRoutes(app: FastifyInstance) {

  // ─── DASHBOARD ─────────────────────────────────────────────
  app.get("/admin/due-management/dashboard", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const prevMonth  = new Date(now.getFullYear(), now.getMonth() - 1, 1);

      const [totalDue, overdueAgg, dueStudents, recoveredThisMonth, pendingNotices,
             agingBuckets, recentFollowUps, recoveryTrend] = await Promise.all([

        prisma.invoice.aggregate({
          where: { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] } },
          _sum: { dueAmount: true }, _count: true,
        }),
        prisma.invoice.aggregate({
          where: { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] }, dueDate: { lt: now } },
          _sum: { dueAmount: true }, _count: true,
        }),
        prisma.invoice.groupBy({
          by: ["studentId"],
          where: { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] } },
          _count: true,
        }),
        prisma.payment.aggregate({
          where: { invoice: { schoolId }, paidAt: { gte: monthStart } },
          _sum: { amount: true },
        }),
        prisma.dueNotice.count({ where: { schoolId, status: "DRAFT" } }),

        // Aging buckets (overdue by days)
        Promise.all([
          prisma.invoice.aggregate({ where: { schoolId, dueDate: { lt: now, gte: new Date(now.getTime() - 30*86400000) }, status: { in: ["PENDING","PARTIAL","OVERDUE"] } }, _sum: { dueAmount: true }, _count: true }),
          prisma.invoice.aggregate({ where: { schoolId, dueDate: { lt: new Date(now.getTime() - 30*86400000), gte: new Date(now.getTime() - 60*86400000) }, status: { in: ["PENDING","PARTIAL","OVERDUE"] } }, _sum: { dueAmount: true }, _count: true }),
          prisma.invoice.aggregate({ where: { schoolId, dueDate: { lt: new Date(now.getTime() - 60*86400000), gte: new Date(now.getTime() - 90*86400000) }, status: { in: ["PENDING","PARTIAL","OVERDUE"] } }, _sum: { dueAmount: true }, _count: true }),
          prisma.invoice.aggregate({ where: { schoolId, dueDate: { lt: new Date(now.getTime() - 90*86400000) }, status: { in: ["PENDING","PARTIAL","OVERDUE"] } }, _sum: { dueAmount: true }, _count: true }),
        ]),

        prisma.dueFollowUp.findMany({ where: { schoolId, isDone: false, scheduledDate: { lte: now } }, orderBy: { scheduledDate: "asc" }, take: 5, include: { student: { include: { user: { select: { name: true } } } }, assignedTo: { select: { name: true } } } }),

        // 6-month recovery trend
        Promise.all(Array.from({ length: 6 }, (_, i) => {
          const d1 = new Date(); d1.setDate(1); d1.setMonth(d1.getMonth() - (5 - i));
          const d2 = new Date(d1); d2.setMonth(d2.getMonth() + 1);
          return prisma.payment.aggregate({ where: { invoice: { schoolId }, paidAt: { gte: d1, lt: d2 } }, _sum: { amount: true } })
            .then(r => ({ label: d1.toLocaleDateString("en-IN", { month: "short", year: "2-digit" }), recovered: Number(r._sum.amount ?? 0) }));
        })),
      ]);

      const recoveredPrevMonth = await prisma.payment.aggregate({ where: { invoice: { schoolId }, paidAt: { gte: prevMonth, lt: monthStart } }, _sum: { amount: true } });
      const prevRecovered = Number(recoveredPrevMonth._sum.amount ?? 0);
      const currRecovered = Number(recoveredThisMonth._sum.amount ?? 0);
      const recoveryRate  = prevRecovered > 0 ? ((currRecovered / prevRecovered) * 100).toFixed(1) : null;

      const [b1, b2, b3, b4] = agingBuckets as any[];
      return reply.send({ success: true, data: {
        kpi: {
          totalDueAmount:   Number(totalDue._sum.dueAmount ?? 0),
          overdueAmount:    Number(overdueAgg._sum.dueAmount ?? 0),
          overdueCount:     overdueAgg._count,
          dueStudents:      dueStudents.length,
          recoveredThisMonth: Number(recoveredThisMonth._sum.amount ?? 0),
          pendingNotices,
          recoveryRate,
        },
        aging: [
          { label: "1-30 Days",  amount: Number(b1._sum.dueAmount ?? 0), count: b1._count },
          { label: "31-60 Days", amount: Number(b2._sum.dueAmount ?? 0), count: b2._count },
          { label: "61-90 Days", amount: Number(b3._sum.dueAmount ?? 0), count: b3._count },
          { label: "90+ Days",   amount: Number(b4._sum.dueAmount ?? 0), count: b4._count },
        ],
        recoveryTrend,
        recentFollowUps,
      }});
    }
  );

  // ─── DUE STUDENTS LIST ─────────────────────────────────────
  app.get("/admin/due-management/students", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; classId?: string; overdue?: string; minDue?: string; maxDue?: string; search?: string; academicYearId?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 25;
      const now = new Date();
      const where: any = { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] } };
      if (q.classId)       where.student = { classId: parseInt(q.classId) };
      if (q.academicYearId) where.academicYearId = parseInt(q.academicYearId);
      if (q.overdue === "true") where.dueDate = { lt: now };
      if (q.minDue) where.dueAmount = { ...where.dueAmount, gte: parseFloat(q.minDue) };
      if (q.maxDue) where.dueAmount = { ...where.dueAmount, lte: parseFloat(q.maxDue) };
      if (q.search) where.student = { ...where.student, user: { name: { contains: q.search, mode: "insensitive" } } };

      const [invoices, total, totalDue] = await Promise.all([
        prisma.invoice.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { dueDate: "asc" },
          include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } }, parentDetail: { select: { fatherName: true, fatherPhone: true } } } } } }),
        prisma.invoice.count({ where }),
        prisma.invoice.aggregate({ where, _sum: { dueAmount: true } }),
      ]);
      const enriched = invoices.map(inv => ({
        ...inv, isOverdue: new Date(inv.dueDate) < now,
        daysOverdue: new Date(inv.dueDate) < now ? Math.floor((now.getTime() - new Date(inv.dueDate).getTime()) / 86400000) : 0,
        priority: (() => { const d = Math.floor((now.getTime() - new Date(inv.dueDate).getTime()) / 86400000); if (d > 90) return "CRITICAL"; if (d > 60) return "HIGH"; if (d > 30) return "MEDIUM"; return "LOW"; })(),
      }));
      return reply.send({ success: true, data: { invoices: enriched, total, totalPages: Math.ceil(total/limit), totalDueAmount: Number(totalDue._sum.dueAmount ?? 0) } });
    }
  );

  // ─── STUDENT DUE DRAWER ────────────────────────────────────
  app.get("/admin/due-management/student/:studentId", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { studentId } = req.params as { studentId: string };
      const sid = parseInt(studentId);
      const now = new Date();

      const [student, invoices, feePlan, notices, followUps, waivers] = await Promise.all([
        prisma.student.findFirst({ where: { id: sid, schoolId }, include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } }, parentDetail: { select: { fatherName: true, fatherPhone: true, motherPhone: true, whatsappNumber: true } } } }),
        prisma.invoice.findMany({ where: { studentId: sid, schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] } }, include: { items: true, payments: true }, orderBy: { dueDate: "asc" } }),
        prisma.studentFeePlan.findFirst({ where: { studentId: sid, schoolId }, include: { plan: true, installments: { include: { installment: true }, orderBy: { installment: { installmentNo: "asc" } } } }, orderBy: { assignedAt: "desc" } }),
        prisma.dueNotice.findMany({ where: { studentId: sid, schoolId }, orderBy: { createdAt: "desc" }, take: 5 }),
        prisma.dueFollowUp.findMany({ where: { studentId: sid, schoolId }, orderBy: { scheduledDate: "desc" }, take: 5, include: { assignedTo: { select: { name: true } }, createdBy: { select: { name: true } } } }),
        prisma.dueWaiver.findMany({ where: { studentId: sid, schoolId }, orderBy: { createdAt: "desc" }, take: 3 }),
      ]);
      if (!student) return reply.status(404).send({ success: false, message: "Student not found." });

      const totalDue  = invoices.reduce((s, i) => s + Number(i.dueAmount), 0);
      const totalPaid = invoices.reduce((s, i) => s + Number(i.paidAmount), 0);
      const maxOverdue = invoices.reduce((mx, i) => { const d = Math.floor((now.getTime() - new Date(i.dueDate).getTime()) / 86400000); return Math.max(mx, d); }, 0);

      return reply.send({ success: true, data: { student, invoices, feePlan, notices, followUps, waivers, summary: { totalDue, totalPaid, overdueInvoices: invoices.filter(i => new Date(i.dueDate) < now).length, maxOverdueDays: maxOverdue } } });
    }
  );

  // ─── UPCOMING DUES ─────────────────────────────────────────
  app.get("/admin/due-management/upcoming", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { days = "30" } = req.query as { days?: string };
      const from = new Date(); const to = new Date(from.getTime() + parseInt(days)*86400000);
      const invoices = await prisma.invoice.findMany({
        where: { schoolId, status: { in: ["PENDING","PARTIAL"] }, dueDate: { gte: from, lte: to } },
        orderBy: { dueDate: "asc" }, take: 50,
        include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } } },
      });
      return reply.send({ success: true, data: { invoices, count: invoices.length, totalAmount: invoices.reduce((s,i) => s + Number(i.dueAmount), 0) } });
    }
  );

  // ─── NOTICES ───────────────────────────────────────────────
  app.post("/admin/due-management/notices", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { studentIds: number[]; noticeType: string; delivery: string; subject?: string; body?: string; sendNow?: boolean };
      if (!body.studentIds?.length) return reply.status(400).send({ success: false, message: "studentIds required." });

      let created = 0;
      for (const sid of body.studentIds) {
        const invoice = await prisma.invoice.findFirst({ where: { studentId: sid, schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] } }, orderBy: { dueDate: "asc" } });
        const noticeNo = await genNoticeNo(schoolId);
        const dueAmt = invoice ? Number(invoice.dueAmount) : 0;
        await prisma.dueNotice.create({ data: {
          schoolId, noticeNo, studentId: sid, invoiceId: invoice?.id ?? null,
          noticeType: body.noticeType as any ?? "REMINDER",
          delivery: body.delivery as any ?? "APP",
          subject: body.subject ?? `Fee Due Reminder — ₹${dueAmt.toLocaleString("en-IN")}`,
          body: body.body ?? `This is a reminder that your fee of ₹${dueAmt.toLocaleString("en-IN")} is due.`,
          dueAmount: dueAmt, dueDate: invoice?.dueDate ?? null,
          status: body.sendNow ? "SENT" : "DRAFT",
          sentAt: body.sendNow ? new Date() : null,
          createdById: userId,
        }});
        created++;
      }
      return reply.status(201).send({ success: true, message: `${created} notice${created !== 1 ? "s" : ""} created${body.sendNow ? " and sent" : ""}.`, data: { created } });
    }
  );

  app.get("/admin/due-management/notices", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; status?: string; type?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status) where.status     = q.status;
      if (q.type)   where.noticeType = q.type;
      const [notices, total] = await Promise.all([
        prisma.dueNotice.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" }, include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, createdBy: { select: { name: true } } } }),
        prisma.dueNotice.count({ where }),
      ]);
      return reply.send({ success: true, data: { notices, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  app.patch("/admin/due-management/notices/:id/send", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      await prisma.dueNotice.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "SENT", sentAt: new Date() } });
      return reply.send({ success: true, message: "Notice sent." });
    }
  );

  // ─── FOLLOW-UPS ────────────────────────────────────────────
  app.post("/admin/due-management/follow-ups", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { studentId: number; invoiceId?: number; scheduledDate: string; scheduledTime?: string; assignedToId?: number; notes?: string; contactMethod?: string; expectedPayDate?: string; expectedAmount?: number };
      if (!body.studentId || !body.scheduledDate) return reply.status(400).send({ success: false, message: "studentId and scheduledDate required." });
      await prisma.dueFollowUp.create({ data: { schoolId, createdById: userId, studentId: body.studentId, invoiceId: body.invoiceId ?? null, scheduledDate: new Date(body.scheduledDate), scheduledTime: body.scheduledTime ?? null, assignedToId: body.assignedToId ?? null, notes: body.notes ?? null, contactMethod: body.contactMethod ?? "PHONE", expectedPayDate: body.expectedPayDate ? new Date(body.expectedPayDate) : null, expectedAmount: body.expectedAmount ?? null } });
      return reply.status(201).send({ success: true, message: "Follow-up scheduled." });
    }
  );

  app.get("/admin/due-management/follow-ups", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; isDone?: string; assignedToId?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.isDone !== undefined)  where.isDone      = q.isDone === "true";
      if (q.assignedToId)          where.assignedToId = parseInt(q.assignedToId);
      const [followUps, total] = await Promise.all([
        prisma.dueFollowUp.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { scheduledDate: "asc" }, include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, assignedTo: { select: { name: true } } } }),
        prisma.dueFollowUp.count({ where }),
      ]);
      return reply.send({ success: true, data: { followUps, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  app.patch("/admin/due-management/follow-ups/:id/complete", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const { result, resultNotes, commitmentReceived, expectedPayDate, expectedAmount } = req.body as { result: string; resultNotes?: string; commitmentReceived?: boolean; expectedPayDate?: string; expectedAmount?: number };
      await prisma.dueFollowUp.updateMany({ where: { id: parseInt(id), schoolId }, data: { isDone: true, doneAt: new Date(), result: result as any, resultNotes: resultNotes ?? null, commitmentReceived: commitmentReceived ?? false, expectedPayDate: expectedPayDate ? new Date(expectedPayDate) : null, expectedAmount: expectedAmount ?? null } });
      return reply.send({ success: true, message: "Follow-up completed." });
    }
  );

  // ─── WAIVERS ───────────────────────────────────────────────
  app.post("/admin/due-management/waivers", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { studentId: number; invoiceId?: number; waiverType: string; requestedAmount: number; reason: string; supportingDoc?: string };
      if (!body.studentId || !body.requestedAmount || !body.reason) return reply.status(400).send({ success: false, message: "studentId, requestedAmount and reason required." });
      const waiverNo = await genWaiverNo(schoolId);
      const w = await prisma.dueWaiver.create({ data: { schoolId, waiverNo, requestedById: userId, studentId: body.studentId, invoiceId: body.invoiceId ?? null, waiverType: body.waiverType as any ?? "PARTIAL_FEE_WAIVER", requestedAmount: body.requestedAmount, reason: body.reason, supportingDoc: body.supportingDoc ?? null, status: "PENDING" } });
      return reply.status(201).send({ success: true, message: "Waiver request submitted.", data: { id: w.id, waiverNo } });
    }
  );

  app.get("/admin/due-management/waivers", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; status?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status) where.status = q.status;
      const [waivers, total] = await Promise.all([
        prisma.dueWaiver.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" }, include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, requestedBy: { select: { name: true } } } }),
        prisma.dueWaiver.count({ where }),
      ]);
      return reply.send({ success: true, data: { waivers, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  app.patch("/admin/due-management/waivers/:id/approve", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any; const { id } = req.params as { id: string };
      const { level, approvedAmount } = req.body as { level: "accountant" | "principal" | "management"; approvedAmount?: number };
      const data: any = {};
      if (level === "accountant")  { data.accountantApprovedById = userId; data.accountantApprovedAt = new Date(); }
      if (level === "principal")   { data.principalApprovedById  = userId; data.principalApprovedAt  = new Date(); }
      if (level === "management")  { data.mgmtApprovedById       = userId; data.mgmtApprovedAt       = new Date(); data.status = "APPROVED"; if (approvedAmount) data.approvedAmount = approvedAmount; }
      await prisma.dueWaiver.updateMany({ where: { id: parseInt(id), schoolId }, data });
      return reply.send({ success: true, message: `Waiver ${level === "management" ? "approved" : `approved by ${level}`}.` });
    }
  );

  app.patch("/admin/due-management/waivers/:id/reject", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any; const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };
      await prisma.dueWaiver.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "REJECTED", rejectedById: userId, rejectedAt: new Date(), rejectionReason: reason } });
      return reply.send({ success: true, message: "Waiver rejected." });
    }
  );

  // ─── REPORTS ───────────────────────────────────────────────
  app.get("/admin/due-management/reports", { preHandler: [authenticate, requireCapability('finance.dueManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const [byClass, byAging, collectionEff] = await Promise.all([
        prisma.$queryRaw<{ className: string; dueCount: number; dueAmount: number }[]>`
          SELECT c.name AS "className", COUNT(i.id) AS "dueCount", SUM(i."dueAmount") AS "dueAmount"
          FROM classes c
          JOIN students s ON s."classId" = c.id
          JOIN invoices i ON i."studentId" = s.id AND i."schoolId" = ${schoolId} AND i.status IN ('PENDING','PARTIAL','OVERDUE')
          WHERE c."schoolId" = ${schoolId} GROUP BY c.name ORDER BY "dueAmount" DESC
        `.catch(() => []),
        prisma.$queryRaw<{ bucket: string; count: number; amount: number }[]>`
          SELECT
            CASE
              WHEN CURRENT_DATE - "dueDate"::date <= 30  THEN '1-30 Days'
              WHEN CURRENT_DATE - "dueDate"::date <= 60  THEN '31-60 Days'
              WHEN CURRENT_DATE - "dueDate"::date <= 90  THEN '61-90 Days'
              ELSE '90+ Days'
            END AS bucket,
            COUNT(*) AS count,
            SUM("dueAmount") AS amount
          FROM invoices
          WHERE "schoolId" = ${schoolId} AND status IN ('PENDING','PARTIAL','OVERDUE') AND "dueDate" < CURRENT_DATE
          GROUP BY bucket ORDER BY amount DESC
        `.catch(() => []),
        prisma.invoice.aggregate({ where: { schoolId }, _sum: { totalAmount: true, paidAmount: true } }),
      ]);

      const totalBilled = Number(collectionEff._sum.totalAmount ?? 0);
      const totalPaid   = Number(collectionEff._sum.paidAmount ?? 0);
      const collEff     = totalBilled > 0 ? ((totalPaid / totalBilled) * 100).toFixed(1) : "0";

      return reply.send({ success: true, data: {
        byClass: Array.isArray(byClass) ? byClass.map(r => ({ ...r, dueCount: Number(r.dueCount), dueAmount: Number(r.dueAmount) })) : [],
        byAging: Array.isArray(byAging) ? byAging.map(r => ({ ...r, count: Number(r.count), amount: Number(r.amount) })) : [],
        collectionEfficiency: collEff,
      }});
    }
  );
}
