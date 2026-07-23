// apps/api/src/routes/admin/library/lib-reports-analytics-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminLibReportsRoutes(app: FastifyInstance) {
  const P = "/admin/library/reports";

  // ─── MAIN ANALYTICS DASHBOARD ─────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('library.analytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const from = new Date(Date.now() - 30 * 86400000);

      const [totalIssued, totalReturned, activeReaders, fineCollected,
             totalBooks, totalMembers, totalDigital, totalReservations] = await Promise.all([
        prisma.libIssue.count({ where: { schoolId, issueDate: { gte: from } } }),
        prisma.libIssue.count({ where: { schoolId, status: "RETURNED", returnDate: { gte: from } } }),
        prisma.libIssue.groupBy({ by: ["studentId"], where: { schoolId, status: { in: ["ACTIVE","OVERDUE"] }, studentId: { not: null } } }).then(r => r.length),
        prisma.libFine.aggregate({ where: { schoolId, status: "PAID", paidAt: { gte: from } }, _sum: { totalAmount: true } }),
        prisma.libBook.count({ where: { schoolId, isActive: true } }),
        prisma.libMembership.count({ where: { schoolId, status: "ACTIVE" } }),
        prisma.libDigitalResource.count({ where: { schoolId, isActive: true } }),
        prisma.libReservation.count({ where: { schoolId, status: { in: ["PENDING","WAITING","AVAILABLE"] } } }),
      ]);

      return rep.send({
        kpis: {
          totalIssued, totalReturned, activeReaders, totalBooks,
          totalMembers, totalDigital, totalReservations,
          fineCollected: Number(fineCollected._sum.totalAmount ?? 0),
        },
        period: "Last 30 days",
      });
    }
  );

  // ─── CIRCULATION REPORTS ──────────────────────────────────
  app.get(`${P}/circulation`, { preHandler: [authenticate, requireCapability('library.analytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      // Daily trend
      const days = Math.min(Math.ceil((to.getTime() - from.getTime()) / 86400000), 31);
      const dailyTrend: { date: string; issued: number; returned: number }[] = [];
      for (let i = 0; i < days; i++) {
        const d    = new Date(from.getTime() + i * 86400000);
        const dEnd = new Date(d.getTime() + 86400000);
        const [issued, returned] = await Promise.all([
          prisma.libIssue.count({ where: { schoolId, issueDate:  { gte: d, lt: dEnd } } }),
          prisma.libIssue.count({ where: { schoolId, returnDate: { gte: d, lt: dEnd }, status: "RETURNED" } }),
        ]);
        dailyTrend.push({ date: d.toISOString().split("T")[0], issued, returned });
      }

      // By member type
      const byMemberType = await prisma.libIssue.groupBy({
        by: ["memberType"],
        where: { schoolId, issueDate: { gte: from, lte: to } },
        _count: { id: true },
      });

      // Renewal count
      const renewals = await prisma.libIssue.count({ where: { schoolId, renewalCount: { gt: 0 }, updatedAt: { gte: from, lte: to } } });

      return rep.send({ dailyTrend, byMemberType, renewals, from, to });
    }
  );

  // ─── MEMBER ANALYTICS ─────────────────────────────────────
  app.get(`${P}/members`, { preHandler: [authenticate, requireCapability('library.analytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [topReaders, inactiveCount, classwiseActivity] = await Promise.all([
        // Top readers by total issues
        prisma.libMembership.findMany({
          where: { schoolId, status: "ACTIVE", totalIssued: { gt: 0 } },
          orderBy: { totalIssued: "desc" },
          take: 10,
          include: {
            student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } },
            staff:   { include: { user: { select: { name: true, role: true } } } },
          },
          select: { id: true, memberType: true, totalIssued: true, totalReturned: true, totalOverdues: true, student: true, staff: true },
        }),
        // Inactive members (never borrowed)
        prisma.libMembership.count({ where: { schoolId, totalIssued: 0 } }),
        // Class-wise activity
        prisma.libIssue.groupBy({
          by: ["studentId"],
          where: { schoolId, studentId: { not: null }, issueDate: { gte: new Date(Date.now() - 90 * 86400000) } },
          _count: { id: true },
        }),
      ]);

      return rep.send({ topReaders, inactiveCount, classwiseActivity });
    }
  );

  // ─── BOOK ANALYTICS ───────────────────────────────────────
  app.get(`${P}/books`, { preHandler: [authenticate, requireCapability('library.analytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 90 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      // Most issued books
      const mostIssuedCopies = await prisma.libIssue.groupBy({
        by: ["copyId"],
        where: { schoolId, issueDate: { gte: from, lte: to } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
      });
      const copyIds = mostIssuedCopies.map(c => c.copyId);
      const copies  = await prisma.libBookCopy.findMany({
        where: { id: { in: copyIds } },
        include: { book: { select: { id: true, title: true, author: { select: { name: true } }, category: { select: { name: true, color: true } } } } },
      });
      const copyMap = Object.fromEntries(copies.map(c => [c.id, c]));

      // Category popularity
      const categoryPop = await prisma.libIssue.groupBy({
        by: ["copyId"],
        where: { schoolId, issueDate: { gte: from, lte: to } },
        _count: { id: true },
      });

      // Least used books (zero issues in period)
      const issuedBookIds = (await prisma.libIssue.findMany({ where: { schoolId, issueDate: { gte: from } }, select: { copy: { select: { bookId: true } } } })).map(i => i.copy.bookId);
      const leastUsedCount = await prisma.libBook.count({ where: { schoolId, isActive: true, id: { notIn: issuedBookIds } } });

      return rep.send({
        mostIssued: mostIssuedCopies.map(c => ({ ...c, copy: copyMap[c.copyId], issues: c._count.id })),
        leastUsedCount, from, to,
      });
    }
  );

  // ─── FINE ANALYTICS ───────────────────────────────────────
  app.get(`${P}/fines`, { preHandler: [authenticate, requireCapability('library.analytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 90 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      const [byStatus, byReason, trend, topDebtors] = await Promise.all([
        prisma.libFine.groupBy({ by: ["status"], where: { schoolId }, _count: { id: true }, _sum: { totalAmount: true } }),
        prisma.libFine.groupBy({ by: ["reason"], where: { schoolId, createdAt: { gte: from, lte: to } }, _count: { id: true }, _sum: { totalAmount: true }, orderBy: { _sum: { totalAmount: "desc" } } }),
        // Monthly trend
        Promise.all(Array.from({ length: 3 }, async (_, i) => {
          const mFrom = new Date(new Date().getFullYear(), new Date().getMonth() - (2 - i), 1);
          const mTo   = new Date(new Date().getFullYear(), new Date().getMonth() - (2 - i) + 1, 0);
          const [gen, col] = await Promise.all([
            prisma.libFine.aggregate({ where: { schoolId, createdAt: { gte: mFrom, lte: mTo } }, _sum: { totalAmount: true } }),
            prisma.libFine.aggregate({ where: { schoolId, status: "PAID", paidAt: { gte: mFrom, lte: mTo } }, _sum: { totalAmount: true } }),
          ]);
          return { month: mFrom.toLocaleString("default", { month: "short" }), generated: Number(gen._sum.totalAmount ?? 0), collected: Number(col._sum.totalAmount ?? 0) };
        })),
        prisma.libFine.groupBy({
          by: ["studentId"],
          where: { schoolId, status: "PENDING", studentId: { not: null } },
          _sum: { totalAmount: true },
          orderBy: { _sum: { totalAmount: "desc" } },
          take: 5,
        }),
      ]);

      return rep.send({ byStatus, byReason, trend, topDebtors });
    }
  );

  // ─── DIGITAL LIBRARY ANALYTICS ────────────────────────────
  app.get(`${P}/digital`, { preHandler: [authenticate, requireCapability('library.analytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [totalViews, totalDownloads, topViewed, byType] = await Promise.all([
        prisma.libResourceView.count({ where: { resource: { schoolId } } }),
        prisma.libResourceView.count({ where: { resource: { schoolId }, viewType: "DOWNLOAD" } }),
        prisma.libDigitalResource.findMany({
          where: { schoolId, isActive: true },
          orderBy: { viewCount: "desc" },
          take: 10,
          select: { id: true, title: true, resourceType: true, viewCount: true, downloadCount: true },
        }),
        prisma.libDigitalResource.groupBy({
          by: ["resourceType"],
          where: { schoolId, isActive: true },
          _count: { id: true },
          _sum:   { viewCount: true, downloadCount: true },
          orderBy: { _sum: { viewCount: "desc" } },
        }),
      ]);

      return rep.send({ totalViews, totalDownloads, topViewed, byType });
    }
  );

  // ─── TREND ANALYSIS ───────────────────────────────────────
  app.get(`${P}/trends`, { preHandler: [authenticate, requireCapability('library.analytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const months = Number((req.query as any).months ?? 6);
      const now    = new Date();

      const trend: { month: string; issued: number; returned: number; fineGenerated: number; members: number }[] = [];

      for (let i = months - 1; i >= 0; i--) {
        const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const to   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
        const [issued, returned, fineAgg, members] = await Promise.all([
          prisma.libIssue.count({ where: { schoolId, issueDate: { gte: from, lte: to } } }),
          prisma.libIssue.count({ where: { schoolId, returnDate: { gte: from, lte: to }, status: "RETURNED" } }),
          prisma.libFine.aggregate({ where: { schoolId, createdAt: { gte: from, lte: to } }, _sum: { totalAmount: true } }),
          prisma.libMembership.count({ where: { schoolId, joinedAt: { lte: to } } }),
        ]);
        trend.push({
          month: from.toLocaleString("default", { month: "short", year: "2-digit" }),
          issued, returned, fineGenerated: Number(fineAgg._sum.totalAmount ?? 0), members,
        });
      }

      return rep.send({ trend });
    }
  );

  // ─── CUSTOM REPORT ────────────────────────────────────────
  app.post(`${P}/custom`, { preHandler: [authenticate, requireCapability('library.analytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const from = b.from ? new Date(b.from) : new Date(Date.now() - 30 * 86400000);
      const to   = b.to   ? new Date(b.to)   : new Date();

      const where: any = { schoolId, issueDate: { gte: from, lte: to } };
      if (b.classId) {
        where.student = { classId: Number(b.classId) };
      }
      if (b.memberType === "STAFF") where.staffId = { not: null };

      const issues = await prisma.libIssue.findMany({
        where,
        include: {
          copy: { include: { book: { select: { title: true, isbn: true, category: { select: { name: true } } } } } },
          student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } },
          staff:   { include: { user: { select: { name: true, role: true } } } },
          fine:    { select: { totalAmount: true, status: true } },
        },
        orderBy: { issueDate: "desc" },
        take: Number(b.limit ?? 200),
      });

      return rep.send({ issues, total: issues.length, from, to, filters: b });
    }
  );
}
