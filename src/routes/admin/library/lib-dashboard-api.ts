// apps/api/src/routes/admin/library/lib-dashboard-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminLibDashboardRoutes(app: FastifyInstance) {
  const P = "/admin/library";

  // ─── MAIN DASHBOARD ───────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const today = new Date(); today.setHours(0, 0, 0, 0);

      const [
        totalBooks, totalCopies, issuedCopies,
        overdueCopies, reservations, activeMembers,
        finesPending,
      ] = await Promise.all([
        prisma.libBook.count({ where: { schoolId, isActive: true } }),
        prisma.libBookCopy.count({ where: { schoolId } }),
        prisma.libBookCopy.count({ where: { schoolId, status: "ISSUED" } }),
        prisma.libIssue.count({ where: { schoolId, status: "ACTIVE", dueDate: { lt: today } } }),
        prisma.libBookCopy.count({ where: { schoolId, status: "RESERVED" } }),
        prisma.libIssue.groupBy({ by: ["studentId"], where: { schoolId, status: "ACTIVE" } }).then(r => r.length),
        prisma.libFine.aggregate({ where: { schoolId, status: "PENDING" }, _sum: { totalAmount: true } }),
      ]);

      const availableCopies = await prisma.libBookCopy.count({ where: { schoolId, status: "AVAILABLE" } });
      const lostCopies      = await prisma.libBookCopy.count({ where: { schoolId, status: "LOST" } });
      const damagedCopies   = await prisma.libBookCopy.count({ where: { schoolId, status: "DAMAGED" } });

      // Copy status chart
      const copyStatus = [
        { status: "Available", count: availableCopies, color: "#10b981" },
        { status: "Issued",    count: issuedCopies,    color: "#6366f1" },
        { status: "Reserved",  count: reservations,    color: "#f59e0b" },
        { status: "Lost",      count: lostCopies,      color: "#ef4444" },
        { status: "Damaged",   count: damagedCopies,   color: "#9ca3af" },
      ];

      // Category distribution
      const categoryDist = await prisma.libBook.groupBy({
        by: ["categoryId"],
        where: { schoolId, isActive: true },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 8,
      });
      const catIds = categoryDist.map(c => c.categoryId).filter(Boolean) as number[];
      const cats   = await prisma.libBookCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true, color: true } });
      const catMap = Object.fromEntries(cats.map(c => [c.id, c]));
      const categoryDistData = categoryDist.map(c => ({
        categoryId: c.categoryId,
        name: c.categoryId ? catMap[c.categoryId]?.name ?? "Uncategorized" : "Uncategorized",
        color: c.categoryId ? catMap[c.categoryId]?.color ?? "#9ca3af" : "#9ca3af",
        count: c._count.id,
      }));

      // Recent activities (issues + returns today)
      const recentIssues = await prisma.libIssue.findMany({
        where: { schoolId, issueDate: today },
        include: {
          copy: { include: { book: { select: { title: true } } } },
          student: { include: { user: { select: { name: true } } } },
          staff:   { include: { user: { select: { name: true } } } },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
      });

      const recentReturns = await prisma.libIssue.findMany({
        where: { schoolId, status: "RETURNED", returnDate: today },
        include: {
          copy: { include: { book: { select: { title: true } } } },
          student: { include: { user: { select: { name: true } } } },
        },
        orderBy: { updatedAt: "desc" },
        take: 5,
      });

      // Top overdue
      const topOverdue = await prisma.libIssue.findMany({
        where: { schoolId, status: "ACTIVE", dueDate: { lt: today } },
        include: {
          copy: { include: { book: { select: { title: true } } } },
          student: { include: { user: { select: { name: true } } } },
          staff:   { include: { user: { select: { name: true } } } },
        },
        orderBy: { dueDate: "asc" },
        take: 8,
      });

      return rep.send({
        kpis: {
          totalBooks, totalCopies, availableCopies, issuedCopies,
          overdueCopies, reservations, activeMembers, lostCopies,
          finesPending: Number(finesPending._sum.totalAmount ?? 0),
        },
        copyStatus, categoryDistData, recentIssues, recentReturns, topOverdue,
      });
    }
  );

  // ─── QUICK STATS ──────────────────────────────────────────
  app.get(`${P}/quick-stats`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const [available, issued, overdue] = await Promise.all([
        prisma.libBookCopy.count({ where: { schoolId, status: "AVAILABLE" } }),
        prisma.libBookCopy.count({ where: { schoolId, status: "ISSUED" } }),
        prisma.libIssue.count({ where: { schoolId, status: "ACTIVE", dueDate: { lt: today } } }),
      ]);
      return rep.send({ available, issued, overdue });
    }
  );
}
