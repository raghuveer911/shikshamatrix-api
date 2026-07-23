import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";

// ── Helper: calculate working days ──────────────────────────
function calcWorkingDays(from: Date, to: Date): number {
  let count = 0;
  const cur = new Date(from);
  while (cur <= to) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++; // skip Sun/Sat
    cur.setDate(cur.getDate() + 1);
  }
  return count || 1;
}

export async function adminLeaveRoutes(app: FastifyInstance) {

  // ── GET /admin/leaves ─────────────────────────────────────
  // List all leaves with filters
  app.get(
    "/admin/leaves",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const query = request.query as {
        type?: "STAFF" | "STUDENT";
        status?: string;
        from?: string;
        to?: string;
        page?: string;
        limit?: string;
      };

      const page = parseInt(query.page ?? "1");
      const limit = parseInt(query.limit ?? "20");
      const skip = (page - 1) * limit;

      const where: any = { schoolId };
      if (query.type) where.applicantType = query.type;
      if (query.status && query.status !== "ALL") where.status = query.status;
      if (query.from || query.to) {
        where.fromDate = {};
        if (query.from) where.fromDate.gte = new Date(query.from);
        if (query.to) where.fromDate.lte = new Date(query.to);
      }

      const [leaves, total] = await Promise.all([
        prisma.leaveRequest.findMany({
          where, skip, take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            staff: {
              include: {
                user: { select: { id: true, name: true, phone: true, email: true, avatarUrl: true } },
              },
            },
            studentUser: {
              select: { id: true, name: true, phone: true, email: true, avatarUrl: true },
            },
            approvedBy: { select: { id: true, name: true } },
          },
        }),
        prisma.leaveRequest.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: {
          leaves, total, page, limit,
          totalPages: Math.ceil(total / limit),
        },
      });
    }
  );

  // ── GET /admin/leaves/stats ───────────────────────────────
  app.get(
    "/admin/leaves/stats",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const today = new Date();
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

      const [
        pendingStaff, pendingStudent,
        approvedThisMonth, rejectedThisMonth,
        todayLeaves, upcomingLeaves,
      ] = await Promise.all([
        prisma.leaveRequest.count({ where: { schoolId, applicantType: "STAFF", status: "PENDING" } }),
        prisma.leaveRequest.count({ where: { schoolId, applicantType: "STUDENT", status: "PENDING" } }),
        prisma.leaveRequest.count({ where: { schoolId, status: "APPROVED", approvedAt: { gte: monthStart, lte: monthEnd } } }),
        prisma.leaveRequest.count({ where: { schoolId, status: "REJECTED", updatedAt: { gte: monthStart, lte: monthEnd } } }),
        prisma.leaveRequest.findMany({
          where: { schoolId, status: "APPROVED", fromDate: { lte: today }, toDate: { gte: today } },
          include: {
            staff: { include: { user: { select: { name: true } } } },
            studentUser: { select: { name: true } },
          },
        }),
        prisma.leaveRequest.findMany({
          where: { schoolId, status: "APPROVED", fromDate: { gt: today } },
          orderBy: { fromDate: "asc" },
          take: 10,
          include: {
            staff: { include: { user: { select: { name: true } } } },
            studentUser: { select: { name: true } },
          },
        }),
      ]);

      // Last 30 days chart data
      const chartData = [];
      for (let i = 29; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dayStart = new Date(date); dayStart.setHours(0,0,0,0);
        const dayEnd = new Date(date); dayEnd.setHours(23,59,59,999);

        const [approved, rejected, pending] = await Promise.all([
          prisma.leaveRequest.count({ where: { schoolId, status: "APPROVED", approvedAt: { gte: dayStart, lte: dayEnd } } }),
          prisma.leaveRequest.count({ where: { schoolId, status: "REJECTED", updatedAt: { gte: dayStart, lte: dayEnd } } }),
          prisma.leaveRequest.count({ where: { schoolId, status: "PENDING", createdAt: { gte: dayStart, lte: dayEnd } } }),
        ]);

        chartData.push({
          date: date.toISOString().split("T")[0],
          approved, rejected, pending,
        });
      }

      return reply.send({
        success: true,
        data: {
          pendingStaff, pendingStudent,
          approvedThisMonth, rejectedThisMonth,
          todayLeaves, upcomingLeaves,
          chartData,
        },
      });
    }
  );

  // ── GET /admin/leaves/:id ─────────────────────────────────
  app.get(
    "/admin/leaves/:id",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const leave = await prisma.leaveRequest.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          staff: {
            include: {
              user: { select: { id: true, name: true, phone: true, email: true, gender: true } },
            },
          },
          studentUser: {
            select: { id: true, name: true, phone: true, email: true },
            include: {
              children: {
                include: {
                  parent: { select: { id: true, name: true, phone: true, email: true } },
                },
              },
            } as any,
          },
          approvedBy: { select: { id: true, name: true } },
        },
      });

      if (!leave) return reply.status(404).send({ success: false, message: "Leave not found." });
      return reply.send({ success: true, data: { leave } });
    }
  );

  // ── POST /admin/leaves ────────────────────────────────────
  // Admin creates leave on behalf
  app.post(
    "/admin/leaves",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as {
        applicantType: "STAFF" | "STUDENT";
        staffId?: number;
        studentUserId?: number;
        leaveType: string;
        fromDate: string;
        toDate: string;
        reason: string;
      };

      if (!body.fromDate || !body.toDate || !body.reason) {
        return reply.status(400).send({ success: false, message: "fromDate, toDate and reason are required." });
      }

      const from = new Date(body.fromDate);
      const to = new Date(body.toDate);
      if (from > to) return reply.status(400).send({ success: false, message: "fromDate must be before toDate." });

      const totalDays = calcWorkingDays(from, to);

      const leave = await prisma.leaveRequest.create({
        data: {
          schoolId,
          applicantType: body.applicantType,
          staffId: body.staffId ?? null,
          studentUserId: body.studentUserId ?? null,
          leaveType: body.leaveType as any,
          fromDate: from,
          toDate: to,
          totalDays,
          reason: body.reason.trim(),
          status: "PENDING",
        },
      });

      return reply.status(201).send({
        success: true,
        message: "Leave request created.",
        data: { leave },
      });
    }
  );

  // ── PATCH /admin/leaves/:id/approve ──────────────────────
  app.patch(
    "/admin/leaves/:id/approve",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const { id } = request.params as { id: string };

      const leave = await prisma.leaveRequest.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          staff: { include: { user: { select: { name: true, phone: true, email: true } } } },
          studentUser: {
            select: { name: true, phone: true, email: true },
            include: {
              children: {
                include: { parent: { select: { name: true, phone: true, email: true } } }
              }
            } as any,
          },
        },
      });

      if (!leave) return reply.status(404).send({ success: false, message: "Leave not found." });
      if (leave.status !== "PENDING") {
        return reply.status(400).send({ success: false, message: `Leave is already ${leave.status}.` });
      }

      const updated = await prisma.leaveRequest.update({
        where: { id: parseInt(id) },
        data: {
          status: "APPROVED",
          approvedById: userId,
          approvedAt: new Date(),
          notifiedAt: new Date(),
        },
      });

      // Update leave balance for staff
      if (leave.staffId) {
        const year = new Date().getFullYear();
        const existing = await prisma.leaveBalance.findUnique({
          where: { staffId_year: { staffId: leave.staffId, year } },
        });

        if (existing) {
          const field = leave.leaveType === "SICK" ? "sickUsed"
            : leave.leaveType === "CASUAL" ? "casualUsed"
            : leave.leaveType === "EARNED" ? "earnedUsed" : null;

          if (field) {
            await prisma.leaveBalance.update({
              where: { staffId_year: { staffId: leave.staffId, year } },
              data: { [field]: { increment: leave.totalDays } },
            });
          }
        } else {
          // Create balance record
          await prisma.leaveBalance.create({
            data: {
              schoolId, staffId: leave.staffId, year,
              sickUsed: leave.leaveType === "SICK" ? leave.totalDays : 0,
              casualUsed: leave.leaveType === "CASUAL" ? leave.totalDays : 0,
              earnedUsed: leave.leaveType === "EARNED" ? leave.totalDays : 0,
            },
          });
        }
      }

      return reply.send({
        success: true,
        message: "Leave approved. Notification sent.",
        data: { leave: updated },
      });
    }
  );

  // ── PATCH /admin/leaves/:id/reject ───────────────────────
  app.patch(
    "/admin/leaves/:id/reject",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const { id } = request.params as { id: string };
      const { rejectionNote } = request.body as { rejectionNote?: string };

      const leave = await prisma.leaveRequest.findFirst({
        where: { id: parseInt(id), schoolId },
      });

      if (!leave) return reply.status(404).send({ success: false, message: "Leave not found." });
      if (leave.status !== "PENDING") {
        return reply.status(400).send({ success: false, message: `Leave is already ${leave.status}.` });
      }

      const updated = await prisma.leaveRequest.update({
        where: { id: parseInt(id) },
        data: {
          status: "REJECTED",
          approvedById: userId,
          approvedAt: new Date(),
          rejectionNote: rejectionNote?.trim() ?? null,
          notifiedAt: new Date(),
        },
      });

      return reply.send({
        success: true,
        message: "Leave rejected.",
        data: { leave: updated },
      });
    }
  );

  // ── DELETE /admin/leaves/:id ──────────────────────────────
  app.delete(
    "/admin/leaves/:id",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const leave = await prisma.leaveRequest.findFirst({
        where: { id: parseInt(id), schoolId, status: "PENDING" },
      });

      if (!leave) return reply.status(404).send({ success: false, message: "Only pending leaves can be deleted." });

      await prisma.leaveRequest.delete({ where: { id: parseInt(id) } });
      return reply.send({ success: true, message: "Leave request deleted." });
    }
  );

  // ── GET /admin/leaves/balance/:staffId ────────────────────
  app.get(
    "/admin/leaves/balance/:staffId",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { staffId } = request.params as { staffId: string };
      const year = new Date().getFullYear();

      let balance = await prisma.leaveBalance.findUnique({
        where: { staffId_year: { staffId: parseInt(staffId), year } },
      });

      if (!balance) {
        balance = await prisma.leaveBalance.create({
          data: { schoolId, staffId: parseInt(staffId), year },
        });
      }

      return reply.send({ success: true, data: { balance } });
    }
  );

  // ── GET /admin/leaves/calendar ────────────────────────────
  app.get(
    "/admin/leaves/calendar",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const query = request.query as { month?: string; year?: string };

      const year = parseInt(query.year ?? String(new Date().getFullYear()));
      const month = parseInt(query.month ?? String(new Date().getMonth() + 1));

      const from = new Date(year, month - 1, 1);
      const to = new Date(year, month, 0);

      const leaves = await prisma.leaveRequest.findMany({
        where: {
          schoolId,
          OR: [
            { fromDate: { gte: from, lte: to } },
            { toDate: { gte: from, lte: to } },
            { fromDate: { lte: from }, toDate: { gte: to } },
          ],
        },
        include: {
          staff: { include: { user: { select: { name: true } } } },
          studentUser: { select: { name: true } },
        },
        orderBy: { fromDate: "asc" },
      });

      return reply.send({ success: true, data: { leaves, month, year } });
    }
  );
}