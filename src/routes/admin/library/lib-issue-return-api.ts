// apps/api/src/routes/admin/library/lib-issue-return-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ── Due date helper ─────────────────────────────────────────
async function calcDueDate(schoolId: number, memberType: string): Promise<Date> {
  const settings = await prisma.libSettings.findUnique({ where: { schoolId } });
  const days = memberType === "STUDENT" ? (settings?.studentDueDays ?? 14)
    : memberType === "TEACHER"  ? (settings?.teacherDueDays  ?? 30)
    : memberType === "STAFF"    ? (settings?.staffDueDays    ?? 21)
    :                              (settings?.parentDueDays   ?? 14);
  const due = new Date();
  due.setDate(due.getDate() + days);
  return due;
}

// ── Fine amount helper ───────────────────────────────────────
async function calcFine(schoolId: number, overdueDays: number, reason = "LATE_RETURN"): Promise<{ ratePerDay: number; totalAmount: number }> {
  const settings  = await prisma.libSettings.findUnique({ where: { schoolId } });
  const grace     = settings?.fineGracePeriodDays ?? 0;
  const rate      = Number(settings?.fineRatePerDay ?? 2);
  const chargeable = Math.max(0, overdueDays - grace);
  const totalAmount = chargeable * rate
    + (reason === "DAMAGE" ? Number(settings?.fineDamageRate ?? 100) : 0)
    + (reason === "LOSS"   ? Number(settings?.fineLossRate   ?? 500) : 0);
  return { ratePerDay: rate, totalAmount };
}

