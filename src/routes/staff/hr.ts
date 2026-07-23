import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { requireCapability } from "../../middleware/checkCapability.js";

function todayDateOnly(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function staffHrRoutes(app: FastifyInstance) {
  const P = "/staff/hr";

  // ── GET /staff/hr/overview ───────────────────────────────
  app.get(`${P}/overview`, { preHandler: [appAuth, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const today = todayDateOnly();
      const yearLabel = new Date().getMonth() >= 3 ? `${new Date().getFullYear()}-${new Date().getFullYear() + 1}` : `${new Date().getFullYear() - 1}-${new Date().getFullYear()}`;

      const [todayAttendance, pendingLeaves, balances] = await Promise.all([
        prisma.staffAttendance.findFirst({ where: { staffId, date: today } }),
        prisma.hrLeaveApplication.count({ where: { staffId, status: "PENDING" } }),
        prisma.hrLeaveBalance.findMany({ where: { staffId, academicYear: yearLabel }, include: { leaveType: { select: { name: true, color: true } } } }),
      ]);

      return reply.send({
        success: true,
        data: {
          todayStatus: todayAttendance?.status ?? null,
          checkedIn: !!todayAttendance?.inTime,
          checkedOut: !!todayAttendance?.outTime,
          inTime: todayAttendance?.inTime ?? null,
          pendingLeaves,
          leaveBalances: balances.map((b) => ({
            leaveType: b.leaveType.name, color: b.leaveType.color,
            total: b.totalDays, used: b.usedDays, pending: b.pendingDays,
            remaining: b.totalDays - b.usedDays - b.pendingDays,
          })),
        },
      });
    }
  );

  // ── GET /staff/hr/attendance ──────────────────────────────
  app.get(`${P}/attendance`, { preHandler: [appAuth, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { staffId } = req as any;
      const q = req.query as { month?: string; year?: string };
      const now = new Date();
      const month = q.month ? Number(q.month) : now.getMonth() + 1;
      const year = q.year ? Number(q.year) : now.getFullYear();

      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0, 23, 59, 59);

      const records = await prisma.staffAttendance.findMany({
        where: { staffId, date: { gte: start, lte: end } },
        orderBy: { date: "asc" },
      });

      const summary = {
        present: records.filter((r) => r.status === "PRESENT").length,
        absent: records.filter((r) => r.status === "ABSENT").length,
        late: records.filter((r) => r.status === "LATE").length,
        halfDay: records.filter((r) => r.status === "HALF_DAY").length,
        onLeave: records.filter((r) => r.status === "ON_LEAVE").length,
      };

      return reply.send({ success: true, data: { records, summary } });
    }
  );

  // ── POST /staff/hr/attendance/check-in ───────────────────
  app.post(`${P}/attendance/check-in`, { preHandler: [appAuth, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId, userId } = req as any;
      const today = todayDateOnly();
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

      const existing = await prisma.staffAttendance.findFirst({ where: { staffId, date: today } });
      if (existing?.inTime) return reply.status(409).send({ success: false, message: "You've already checked in today." });

      const record = existing
        ? await prisma.staffAttendance.update({ where: { id: existing.id }, data: { inTime: timeStr, status: "PRESENT" } })
        : await prisma.staffAttendance.create({ data: { schoolId, staffId, date: today, inTime: timeStr, status: "PRESENT", isManual: false, markedById: userId } });

      return reply.send({ success: true, message: "Checked in successfully.", data: { record } });
    }
  );

  // ── POST /staff/hr/attendance/check-out ──────────────────
  app.post(`${P}/attendance/check-out`, { preHandler: [appAuth, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { staffId } = req as any;
      const today = todayDateOnly();
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

      const existing = await prisma.staffAttendance.findFirst({ where: { staffId, date: today } });
      if (!existing?.inTime) return reply.status(409).send({ success: false, message: "You haven't checked in yet today." });
      if (existing.outTime) return reply.status(409).send({ success: false, message: "You've already checked out today." });

      const record = await prisma.staffAttendance.update({ where: { id: existing.id }, data: { outTime: timeStr } });
      return reply.send({ success: true, message: "Checked out successfully.", data: { record } });
    }
  );

  // ── GET /staff/hr/leaves/types ────────────────────────────
  app.get(`${P}/leaves/types`, { preHandler: [appAuth, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const types = await prisma.hrLeaveType.findMany({ where: { schoolId, isActive: true }, orderBy: { name: "asc" } });
      return reply.send({ success: true, data: { types } });
    }
  );

  // ── GET /staff/hr/leaves ───────────────────────────────────
  app.get(`${P}/leaves`, { preHandler: [appAuth, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { staffId } = req as any;
      const q = req.query as { status?: string };
      const where: any = { staffId };
      if (q.status) where.status = q.status;

      const leaves = await prisma.hrLeaveApplication.findMany({
        where, orderBy: { appliedAt: "desc" },
        include: { leaveType: { select: { name: true, color: true, isPaid: true } } },
      });
      return reply.send({ success: true, data: { leaves } });
    }
  );

  // ── GET /staff/hr/leaves/:id ───────────────────────────────
  app.get(`${P}/leaves/:id`, { preHandler: [appAuth, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { staffId } = req as any;
      const { id } = req.params as { id: string };
      const leave = await prisma.hrLeaveApplication.findFirst({
        where: { id: Number(id), staffId },
        include: { leaveType: { select: { name: true, color: true, isPaid: true } } },
      });
      if (!leave) return reply.status(404).send({ success: false, message: "Leave application not found." });
      return reply.send({ success: true, data: { leave } });
    }
  );

  // ── POST /staff/hr/leaves ──────────────────────────────────
  app.post(`${P}/leaves`, { preHandler: [appAuth, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const b = req.body as { leaveTypeId: number; fromDate: string; toDate: string; isHalfDay?: boolean; halfDayType?: string; reason: string };

      if (!b.leaveTypeId || !b.fromDate || !b.toDate || !b.reason?.trim()) {
        return reply.status(400).send({ success: false, message: "leaveTypeId, fromDate, toDate and reason are required." });
      }

      const from = new Date(b.fromDate);
      const to = new Date(b.toDate);
      const totalDays = b.isHalfDay ? 0.5 : Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;

      const leave = await prisma.hrLeaveApplication.create({
        data: {
          schoolId, staffId, leaveTypeId: b.leaveTypeId,
          fromDate: from, toDate: to, totalDays, isHalfDay: b.isHalfDay ?? false, halfDayType: b.halfDayType,
          reason: b.reason, status: "PENDING",
        },
      });

      // Reflect the request in the balance immediately as "pending" so the
      // staff sees their remaining days shrink right away, even before HR acts.
      const yearLabel = new Date().getMonth() >= 3 ? `${new Date().getFullYear()}-${new Date().getFullYear() + 1}` : `${new Date().getFullYear() - 1}-${new Date().getFullYear()}`;
      await prisma.hrLeaveBalance.upsert({
        where: { staffId_leaveTypeId_academicYear: { staffId, leaveTypeId: b.leaveTypeId, academicYear: yearLabel } },
        create: { schoolId, staffId, leaveTypeId: b.leaveTypeId, academicYear: yearLabel, pendingDays: totalDays },
        update: { pendingDays: { increment: totalDays } },
      });

      return reply.status(201).send({ success: true, message: "Leave application submitted.", data: { id: leave.id } });
    }
  );

  // ── GET /staff/hr/salary ───────────────────────────────────
  // This is the revision/change-log view (increments, promotions) — for
  // an actual month-by-month statement, see GET /payslips below.
  app.get(`${P}/salary`, { preHandler: [appAuth, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { staffId } = req as any;
      const revisions = await prisma.hrSalaryRevision.findMany({
        where: { staffId }, orderBy: { effectiveDate: "desc" },
      });
      return reply.send({
        success: true,
        data: { current: revisions[0] ?? null, history: revisions.slice(1) },
      });
    }
  );

  // ── GET /staff/hr/payslips ─────────────────────────────────
  app.get(`${P}/payslips`, { preHandler: [appAuth, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { staffId } = req as any;
      const q = req.query as { year?: string };
      const where: any = { staffId };
      if (q.year) where.year = Number(q.year);

      const payslips = await prisma.payslip.findMany({
        where, orderBy: [{ year: "desc" }, { month: "desc" }],
        select: { id: true, month: true, year: true, netSalary: true, grossSalary: true, status: true, generatedAt: true, paidAt: true },
      });
      return reply.send({ success: true, data: { payslips } });
    }
  );

  // ── GET /staff/hr/payslips/:id ──────────────────────────────
  app.get(`${P}/payslips/:id`, { preHandler: [appAuth, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { staffId } = req as any;
      const { id } = req.params as { id: string };
      const payslip = await prisma.payslip.findFirst({ where: { id: Number(id), staffId } });
      if (!payslip) return reply.status(404).send({ success: false, message: "Payslip not found." });
      return reply.send({ success: true, data: { payslip } });
    }
  );

  // ── GET /staff/hr/directory ────────────────────────────────
  app.get(`${P}/directory`, { preHandler: [appAuth, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = req.query as { search?: string; departmentId?: string };
      const where: any = { schoolId, isActive: true };
      if (q.departmentId) where.departmentId = Number(q.departmentId);
      if (q.search) where.user = { name: { contains: q.search, mode: "insensitive" } };

      const staff = await prisma.staff.findMany({
        where, orderBy: { user: { name: "asc" } }, take: 100,
        include: { user: { select: { name: true, avatarUrl: true, phone: true, email: true } }, departmentRef: { select: { name: true } }, designationRef: { select: { name: true } } },
      });

      return reply.send({
        success: true,
        data: {
          staff: staff.map((s) => ({
            id: s.id, name: s.user.name, avatarUrl: s.user.avatarUrl,
            department: s.departmentRef?.name ?? "—", designation: s.designationRef?.name ?? "—",
            phone: s.user.phone, email: s.user.email,
          })),
        },
      });
    }
  );
}
