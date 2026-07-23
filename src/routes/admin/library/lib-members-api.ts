// apps/api/src/routes/admin/library/lib-members-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ── Auto-generate library card number ───────────────────────
async function nextCardNo(schoolId: number): Promise<string> {
  const count = await prisma.libMembership.count({ where: { schoolId } });
  return `LIB-${schoolId}-${String(count + 1).padStart(5, "0")}`;
}

export async function adminLibMembersRoutes(app: FastifyInstance) {
  const P = "/admin/library/members";

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [total, byType, blocked, activeBorrowers] = await Promise.all([
        prisma.libMembership.count({ where: { schoolId } }),
        prisma.libMembership.groupBy({
          by: ["memberType"],
          where: { schoolId },
          _count: { id: true },
        }),
        prisma.libMembership.count({ where: { schoolId, status: "BLOCKED" } }),
        prisma.libMembership.count({ where: { schoolId, totalIssued: { gt: 0 }, status: "ACTIVE" } }),
      ]);

      // Top readers (most books issued)
      const topReaders = await prisma.libMembership.findMany({
        where: { schoolId, status: "ACTIVE", totalIssued: { gt: 0 } },
        orderBy: { totalIssued: "desc" },
        take: 8,
        include: {
          student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } },
          staff:   { include: { user: { select: { name: true, avatarUrl: true, role: true } } } },
        },
      });

      // Recently blocked
      const recentBlocked = await prisma.libMembership.findMany({
        where: { schoolId, status: "BLOCKED" },
        orderBy: { blockedAt: "desc" },
        take: 5,
        include: {
          student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } },
          staff:   { include: { user: { select: { name: true, role: true } } } },
        },
      });

      return rep.send({ kpis: { total, byType, blocked, activeBorrowers }, topReaders, recentBlocked });
    }
  );

  // ─── LIST ALL MEMBERS ─────────────────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId };
      if (q.memberType) where.memberType = q.memberType;
      if (q.status)     where.status     = q.status;
      if (q.search) {
        where.OR = [
          { student: { user: { name: { contains: q.search, mode: "insensitive" } } } },
          { staff:   { user: { name: { contains: q.search, mode: "insensitive" } } } },
          { libraryCardNo: { contains: q.search, mode: "insensitive" } },
        ];
      }

      const [members, total] = await Promise.all([
        prisma.libMembership.findMany({
          where,
          include: {
            student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } },
            staff:   { include: { user: { select: { name: true, avatarUrl: true, role: true } } } },
          },
          orderBy: { joinedAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.libMembership.count({ where }),
      ]);

      return rep.send({ members, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── GET OR CREATE MEMBERSHIP (auto-enrol) ────────────────
  app.get(`${P}/:type/:id`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const memberType = (req.params as any).type as string;
      const memberId   = Number((req.params as any).id);

      const where: any = { schoolId };
      if (memberType === "STUDENT") where.studentId = memberId;
      else                           where.staffId   = memberId;

      let membership = await prisma.libMembership.findFirst({
        where,
        include: {
          student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } },
          staff:   { include: { user: { select: { name: true, avatarUrl: true, role: true } } } },
        },
      });

      // Auto-enrol if first visit
      if (!membership) {
        const cardNo = await nextCardNo(schoolId);
        membership = await prisma.libMembership.create({
          data: {
            schoolId,
            memberType: memberType as any,
            studentId:  memberType === "STUDENT" ? memberId : null,
            staffId:    memberType !== "STUDENT" ? memberId : null,
            libraryCardNo: cardNo,
          },
          include: {
            student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } },
            staff:   { include: { user: { select: { name: true, avatarUrl: true, role: true } } } },
          },
        });
      }

      // Fetch active issues
      const activeIssues = await prisma.libIssue.findMany({
        where: {
          schoolId, status: { in: ["ACTIVE","OVERDUE"] },
          ...(memberType === "STUDENT" ? { studentId: memberId } : { staffId: memberId }),
        },
        include: { copy: { include: { book: { select: { title: true } } } } },
      });

      // Pending fines
      const pendingFines = await prisma.libFine.aggregate({
        where: {
          schoolId, status: "PENDING",
          ...(memberType === "STUDENT" ? { studentId: memberId } : { staffId: memberId }),
        },
        _sum: { totalAmount: true },
      });

      // Active reservations
      const reservations = await prisma.libReservation.findMany({
        where: {
          schoolId, status: { in: ["PENDING","WAITING","AVAILABLE"] },
          ...(memberType === "STUDENT" ? { studentId: memberId } : { staffId: memberId }),
        },
        include: { book: { select: { title: true } } },
      });

      return rep.send({
        membership, activeIssues,
        pendingFines: Number(pendingFines._sum.totalAmount ?? 0),
        reservations,
      });
    }
  );

  // ─── UPDATE MEMBERSHIP ────────────────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const membership = await prisma.libMembership.update({
        where: { id, schoolId },
        data: {
          status:                 b.status as any,
          blockedReason:          b.blockedReason ?? null,
          blockedAt:              b.status === "BLOCKED" ? new Date() : undefined,
          maxBooksOverride:       b.maxBooksOverride       != null ? Number(b.maxBooksOverride)       : undefined,
          dueDaysOverride:        b.dueDaysOverride         != null ? Number(b.dueDaysOverride)         : undefined,
          maxRenewalsOverride:    b.maxRenewalsOverride     != null ? Number(b.maxRenewalsOverride)     : undefined,
          maxReservationsOverride: b.maxReservationsOverride != null ? Number(b.maxReservationsOverride) : undefined,
        },
      });
      return rep.send({ membership });
    }
  );

  // ─── BLOCK / UNBLOCK ──────────────────────────────────────
  app.post(`${P}/:id/block`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const { reason } = req.body as any;
      const membership = await prisma.libMembership.update({
        where: { id, schoolId },
        data: { status: "BLOCKED", blockedReason: reason ?? "Policy violation", blockedAt: new Date() },
      });
      return rep.send({ membership });
    }
  );

  app.post(`${P}/:id/unblock`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const membership = await prisma.libMembership.update({
        where: { id, schoolId },
        data: { status: "ACTIVE", blockedReason: null, blockedAt: null },
      });
      return rep.send({ membership });
    }
  );

  // ─── BULK ENROL MEMBERS ───────────────────────────────────
  app.post(`${P}/bulk-enrol`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any; // {memberType: STUDENT, classId? }

      let members: any[] = [];
      if (b.memberType === "STUDENT") {
        members = await prisma.student.findMany({
          where: { schoolId, isActive: true, ...(b.classId ? { classId: Number(b.classId) } : {}) },
          select: { id: true },
        });
      } else {
        members = await prisma.staff.findMany({
          where: { schoolId, isActive: true },
          select: { id: true },
        });
      }

      let enrolled = 0;
      for (const m of members) {
        const existsWhere: any = { schoolId };
        if (b.memberType === "STUDENT") existsWhere.studentId = m.id;
        else existsWhere.staffId = m.id;

        const exists = await prisma.libMembership.findFirst({ where: existsWhere });
        if (!exists) {
          const cardNo = await nextCardNo(schoolId);
          await prisma.libMembership.create({
            data: {
              schoolId, memberType: b.memberType as any,
              studentId: b.memberType === "STUDENT" ? m.id : null,
              staffId:   b.memberType !== "STUDENT" ? m.id : null,
              libraryCardNo: cardNo,
            },
          });
          enrolled++;
        }
      }

      return rep.send({ enrolled, total: members.length });
    }
  );

  // ─── AUTO-BLOCK CHECK (run periodically) ──────────────────
  app.post(`${P}/auto-block-check`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const settings = await prisma.libSettings.findUnique({ where: { schoolId } });
      const today    = new Date(); today.setHours(0, 0, 0, 0);

      // Block members with 3+ overdue books
      const overdueGroups = await prisma.libIssue.groupBy({
        by: ["studentId"],
        where: { schoolId, status: "ACTIVE", dueDate: { lt: today }, studentId: { not: null } },
        _count: { id: true },
        having: { id: { _count: { gte: 3 } } },
      });

      let blocked = 0;
      for (const og of overdueGroups) {
        if (!og.studentId) continue;
        const membership = await prisma.libMembership.findFirst({ where: { schoolId, studentId: og.studentId } });
        if (membership && membership.status === "ACTIVE") {
          await prisma.libMembership.update({
            where: { id: membership.id },
            data: { status: "BLOCKED", blockedReason: `Auto-blocked: ${og._count.id} overdue books`, blockedAt: new Date() },
          });
          blocked++;
        }
      }

      // Block members with unpaid fines > ₹500
      const heavyFines = await prisma.libFine.groupBy({
        by: ["studentId"],
        where: { schoolId, status: "PENDING", studentId: { not: null } },
        _sum: { totalAmount: true },
        having: { totalAmount: { _sum: { gte: 500 } } },
      });
      for (const hf of heavyFines) {
        if (!hf.studentId) continue;
        const membership = await prisma.libMembership.findFirst({ where: { schoolId, studentId: hf.studentId } });
        if (membership && membership.status === "ACTIVE") {
          await prisma.libMembership.update({
            where: { id: membership.id },
            data: { status: "BLOCKED", blockedReason: `Auto-blocked: Pending fine ₹${hf._sum.totalAmount}`, blockedAt: new Date() },
          });
          blocked++;
        }
      }

      return rep.send({ blocked, message: `${blocked} members auto-blocked` });
    }
  );

  // ─── MEMBERSHIP RULES (GET LibSettings) ───────────────────
  app.get(`${P}/rules`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      let settings = await prisma.libSettings.findUnique({ where: { schoolId } });
      if (!settings) settings = await prisma.libSettings.create({ data: { schoolId } });
      return rep.send({ rules: settings });
    }
  );

  app.put(`${P}/rules`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.libSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          studentDueDays:   b.studentDueDays  ? Number(b.studentDueDays)  : undefined,
          teacherDueDays:   b.teacherDueDays  ? Number(b.teacherDueDays)  : undefined,
          staffDueDays:     b.staffDueDays    ? Number(b.staffDueDays)    : undefined,
          maxRenewals:      b.maxRenewals     ? Number(b.maxRenewals)     : undefined,
          maxBooksStudent:  b.maxBooksStudent ? Number(b.maxBooksStudent) : undefined,
          maxBooksTeacher:  b.maxBooksTeacher ? Number(b.maxBooksTeacher) : undefined,
          maxBooksStaff:    b.maxBooksStaff   ? Number(b.maxBooksStaff)   : undefined,
          fineEnabled:      b.fineEnabled,
          fineRatePerDay:   b.fineRatePerDay  ? Number(b.fineRatePerDay)  : undefined,
          fineGracePeriodDays: b.fineGracePeriodDays ? Number(b.fineGracePeriodDays) : undefined,
        },
      });
      return rep.send({ rules: settings });
    }
  );

  // ─── BORROWING HISTORY for a member ──────────────────────
  app.get(`${P}/:type/:id/history`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const memberType = (req.params as any).type as string;
      const memberId   = Number((req.params as any).id);
      const q = req.query as any;

      const history = await prisma.libIssue.findMany({
        where: {
          schoolId,
          ...(memberType === "STUDENT" ? { studentId: memberId } : { staffId: memberId }),
        },
        include: { copy: { include: { book: { select: { title: true, isbn: true, category: { select: { name: true, color: true } } } } } }, fine: true },
        orderBy: { issueDate: "desc" },
        take: Number(q.limit ?? 50),
      });

      return rep.send({ history });
    }
  );

  // ─── REPORTS ──────────────────────────────────────────────
  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [total, active, blocked, byType, topReaders, borrowingByMonth] = await Promise.all([
        prisma.libMembership.count({ where: { schoolId } }),
        prisma.libMembership.count({ where: { schoolId, status: "ACTIVE" } }),
        prisma.libMembership.count({ where: { schoolId, status: "BLOCKED" } }),
        prisma.libMembership.groupBy({ by: ["memberType"], where: { schoolId }, _count: { id: true } }),
        prisma.libMembership.findMany({
          where: { schoolId, totalIssued: { gt: 0 } },
          orderBy: { totalIssued: "desc" }, take: 10,
          include: {
            student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } },
            staff:   { include: { user: { select: { name: true, role: true } } } },
          },
          select: { id: true, totalIssued: true, totalReturned: true, memberType: true, student: true, staff: true },
        }),
        // issues per month for last 3 months
        prisma.libIssue.groupBy({
          by: ["issueDate"],
          where: { schoolId, issueDate: { gte: new Date(Date.now() - 90 * 86400000) } },
          _count: { id: true },
        }),
      ]);

      return rep.send({ total, active, blocked, byType, topReaders, borrowingByMonth });
    }
  );
}