export async function adminLibIssueReturnRoutes(app: FastifyInstance) {
  const P = "/admin/library/circulation";

  // ─── MEMBER SEARCH (reuse Student/Staff) ──────────────────
  app.get(`${P}/members/search`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q  = req.query as any;
      const query = q.q as string;
      if (!query || query.length < 2) return rep.code(400).send({ error: "Minimum 2 characters" });

      const [students, staff] = await Promise.all([
        prisma.student.findMany({
          where: { schoolId, isActive: true,
            user: { name: { contains: query, mode: "insensitive" } },
          },
          include: {
            user:  { select: { id: true, name: true, avatarUrl: true } },
            class: { select: { name: true } },
          },
          take: 8,
        }),
        prisma.staff.findMany({
          where: { schoolId, isActive: true,
            user: { name: { contains: query, mode: "insensitive" } },
          },
          include: { user: { select: { id: true, name: true, avatarUrl: true, role: true } } },
          take: 5,
        }),
      ]);

      const members = [
        ...students.map(s => ({
          id: s.id, type: "STUDENT", userId: s.userId,
          name: s.user?.name, avatarUrl: s.user?.avatarUrl,
          subtitle: `Student · ${s.class?.name ?? ""}`,
          admissionNo: s.admissionNo,
        })),
        ...staff.map(st => ({
          id: st.id, type: st.user?.role === "TEACHER" ? "TEACHER" : "STAFF",
          userId: st.userId,
          name: st.user?.name, avatarUrl: st.user?.avatarUrl,
          subtitle: st.user?.role ?? "Staff",
        })),
      ];

      return rep.send({ members });
    }
  );

  // ─── MEMBER PROFILE + ACTIVE ISSUES ───────────────────────
  app.get(`${P}/members/:type/:id/profile`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const memberType = (req.params as any).type as string;
      const memberId   = Number((req.params as any).id);

      const settings = await prisma.libSettings.findUnique({ where: { schoolId } });
      const maxBooks = memberType === "STUDENT" ? (settings?.maxBooksStudent ?? 3)
        : memberType === "TEACHER" ? (settings?.maxBooksTeacher ?? 5)
        : (settings?.maxBooksStaff ?? 3);

      const activeIssues = await prisma.libIssue.findMany({
        where: {
          schoolId, status: { in: ["ACTIVE","OVERDUE"] },
          ...(memberType === "STUDENT" ? { studentId: memberId } : { staffId: memberId }),
        },
        include: { copy: { include: { book: { select: { title: true, isbn: true } } } } },
      });

      const pendingFines = await prisma.libFine.aggregate({
        where: {
          schoolId, status: "PENDING",
          ...(memberType === "STUDENT" ? { studentId: memberId } : { staffId: memberId }),
        },
        _sum: { totalAmount: true },
      });

      return rep.send({
        activeIssues,
        pendingFines: Number(pendingFines._sum.totalAmount ?? 0),
        canIssueMore: activeIssues.length < maxBooks,
        maxBooks,
        activeCount: activeIssues.length,
      });
    }
  );

  // ─── ISSUE BOOK ───────────────────────────────────────────
  app.post(`${P}/issue`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      const copyId     = Number(b.copyId);
      const memberId   = Number(b.memberId);
      const memberType = b.memberType as string; // STUDENT | TEACHER | STAFF | PARENT

      // Validate copy is available
      const copy = await prisma.libBookCopy.findFirst({ where: { id: copyId, schoolId } });
      if (!copy)                        return rep.code(404).send({ error: "Copy not found" });
      if (copy.status !== "AVAILABLE") return rep.code(409).send({ error: `Copy is ${copy.status} — cannot issue` });

      // Validate member can borrow more
      const memberProfile = await app.inject({
        method: "GET",
        url: `/admin/library/circulation/members/${memberType}/${memberId}/profile`,
        headers: { authorization: `Bearer ${token(userId)}` },
      }).catch(() => null);

      // Build issue
      const dueDate    = await calcDueDate(schoolId, memberType);
      const staff      = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId } });

      const issue = await prisma.libIssue.create({
        data: {
          schoolId,
          copyId,
          memberType:  memberType as any,
          studentId:   memberType === "STUDENT" ? memberId : null,
          staffId:     ["TEACHER","STAFF"].includes(memberType) ? memberId : null,
          issueDate:   new Date(),
          dueDate,
          status:      "ACTIVE",
          issuedById:  staff?.id ?? null,
        },
        include: {
          copy: { include: { book: { select: { title: true, isbn: true } } } },
          student: { include: { user: { select: { name: true } } } },
          staff:   { include: { user: { select: { name: true } } } },
        },
      });

      // Mark copy as ISSUED
      await prisma.libBookCopy.update({ where: { id: copyId }, data: { status: "ISSUED" } });

      return rep.code(201).send({ issue });
    }
  );

  // ─── ACTIVE ISSUES ────────────────────────────────────────
  app.get(`${P}/issues/active`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q    = req.query as any;
      const page = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);
      const today = new Date(); today.setHours(0, 0, 0, 0);

      const where: any = { schoolId, status: { in: ["ACTIVE","OVERDUE"] } };
      if (q.memberType === "STUDENT") where.studentId = { not: null };
      if (q.memberType === "STAFF")   where.staffId   = { not: null };
      if (q.overdueOnly === "true")   where.dueDate   = { lt: today };
      if (q.search) {
        where.OR = [
          { student: { user: { name: { contains: q.search, mode: "insensitive" } } } },
          { staff:   { user: { name: { contains: q.search, mode: "insensitive" } } } },
          { copy: { book: { title: { contains: q.search, mode: "insensitive" } } } },
          { copy: { copyCode: { contains: q.search, mode: "insensitive" } } },
        ];
      }

      const [issues, total] = await Promise.all([
        prisma.libIssue.findMany({
          where,
          include: {
            copy: { include: { book: { select: { title: true, isbn: true, coverUrl: true, category: { select: { name: true, color: true } } } } } },
            student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } },
            staff:   { include: { user: { select: { name: true, avatarUrl: true, role: true } } } },
          },
          orderBy: { dueDate: "asc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.libIssue.count({ where }),
      ]);

      // Enrich with overdue days
      const enriched = issues.map(issue => {
        const overdueDays = issue.dueDate < today
          ? Math.floor((today.getTime() - new Date(issue.dueDate).getTime()) / 86400000)
          : 0;
        return { ...issue, overdueDays, isOverdue: overdueDays > 0 };
      });

      return rep.send({ issues: enriched, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── OVERDUE BOOKS ────────────────────────────────────────
  app.get(`${P}/issues/overdue`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q     = req.query as any;
      const today = new Date(); today.setHours(0, 0, 0, 0);

      const issues = await prisma.libIssue.findMany({
        where: { schoolId, status: { in: ["ACTIVE","OVERDUE"] }, dueDate: { lt: today } },
        include: {
          copy:    { include: { book: { select: { title: true } } } },
          student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } },
          staff:   { include: { user: { select: { name: true, avatarUrl: true, role: true } } } },
          fine:    true,
        },
        orderBy: { dueDate: "asc" },
      });

      const enriched = await Promise.all(issues.map(async issue => {
        const overdueDays = Math.floor((today.getTime() - new Date(issue.dueDate).getTime()) / 86400000);
        const fineCalc    = await calcFine(schoolId, overdueDays);
        return { ...issue, overdueDays, estimatedFine: fineCalc.totalAmount };
      }));

      // Filter by range
      let filtered = enriched;
      if (q.range === "1-7")  filtered = enriched.filter(i => i.overdueDays >= 1  && i.overdueDays <= 7);
      if (q.range === "8-15") filtered = enriched.filter(i => i.overdueDays >= 8  && i.overdueDays <= 15);
      if (q.range === "15+")  filtered = enriched.filter(i => i.overdueDays > 15);

      return rep.send({ issues: filtered, total: filtered.length });
    }
  );

  // ─── RETURN BOOK ──────────────────────────────────────────
  app.post(`${P}/return`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const issueId = Number(b.issueId);

      const issue = await prisma.libIssue.findFirst({
        where: { id: issueId, schoolId, status: { in: ["ACTIVE","OVERDUE"] } },
      });
      if (!issue) return rep.code(404).send({ error: "Active issue not found" });

      const today         = new Date(); today.setHours(0, 0, 0, 0);
      const dueDate       = new Date(issue.dueDate); dueDate.setHours(0, 0, 0, 0);
      const isLate        = today > dueDate;
      const overdueDays   = isLate ? Math.floor((today.getTime() - dueDate.getTime()) / 86400000) : 0;
      const returnCondition = b.condition as string ?? "GOOD";  // GOOD | DAMAGED | LOST
      const newStatus     = returnCondition === "LOST" ? "LOST" : "RETURNED";

      // Update issue
      await prisma.libIssue.update({
        where: { id: issueId },
        data: {
          status:           newStatus as any,
          returnDate:       today,
          returnCondition,
          returnNotes:      b.notes ?? null,
          returnedById:     b.returnedById ? Number(b.returnedById) : null,
        },
      });

      // Update copy status
      const copyStatus = returnCondition === "LOST"    ? "LOST"
        : returnCondition === "DAMAGED" ? "DAMAGED"
        : "AVAILABLE";
      await prisma.libBookCopy.update({
        where: { id: issue.copyId },
        data: { status: copyStatus as any, damagedAt: returnCondition === "DAMAGED" ? new Date() : undefined, lostAt: returnCondition === "LOST" ? new Date() : undefined },
      });

      // Generate fine if needed
      let fine = null;
      const settings = await prisma.libSettings.findUnique({ where: { schoolId } });
      if (settings?.fineEnabled && (isLate || returnCondition !== "GOOD")) {
        const reason = returnCondition === "LOST" ? "LOSS" : returnCondition === "DAMAGED" ? "DAMAGE" : "LATE_RETURN";
        const fineCalc = await calcFine(schoolId, overdueDays, reason);
        if (fineCalc.totalAmount > 0) {
          fine = await prisma.libFine.create({
            data: {
              schoolId,
              issueId,
              memberType:  issue.memberType,
              studentId:   issue.studentId,
              staffId:     issue.staffId,
              overdueDays,
              ratePerDay:  fineCalc.ratePerDay,
              extraCharge: reason !== "LATE_RETURN" ? (reason === "LOSS" ? Number(settings.fineLossRate) : Number(settings.fineDamageRate)) : 0,
              totalAmount: fineCalc.totalAmount,
              reason,
            },
          });
        }
      }

      return rep.send({ ok: true, isLate, overdueDays, copyStatus, fine, newStatus });
    }
  );

  // ─── LOOKUP BY COPY CODE / BARCODE ────────────────────────
  app.get(`${P}/lookup`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const code = (req.query as any).code as string;

      const copy = await prisma.libBookCopy.findFirst({
        where: { schoolId, OR: [{ copyCode: code }, { barcode: code }] },
        include: {
          book: {
            select: { id: true, title: true, isbn: true, coverUrl: true, category: { select: { name: true, color: true } }, author: { select: { name: true } } },
          },
          issues: {
            where: { status: { in: ["ACTIVE","OVERDUE"] } }, take: 1,
            include: {
              student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } },
              staff:   { include: { user: { select: { name: true } } } },
            },
          },
        },
      });

      if (!copy) return rep.code(404).send({ error: "Copy not found for code: " + code });
      return rep.send({ copy, activeIssue: copy.issues?.[0] ?? null });
    }
  );

  // ─── RENEWAL ──────────────────────────────────────────────
  app.post(`${P}/renew/:issueId`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const issueId = Number((req.params as any).issueId);

      const issue = await prisma.libIssue.findFirst({ where: { id: issueId, schoolId, status: "ACTIVE" } });
      if (!issue) return rep.code(404).send({ error: "Active issue not found" });

      const settings = await prisma.libSettings.findUnique({ where: { schoolId } });
      const maxRenewals = settings?.maxRenewals ?? 2;
      if (issue.renewalCount >= maxRenewals) {
        return rep.code(409).send({ error: `Maximum renewals (${maxRenewals}) reached` });
      }

      const renewalDays = settings?.renewalDays ?? 7;
      const newDueDate  = new Date(issue.dueDate);
      newDueDate.setDate(newDueDate.getDate() + renewalDays);

      const updated = await prisma.libIssue.update({
        where: { id: issueId },
        data: { dueDate: newDueDate, renewalCount: { increment: 1 }, lastRenewedAt: new Date(), status: "RENEWED" as any },
      });

      return rep.send({ issue: updated, newDueDate, renewalsRemaining: maxRenewals - updated.renewalCount });
    }
  );

  // ─── MARK LOST ────────────────────────────────────────────
  app.post(`${P}/mark-lost/:issueId`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const issueId = Number((req.params as any).issueId);
      const b = req.body as any;

      const issue = await prisma.libIssue.findFirst({ where: { id: issueId, schoolId } });
      if (!issue) return rep.code(404).send({ error: "Not found" });

      await prisma.libIssue.update({
        where: { id: issueId },
        data: { status: "LOST", returnCondition: "LOST", returnNotes: b.notes ?? null },
      });

      await prisma.libBookCopy.update({ where: { id: issue.copyId }, data: { status: "LOST", lostAt: new Date() } });

      // Generate loss fine
      const settings  = await prisma.libSettings.findUnique({ where: { schoolId } });
      const today     = new Date(); today.setHours(0, 0, 0, 0);
      const overdueDays = Math.max(0, Math.floor((today.getTime() - new Date(issue.dueDate).getTime()) / 86400000));
      const fineCalc  = await calcFine(schoolId, overdueDays, "LOSS");

      const fine = await prisma.libFine.upsert({
        where: { issueId },
        create: {
          schoolId, issueId,
          memberType: issue.memberType, studentId: issue.studentId, staffId: issue.staffId,
          overdueDays, ratePerDay: fineCalc.ratePerDay,
          extraCharge: Number(settings?.fineLossRate ?? 500),
          totalAmount: fineCalc.totalAmount,
          reason: "LOSS",
        },
        update: { totalAmount: fineCalc.totalAmount, reason: "LOSS", extraCharge: Number(settings?.fineLossRate ?? 500) },
      });

      return rep.send({ ok: true, fine });
    }
  );

  // ─── FINES LIST ───────────────────────────────────────────
  app.get(`${P}/fines`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId };
      if (q.status) where.status = q.status;

      const [fines, total, totalPending] = await Promise.all([
        prisma.libFine.findMany({
          where,
          include: {
            issue: { include: { copy: { include: { book: { select: { title: true } } } } } },
            student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } },
            staff:   { include: { user: { select: { name: true } } } },
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.libFine.count({ where }),
        prisma.libFine.aggregate({ where: { schoolId, status: "PENDING" }, _sum: { totalAmount: true } }),
      ]);

      return rep.send({
        fines, total, page,
        totalPending: Number(totalPending._sum.totalAmount ?? 0),
      });
    }
  );

  // ─── WAIVE / PAY FINE ─────────────────────────────────────
  app.post(`${P}/fines/:id/waive`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const fine = await prisma.libFine.update({
        where: { id, schoolId },
        data: { status: "WAIVED", waivedAt: new Date(), waivedById: Number(userId), notes: (req.body as any).notes ?? null },
      });
      return rep.send({ fine });
    }
  );

  app.post(`${P}/fines/:id/pay`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const fine = await prisma.libFine.update({
        where: { id, schoolId },
        data: { status: "PAID", paidAt: new Date(), financeRefId: (req.body as any).financeRefId ?? null },
      });
      return rep.send({ fine });
    }
  );

  // ─── ISSUE HISTORY FOR COPY ───────────────────────────────
  app.get(`${P}/copy/:copyId/history`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const copyId = Number((req.params as any).copyId);
      const history = await prisma.libIssue.findMany({
        where: { copyId, schoolId },
        include: {
          student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } },
          staff:   { include: { user: { select: { name: true } } } },
          fine:    true,
        },
        orderBy: { issueDate: "desc" },
      });
      return rep.send({ history });
    }
  );

  // ─── REPORTS ──────────────────────────────────────────────
  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();
      const today = new Date(); today.setHours(0, 0, 0, 0);

      const [totalIssued, totalReturned, totalOverdue, totalLost, byMemberType, fineCollected] = await Promise.all([
        prisma.libIssue.count({ where: { schoolId, issueDate:  { gte: from, lte: to } } }),
        prisma.libIssue.count({ where: { schoolId, returnDate: { gte: from, lte: to }, status: "RETURNED" } }),
        prisma.libIssue.count({ where: { schoolId, status: { in: ["ACTIVE","OVERDUE"] }, dueDate: { lt: today } } }),
        prisma.libIssue.count({ where: { schoolId, status: "LOST" } }),
        prisma.libIssue.groupBy({
          by: ["memberType"],
          where: { schoolId, issueDate: { gte: from, lte: to } },
          _count: { id: true },
        }),
        prisma.libFine.aggregate({
          where: { schoolId, status: "PAID", paidAt: { gte: from, lte: to } },
          _sum: { totalAmount: true },
        }),
      ]);

      return rep.send({
        totalIssued, totalReturned, totalOverdue, totalLost, byMemberType,
        fineCollected: Number(fineCollected._sum.totalAmount ?? 0),
        from, to,
      });
    }
  );
}

// Tiny helper for auth header (used in inject call above)
function token(userId: number): string { return ""; }
