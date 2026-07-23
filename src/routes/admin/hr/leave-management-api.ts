// apps/api/src/routes/admin/hr/leave-management-api.ts
// Pure TypeScript — NO JSX, NO React, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminLeaveManagementRoutes(app: FastifyInstance) {

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get("/admin/hr/leave/dashboard", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const [
        totalStaff, totalRequests, approved, pending, rejected,
        onLeaveToday, byType, recentApplications
      ] = await Promise.all([
        prisma.staff.count({ where: { schoolId, status: { in: ["ACTIVE", "PROBATION"] } } }),
        prisma.hrLeaveApplication.count({ where: { schoolId } }),
        prisma.hrLeaveApplication.count({ where: { schoolId, status: "APPROVED" } }),
        prisma.hrLeaveApplication.count({ where: { schoolId, status: "PENDING" } }),
        prisma.hrLeaveApplication.count({ where: { schoolId, status: "REJECTED" } }),
        prisma.hrLeaveApplication.count({
          where: {
            schoolId, status: "APPROVED",
            fromDate: { lte: today }, toDate: { gte: today },
          },
        }),
        prisma.hrLeaveType.findMany({
          where: { schoolId, isActive: true },
          include: { _count: { select: { applications: { where: { schoolId } } } } },
        }),
        prisma.hrLeaveApplication.findMany({
          where:   { schoolId },
          orderBy: { appliedAt: "desc" },
          take:    8,
          include: {
            staff:     { include: { user: { select: { name: true, avatarUrl: true } } } },
            leaveType: { select: { name: true, code: true, color: true } },
          },
        }),
      ]);

      return reply.send({
        success: true,
        data: {
          kpis: { totalStaff, totalRequests, approved, pending, rejected, onLeaveToday },
          byType: byType.map(t => ({ name: t.name, code: t.code, color: t.color, count: t._count.applications })),
          recentApplications,
        },
      });
    }
  );

  // ─── LEAVE TYPES ──────────────────────────────────────────
  app.get("/admin/hr/leave/types", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const types = await prisma.hrLeaveType.findMany({
        where:   { schoolId },
        orderBy: { name: "asc" },
        include: { _count: { select: { applications: true } } },
      });
      return reply.send({ success: true, data: { types } });
    }
  );

  app.post("/admin/hr/leave/types", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as {
        name: string; code: string; annualQuota?: number; carryForward?: boolean;
        maxCarryForward?: number; encashmentAllowed?: boolean; isPaid?: boolean;
        halfDayAllowed?: boolean; requiresApproval?: boolean;
        minDays?: number; maxDays?: number; noticeDays?: number; color?: string;
      };
      if (!body.name || !body.code) {
        return reply.status(400).send({ success: false, message: "name and code are required." });
      }
      const existing = await prisma.hrLeaveType.findFirst({ where: { schoolId, code: body.code.toUpperCase() } });
      if (existing) return reply.status(409).send({ success: false, message: "Leave type code already exists." });
      const lt = await prisma.hrLeaveType.create({
        data: {
          schoolId,
          name:               body.name,
          code:               body.code.toUpperCase(),
          annualQuota:        body.annualQuota        ?? 0,
          carryForward:       body.carryForward       ?? false,
          maxCarryForward:    body.maxCarryForward     ?? 0,
          encashmentAllowed:  body.encashmentAllowed  ?? false,
          isPaid:             body.isPaid             ?? true,
          halfDayAllowed:     body.halfDayAllowed     ?? true,
          requiresApproval:   body.requiresApproval   ?? true,
          minDays:            body.minDays            ?? 0.5,
          maxDays:            body.maxDays            ?? 30,
          noticeDays:         body.noticeDays         ?? 0,
          color:              body.color              ?? "#6366f1",
        },
      });
      return reply.status(201).send({ success: true, data: { id: lt.id } });
    }
  );

  app.put("/admin/hr/leave/types/:id", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.hrLeaveType.updateMany({ where: { id: parseInt(id), schoolId }, data: req.body as any });
      return reply.send({ success: true });
    }
  );

  app.delete("/admin/hr/leave/types/:id", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const inUse = await prisma.hrLeaveApplication.count({ where: { schoolId, leaveTypeId: parseInt(id) } });
      if (inUse > 0) {
        await prisma.hrLeaveType.updateMany({ where: { id: parseInt(id), schoolId }, data: { isActive: false } });
        return reply.send({ success: true, message: "Deactivated (has applications)." });
      }
      await prisma.hrLeaveType.deleteMany({ where: { id: parseInt(id), schoolId } });
      return reply.send({ success: true });
    }
  );

  // ─── APPLICATIONS ─────────────────────────────────────────
  app.get("/admin/hr/leave/applications", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as {
        page?: string; status?: string; staffId?: string;
        leaveTypeId?: string; month?: string; year?: string;
      };
      const page  = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 20;
      const where: any = { schoolId };
      if (q.status)      where.status      = q.status;
      if (q.staffId)     where.staffId     = parseInt(q.staffId);
      if (q.leaveTypeId) where.leaveTypeId = parseInt(q.leaveTypeId);
      if (q.month && q.year) {
        const from = new Date(parseInt(q.year), parseInt(q.month) - 1, 1);
        const to   = new Date(parseInt(q.year), parseInt(q.month), 0);
        where.fromDate = { gte: from, lte: to };
      }
      const [apps, total] = await Promise.all([
        prisma.hrLeaveApplication.findMany({
          where, skip: (page-1)*limit, take: limit,
          orderBy: { appliedAt: "desc" },
          include: {
            staff:     { include: { user: { select: { name: true, avatarUrl: true } }, departmentRef: { select: { name: true } } } },
            leaveType: { select: { name: true, code: true, color: true, isPaid: true } },
          },
        }),
        prisma.hrLeaveApplication.count({ where }),
      ]);
      return reply.send({ success: true, data: { applications: apps, total, totalPages: Math.ceil(total / limit) } });
    }
  );

  app.post("/admin/hr/leave/applications", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        staffId: number; leaveTypeId: number; fromDate: string; toDate: string;
        reason: string; isHalfDay?: boolean; halfDayType?: string; attachment?: string;
      };
      if (!body.staffId || !body.leaveTypeId || !body.fromDate || !body.toDate || !body.reason) {
        return reply.status(400).send({ success: false, message: "staffId, leaveTypeId, fromDate, toDate, reason required." });
      }

      const from = new Date(body.fromDate);
      const to   = new Date(body.toDate);

      // Calculate business days
      let days = 0;
      const cur = new Date(from);
      while (cur <= to) {
        const dow = cur.getDay();
        if (dow !== 0 && dow !== 6) days++;
        cur.setDate(cur.getDate() + 1);
      }
      if (body.isHalfDay) days = 0.5;

      // Check balance
      const currentYear = new Date().getFullYear();
      const academicYear = `${currentYear}-${currentYear + 1}`;
      const balance = await prisma.hrLeaveBalance.findFirst({
        where: { staffId: body.staffId, leaveTypeId: body.leaveTypeId, academicYear },
      });
      const available = balance ? (balance.totalDays + balance.carryForward - balance.usedDays - balance.pendingDays) : 0;
      if (available < days) {
        return reply.status(400).send({ success: false, message: `Insufficient balance. Available: ${available}, Requested: ${days}` });
      }

      const app2 = await prisma.$transaction(async (tx) => {
        const application = await tx.hrLeaveApplication.create({
          data: {
            schoolId, staffId: body.staffId, leaveTypeId: body.leaveTypeId,
            fromDate: from, toDate: to, totalDays: days,
            isHalfDay: body.isHalfDay ?? false, halfDayType: body.halfDayType ?? null,
            reason: body.reason, attachment: body.attachment ?? null,
            status: "SUBMITTED",
          },
        });
        // Update pending balance
        if (balance) {
          await tx.hrLeaveBalance.update({
            where: { id: balance.id },
            data:  { pendingDays: { increment: days } },
          });
        }
        return application;
      });
      return reply.status(201).send({ success: true, data: { id: app2.id } });
    }
  );

  app.patch("/admin/hr/leave/applications/:id/approve", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId, role } = req.user as any;
      const { id } = req.params as { id: string };
      const { action, note } = req.body as { action: "APPROVED" | "REJECTED"; note?: string };

      const application = await prisma.hrLeaveApplication.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!application) return reply.status(404).send({ success: false, message: "Application not found." });

      const isHR = ["HR", "ADMIN", "SUPERADMIN"].includes(role);
      const updateData: any = {};

      if (isHR) {
        updateData.hrId        = userId;
        updateData.hrAction    = action;
        updateData.hrNote      = note ?? null;
        updateData.hrActionAt  = new Date();
        updateData.status      = action;
      } else {
        updateData.managerId        = userId;
        updateData.managerAction    = action;
        updateData.managerNote      = note ?? null;
        updateData.managerActionAt  = new Date();
        updateData.status           = action === "APPROVED" ? "PENDING" : "REJECTED";
      }

      await prisma.$transaction(async (tx) => {
        await tx.hrLeaveApplication.update({ where: { id: parseInt(id) }, data: updateData });

        // On final approval — deduct balance
        if (action === "APPROVED" && isHR) {
          const currentYear = new Date().getFullYear();
          const academicYear = `${currentYear}-${currentYear + 1}`;
          const balance = await tx.hrLeaveBalance.findFirst({
            where: { staffId: application.staffId, leaveTypeId: application.leaveTypeId, academicYear },
          });
          if (balance) {
            await tx.hrLeaveBalance.update({
              where: { id: balance.id },
              data: {
                usedDays:    { increment: application.totalDays },
                pendingDays: { decrement: application.totalDays },
              },
            });
          }
        }
        // On rejection — release pending
        if (action === "REJECTED") {
          const currentYear = new Date().getFullYear();
          const academicYear = `${currentYear}-${currentYear + 1}`;
          const balance = await tx.hrLeaveBalance.findFirst({
            where: { staffId: application.staffId, leaveTypeId: application.leaveTypeId, academicYear },
          });
          if (balance) {
            await tx.hrLeaveBalance.update({
              where: { id: balance.id },
              data:  { pendingDays: { decrement: application.totalDays } },
            });
          }
        }
      });

      return reply.send({ success: true, message: `Application ${action.toLowerCase()}.` });
    }
  );

  // ─── LEAVE BALANCE ────────────────────────────────────────
  app.get("/admin/hr/leave/balance", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { staffId, academicYear } = req.query as { staffId?: string; academicYear?: string };
      const year = academicYear ?? `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;
      const where: any = { academicYear: year };
      if (staffId) where.staffId = parseInt(staffId);

      const balances = await prisma.hrLeaveBalance.findMany({
        where: { ...where, staff: { schoolId } },
        include: {
          staff:     { include: { user: { select: { name: true } } } },
          leaveType: { select: { name: true, code: true, color: true } },
        },
      });
      return reply.send({ success: true, data: { balances, academicYear: year } });
    }
  );

  app.post("/admin/hr/leave/balance/allocate", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as {
        staffId?: number; leaveTypeId: number; totalDays: number; academicYear?: string;
        allocateAll?: boolean;
      };
      const academicYear = body.academicYear ?? `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;
      const staffIds: number[] = [];

      if (body.allocateAll) {
        const allStaff = await prisma.staff.findMany({
          where: { schoolId, status: { in: ["ACTIVE", "PROBATION"] } },
          select: { id: true },
        });
        staffIds.push(...allStaff.map(s => s.id));
      } else if (body.staffId) {
        staffIds.push(body.staffId);
      }

      let count = 0;
      for (const sid of staffIds) {
        await prisma.hrLeaveBalance.upsert({
          where:  { staffId_leaveTypeId_academicYear: { staffId: sid, leaveTypeId: body.leaveTypeId, academicYear } },
          update: { totalDays: body.totalDays },
          create: {schoolId,staffId: sid,leaveTypeId: body.leaveTypeId,academicYear,totalDays: body.totalDays},
        });
        count++;
      }
      return reply.send({ success: true, message: `Balance allocated for ${count} staff.` });
    }
  );

  // ─── HOLIDAYS ─────────────────────────────────────────────
  app.get("/admin/hr/leave/holidays", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { year } = req.query as { year?: string };
      const y = parseInt(year ?? String(new Date().getFullYear()));
      const holidays = await prisma.hrHoliday.findMany({
        where:   { schoolId, year: y, isActive: true },
        orderBy: { date: "asc" },
      });
      return reply.send({ success: true, data: { holidays, year: y } });
    }
  );

  app.post("/admin/hr/leave/holidays", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { name, date, type, description } = req.body as {
        name: string; date: string; type?: string; description?: string;
      };
      if (!name || !date) return reply.status(400).send({ success: false, message: "name and date required." });
      const d = new Date(date);
      const h = await prisma.hrHoliday.create({
        data: {
          schoolId, name, date: d, year: d.getFullYear(),
          type: type as any ?? "SCHOOL", description: description ?? null,
        },
      });
      return reply.status(201).send({ success: true, data: { id: h.id } });
    }
  );

  app.delete("/admin/hr/leave/holidays/:id", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.hrHoliday.updateMany({ where: { id: parseInt(id), schoolId }, data: { isActive: false } });
      return reply.send({ success: true });
    }
  );

  // ─── LEAVE CALENDAR ───────────────────────────────────────
  app.get("/admin/hr/leave/calendar", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { from, to } = req.query as { from: string; to: string };
      if (!from || !to) return reply.status(400).send({ success: false, message: "from and to required." });

      const [applications, holidays] = await Promise.all([
        prisma.hrLeaveApplication.findMany({
          where: {
            schoolId, status: { in: ["APPROVED", "PENDING"] },
            fromDate: { gte: new Date(from) }, toDate: { lte: new Date(to) },
          },
          include: {
            staff:     { include: { user: { select: { name: true } } } },
            leaveType: { select: { name: true, code: true, color: true } },
          },
        }),
        prisma.hrHoliday.findMany({
          where: {
            schoolId, isActive: true,
            date: { gte: new Date(from), lte: new Date(to) },
          },
        }),
      ]);
      return reply.send({ success: true, data: { applications, holidays } });
    }
  );

  // ─── SETTINGS ─────────────────────────────────────────────
  app.get("/admin/hr/leave/settings", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const settings = await prisma.hrLeaveSettings.findUnique({ where: { schoolId } });
      return reply.send({ success: true, data: { settings } });
    }
  );

  app.put("/admin/hr/leave/settings", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const settings = await prisma.hrLeaveSettings.upsert({
        where:  { schoolId },
        update: req.body as any,
        create: { schoolId, ...(req.body as any) },
      });
      return reply.send({ success: true, data: { settings } });
    }
  );

  // ─── COMP OFF ─────────────────────────────────────────────
  app.get("/admin/hr/leave/compoff", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const compoffs = await prisma.hrCompOff.findMany({
        where: { staff: { schoolId }, isActive: true },
        include: { staff: { include: { user: { select: { name: true } } } } },
        orderBy: { workedDate: "desc" },
      });
      return reply.send({ success: true, data: { compoffs } });
    }
  );

  app.post("/admin/hr/leave/compoff", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { staffId, workedDate, earnedDays, reason, expiryDate } = req.body as {
        staffId: number; workedDate: string; earnedDays?: number; reason?: string; expiryDate?: string;
      };
      const co = await prisma.hrCompOff.create({
        data: {
          schoolId, staffId, workedDate: new Date(workedDate),
          earnedDays: earnedDays ?? 1, reason: reason ?? null,
          expiryDate: expiryDate ? new Date(expiryDate) : null,
        },
      });
      return reply.status(201).send({ success: true, data: { id: co.id } });
    }
  );

  // ─── LEAVE REPORT ─────────────────────────────────────────
  app.get("/admin/hr/leave/reports", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { type, academicYear, departmentId } = req.query as {
        type?: string; academicYear?: string; departmentId?: string;
      };
      const year = academicYear ?? `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;

      if (type === "balance") {
        const where: any = { academicYear: year, staff: { schoolId } };
        if (departmentId) where.staff = { ...where.staff, departmentId: parseInt(departmentId) };
        const data = await prisma.hrLeaveBalance.findMany({
          where,
          include: {
            staff:     { include: {user: {select: {name: true,avatarUrl: true}},departmentRef: {select: {name: true}}} },
            leaveType: { select: { name: true, code: true } },
          },
          orderBy: [{ staff: { user: { name: "asc" } } }],
        });
        return reply.send({ success: true, data: { balances: data, academicYear: year } });
      }

      // Default: leave register
      const where: any = { schoolId };
      if (departmentId) where.staff = { departmentId: parseInt(departmentId) };
      const data = await prisma.hrLeaveApplication.findMany({
        where, orderBy: { appliedAt: "desc" },
        include: {
          staff:     {include: {user: {select: {name: true,avatarUrl: true}},departmentRef: {select: {name: true}}} },
          leaveType: { select: { name: true, code: true } },
        },
      });
      return reply.send({ success: true, data: { applications: data, generatedAt: new Date().toISOString() } });
    }
  );
}
