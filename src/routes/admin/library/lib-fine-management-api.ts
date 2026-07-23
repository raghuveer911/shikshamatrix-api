// apps/api/src/routes/admin/library/lib-fine-management-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminLibFineManagementRoutes(app: FastifyInstance) {
  const P = "/admin/library/fines";

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [active, totalPending, totalPaid, totalWaived, waiversPending, byReason] = await Promise.all([
        prisma.libFine.count({ where: { schoolId, status: "PENDING" } }),
        prisma.libFine.aggregate({ where: { schoolId, status: "PENDING" }, _sum: { totalAmount: true } }),
        prisma.libFine.aggregate({ where: { schoolId, status: "PAID"    }, _sum: { totalAmount: true } }),
        prisma.libFine.aggregate({ where: { schoolId, status: "WAIVED"  }, _sum: { totalAmount: true } }),
        prisma.libFineWaiver.count({ where: { schoolId, status: "PENDING" } }),
        prisma.libFine.groupBy({
          by: ["reason"],
          where: { schoolId },
          _count: { id: true },
          _sum:   { totalAmount: true },
          orderBy: { _sum: { totalAmount: "desc" } },
        }),
      ]);

      // Recovery trend (last 6 months)
      const now = new Date();
      const trend: { month: string; generated: number; collected: number }[] = [];
      for (let i = 5; i >= 0; i--) {
        const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const to   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
        const [gen, col] = await Promise.all([
          prisma.libFine.aggregate({ where: { schoolId, createdAt: { gte: from, lte: to } }, _sum: { totalAmount: true } }),
          prisma.libFine.aggregate({ where: { schoolId, status: "PAID", paidAt: { gte: from, lte: to } }, _sum: { totalAmount: true } }),
        ]);
        trend.push({
          month: from.toLocaleString("default", { month: "short", year: "2-digit" }),
          generated: Number(gen._sum.totalAmount ?? 0),
          collected: Number(col._sum.totalAmount ?? 0),
        });
      }

      // Top debtors
      const topDebtors = await prisma.libFine.groupBy({
        by: ["studentId"],
        where: { schoolId, status: "PENDING", studentId: { not: null } },
        _sum: { totalAmount: true },
        orderBy: { _sum: { totalAmount: "desc" } },
        take: 5,
      });
      const debtorIds = topDebtors.map(d => d.studentId).filter(Boolean) as number[];
      const debtorDetails = await prisma.student.findMany({
        where: { id: { in: debtorIds } },
        include: { user: { select: { name: true } }, class: { select: { name: true } } },
      });
      const debtorMap = Object.fromEntries(debtorDetails.map(d => [d.id, d]));

      return rep.send({
        kpis: {
          active, waiversPending,
          totalPending: Number(totalPending._sum.totalAmount ?? 0),
          totalPaid:    Number(totalPaid._sum.totalAmount    ?? 0),
          totalWaived:  Number(totalWaived._sum.totalAmount  ?? 0),
        },
        byReason, trend,
        topDebtors: topDebtors.map(d => ({
          studentId: d.studentId,
          name: d.studentId ? debtorMap[d.studentId]?.user?.name ?? "?" : "?",
          class: d.studentId ? debtorMap[d.studentId]?.class?.name ?? "" : "",
          amount: Number(d._sum.totalAmount ?? 0),
        })),
      });
    }
  );

  // ─── LIST FINES ───────────────────────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId };
      if (q.status)     where.status     = q.status;
      if (q.reason)     where.reason     = q.reason;
      if (q.memberType === "STUDENT") where.studentId = { not: null };
      if (q.memberType === "STAFF")   where.staffId   = { not: null };
      if (q.search) {
        where.OR = [
          { student: { user: { name: { contains: q.search, mode: "insensitive" } } } },
          { staff:   { user: { name: { contains: q.search, mode: "insensitive" } } } },
          { issue:   { copy: { book: { title: { contains: q.search, mode: "insensitive" } } } } },
        ];
      }

      const [fines, total, totals] = await Promise.all([
        prisma.libFine.findMany({
          where,
          include: {
            issue: { include: { copy: { include: { book: { select: { title: true } } } } } },
            student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } },
            staff:   { include: { user: { select: { name: true, avatarUrl: true, role: true } } } },
            waiver:  { select: { id: true, status: true, waivedAmount: true } },
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.libFine.count({ where }),
        prisma.libFine.aggregate({ where, _sum: { totalAmount: true } }),
      ]);

      return rep.send({ fines, total, page, pages: Math.ceil(total / limit), totalAmount: Number(totals._sum.totalAmount ?? 0) });
    }
  );

  // ─── PAY FINE ────────────────────────────────────────────
  app.post(`${P}/:id/pay`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const fine = await prisma.libFine.update({
        where: { id, schoolId },
        data: { status: "PAID", paidAt: new Date(), financeRefId: b.financeRefId ? Number(b.financeRefId) : null, notes: b.notes ?? null },
      });

      // Update membership stats
      if (fine.studentId) {
        await prisma.libMembership.updateMany({
          where: { schoolId, studentId: fine.studentId },
          data: { totalFines: { increment: Number(fine.totalAmount) } },
        });
      }

      return rep.send({ fine });
    }
  );

  // ─── WAIVE FINE ───────────────────────────────────────────
  app.post(`${P}/:id/waive`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const user = await prisma.user.findFirst({ where: { id: Number(userId) }, select: { name: true } });
      const fine = await prisma.libFine.update({
        where: { id, schoolId },
        data: { status: "WAIVED", waivedAt: new Date(), waivedById: Number(userId), notes: b.notes ?? null },
      });

      return rep.send({ fine });
    }
  );

  // ─── WAIVER REQUESTS ──────────────────────────────────────
  app.get(`${P}/waivers`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const waivers = await prisma.libFineWaiver.findMany({
        where: { schoolId, ...(q.status ? { status: q.status as any } : {}) },
        include: {
          fine: {
            include: {
              issue: { include: { copy: { include: { book: { select: { title: true } } } } } },
              student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } },
              staff:   { include: { user: { select: { name: true } } } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: Number(q.limit ?? 50),
      });

      return rep.send({ waivers });
    }
  );

  app.post(`${P}/waivers`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      const user = await prisma.user.findFirst({ where: { id: Number(userId) }, select: { name: true } });
      const waiver = await prisma.libFineWaiver.create({
        data: {
          schoolId,
          fineId:              Number(b.fineId),
          requestedByUserId:   Number(userId),
          requestedByName:     b.requestedByName ?? user?.name ?? "Unknown",
          reason:              b.reason,
          waivedAmount:        b.waivedAmount ? Number(b.waivedAmount) : null,
        },
      });
      return rep.code(201).send({ waiver });
    }
  );

  // Approve waiver
  app.post(`${P}/waivers/:id/approve`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const user = await prisma.user.findFirst({ where: { id: Number(userId) }, select: { name: true } });
      const waiver = await prisma.libFineWaiver.update({
        where: { id, schoolId },
        data: {
          status:           "APPROVED",
          reviewedByUserId: Number(userId),
          reviewedByName:   user?.name ?? "Admin",
          reviewNote:       b.note ?? null,
          reviewedAt:       new Date(),
        },
      });

      // Update the fine as waived
      await prisma.libFine.update({
        where: { id: waiver.fineId },
        data: { status: "WAIVED", waivedAt: new Date(), waivedById: Number(userId) },
      });

      return rep.send({ waiver });
    }
  );

  // Reject waiver
  app.post(`${P}/waivers/:id/reject`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const user = await prisma.user.findFirst({ where: { id: Number(userId) }, select: { name: true } });
      const waiver = await prisma.libFineWaiver.update({
        where: { id, schoolId },
        data: {
          status:           "REJECTED",
          reviewedByUserId: Number(userId),
          reviewedByName:   user?.name ?? "Admin",
          reviewNote:       b.reason ?? "Request rejected",
          reviewedAt:       new Date(),
        },
      });
      return rep.send({ waiver });
    }
  );

  // ─── FINE HISTORY (complete audit trail) ──────────────────
  app.get(`${P}/history`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 90 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      const fines = await prisma.libFine.findMany({
        where: { schoolId, createdAt: { gte: from, lte: to } },
        include: {
          issue:   { include: { copy: { include: { book: { select: { title: true } } } } } },
          student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } },
          staff:   { include: { user: { select: { name: true } } } },
          waiver:  { select: { status: true, waivedAmount: true, reviewedByName: true } },
        },
        orderBy: { createdAt: "desc" },
        take: Number(q.limit ?? 100),
      });

      return rep.send({ fines, from, to });
    }
  );

  // ─── RECOVERY TRACKING ────────────────────────────────────
  app.get(`${P}/recovery`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [generated, collected, pending, waived, byStatus] = await Promise.all([
        prisma.libFine.aggregate({ where: { schoolId }, _sum: { totalAmount: true }, _count: { id: true } }),
        prisma.libFine.aggregate({ where: { schoolId, status: "PAID"   }, _sum: { totalAmount: true }, _count: { id: true } }),
        prisma.libFine.aggregate({ where: { schoolId, status: "PENDING"}, _sum: { totalAmount: true }, _count: { id: true } }),
        prisma.libFine.aggregate({ where: { schoolId, status: "WAIVED" }, _sum: { totalAmount: true }, _count: { id: true } }),
        prisma.libFine.groupBy({
          by: ["reason"],
          where: { schoolId },
          _count: { id: true },
          _sum: { totalAmount: true },
        }),
      ]);

      const totalGenerated = Number(generated._sum.totalAmount ?? 0);
      const totalCollected = Number(collected._sum.totalAmount ?? 0);
      const recoveryRate   = totalGenerated > 0 ? Math.round((totalCollected / totalGenerated) * 100) : 0;

      return rep.send({
        generated: { count: generated._count.id, amount: totalGenerated },
        collected: { count: collected._count.id, amount: totalCollected },
        pending:   { count: pending._count.id,   amount: Number(pending._sum.totalAmount ?? 0) },
        waived:    { count: waived._count.id,     amount: Number(waived._sum.totalAmount  ?? 0) },
        recoveryRate, byStatus,
      });
    }
  );

  // ─── REPORTS ──────────────────────────────────────────────
  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
      const to   = q.to   ? new Date(q.to)   : new Date();

      const [byStatus, byReason] = await Promise.all([
        prisma.libFine.groupBy({
          by: ["status"],
          where: { schoolId, createdAt: { gte: from, lte: to } },
          _count: { id: true }, _sum: { totalAmount: true },
        }),
        prisma.libFine.groupBy({
          by: ["reason"],
          where: { schoolId, createdAt: { gte: from, lte: to } },
          _count: { id: true }, _sum: { totalAmount: true },
          orderBy: { _sum: { totalAmount: "desc" } },
        }),
      ]);

      return rep.send({ byStatus, byReason, from, to });
    }
  );
}
