// apps/api/src/routes/admin/hr/hr-attendance.ts
// FIXED: prisma.shift → prisma.hrShift (because Shift was an enum, model renamed to HrShift)

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminHrAttendanceRoutes(app: FastifyInstance) {

  // ─── ATTENDANCE DASHBOARD ──────────────────────────────────
  app.get("/admin/hr/attendance/dashboard", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const today = new Date();
      const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());

      const totalStaff = await prisma.staff.count({ where: { schoolId, status: { in: ["ACTIVE","PROBATION"] } } });

      const [byStatus, lateToday, missingPunch, pendingCorrections] = await Promise.all([
        prisma.staffAttendance.groupBy({ by: ["status"], where: { schoolId, date: todayDate }, _count: true }),
        prisma.staffAttendance.count({ where: { schoolId, date: todayDate, status: "LATE" } }),
        prisma.staffAttendance.count({ where: { schoolId, date: todayDate, status: "MISSING_PUNCH" } }),
        prisma.attendanceCorrection.count({ where: { schoolId, status: "PENDING" } }),
      ]);

      const marked = byStatus.reduce((s, b) => s + b._count, 0);
      const notMarked = Math.max(0, totalStaff - marked);

      return reply.send({ success: true, data: {
        kpi: {
          totalStaff, marked, notMarked, lateToday, missingPunch, pendingApprovals: pendingCorrections,
          present: byStatus.find(b => b.status === "PRESENT")?._count ?? 0,
          absent:  byStatus.find(b => b.status === "ABSENT")?._count ?? 0,
          onLeave: byStatus.find(b => b.status === "LEAVE")?._count ?? 0,
          halfDay: byStatus.find(b => b.status === "HALF_DAY")?._count ?? 0,
        },
        byStatus: byStatus.map(b => ({ status: b.status, count: b._count })),
      }});
    }
  );

  // ─── DAILY ATTENDANCE LIST ─────────────────────────────────
  app.get("/admin/hr/attendance/daily", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { date?: string; departmentId?: string; status?: string; page?: string; search?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 30;
      const targetDate = q.date ? new Date(q.date) : new Date();
      const dateOnly = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());

      const staffWhere: any = { schoolId, status: { in: ["ACTIVE","PROBATION"] } };
      if (q.departmentId) staffWhere.departmentId = parseInt(q.departmentId);
      if (q.search) staffWhere.OR = [
        { user: { name: { contains: q.search, mode: "insensitive" } } },
        { employeeId: { contains: q.search, mode: "insensitive" } },
      ];

      const [allStaff, totalCount] = await Promise.all([
        prisma.staff.findMany({ where: staffWhere, skip: (page-1)*limit, take: limit,
          include: {
            user: {select: {name: true,avatarUrl: true,},},
            departmentRef: {select: {name: true,},},
            designationRef: {select: {name: true,},},
            attendances: {where: { date: dateOnly },take: 1,},
            shiftAssignments: {where: { isActive: true },include: { shift: true },take: 1,orderBy: { createdAt: "desc" },},}
        }),
        prisma.staff.count({ where: staffWhere }),
      ]);

      const result = allStaff
        .filter(s => !q.status || (s.attendances[0]?.status === q.status) || (q.status === "NOT_MARKED" && !s.attendances[0]))
        .map(s => ({
          staffId: s.id, employeeId: s.employeeId,
          name: s.user.name, avatar: s.user.avatarUrl,
          department: s.departmentRef?.name, designation: s.designationRef?.name,
          shift: s.shiftAssignments[0]?.shift ?? null,
          attendance: s.attendances[0] ?? null,
          status: s.attendances[0]?.status ?? "NOT_MARKED",
          inTime: s.attendances[0]?.inTime ?? null,
          outTime: s.attendances[0]?.outTime ?? null,
          lateMinutes: s.attendances[0]?.lateMinutes ?? 0,
        }));

      return reply.send({ success: true, data: { staff: result, total: totalCount, totalPages: Math.ceil(totalCount/limit), date: dateOnly.toISOString() } });
    }
  );

  // ─── MARK SINGLE ATTENDANCE ────────────────────────────────
  app.post("/admin/hr/attendance/mark", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { staffId, date, status, inTime, outTime, remarks } = req.body as { staffId: number; date: string; status: string; inTime?: string; outTime?: string; remarks?: string };
      if (!staffId || !date || !status) return reply.status(400).send({ success: false, message: "staffId, date, status required." });

      const dateOnly = new Date(new Date(date).getFullYear(), new Date(date).getMonth(), new Date(date).getDate());

      // Calculate late minutes from HrShift assignment
      let lateMinutes = 0;
      if (status === "LATE" || status === "PRESENT") {
        // FIX: prisma.shiftAssignment (not prisma.shift)
        const sa = await prisma.shiftAssignment.findFirst({ where: { staffId, isActive: true }, include: { shift: true }, orderBy: { createdAt: "desc" } });
        if (sa?.shift && inTime) {
          const [sh, sm] = sa.shift.startTime.split(":").map(Number);
          const [ih, im] = inTime.split(":").map(Number);
          const shiftStart = sh * 60 + sm + sa.shift.graceMins;
          const inMinutes = ih * 60 + im;
          lateMinutes = Math.max(0, inMinutes - shiftStart);
        }
      }

      const att = await prisma.staffAttendance.upsert({
        where: { staffId_date: { staffId, date: dateOnly } },
        update: { status: status as any, inTime: inTime ?? null, outTime: outTime ?? null, lateMinutes, remarks: remarks ?? null, markedById: userId },
        create: { schoolId, staffId, date: dateOnly, status: status as any, inTime: inTime ?? null, outTime: outTime ?? null, lateMinutes, remarks: remarks ?? null, markedById: userId },
      });

      await prisma.attendanceLog.create({ data: { schoolId, staffId, eventType: "MANUAL_EDIT", punchTime: new Date(), source: "MANUAL", note: `Marked ${status}` } }).catch(() => {});

      return reply.send({ success: true, data: { id: att.id } });
    }
  );

  // ─── BULK ATTENDANCE ───────────────────────────────────────
  app.post("/admin/hr/attendance/mark-bulk", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { date, departmentId, defaultStatus, overrides } = req.body as { date: string; departmentId?: number; defaultStatus: string; overrides?: Record<number, { status: string; inTime?: string; outTime?: string }> };
      const dateOnly = new Date(new Date(date).getFullYear(), new Date(date).getMonth(), new Date(date).getDate());
      const where: any = { schoolId, status: { in: ["ACTIVE","PROBATION"] } };
      if (departmentId) where.departmentId = departmentId;
      const allStaff = await prisma.staff.findMany({ where, select: { id: true } });
      let marked = 0;
      for (const s of allStaff) {
        const override = overrides?.[s.id];
        const statusToMark = override?.status ?? defaultStatus;
        await prisma.staffAttendance.upsert({
          where: { staffId_date: { staffId: s.id, date: dateOnly } },
          update: { status: statusToMark as any, inTime: override?.inTime ?? null, outTime: override?.outTime ?? null, markedById: userId },
          create: { schoolId, staffId: s.id, date: dateOnly, status: statusToMark as any, inTime: override?.inTime ?? null, outTime: override?.outTime ?? null, markedById: userId },
        });
        marked++;
      }
      return reply.send({ success: true, message: `Attendance marked for ${marked} staff.` });
    }
  );

  // ─── HR SHIFTS CRUD (model = HrShift, prisma = hrShift) ────
  app.get("/admin/hr/shifts", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      // FIX: prisma.hrShift (was prisma.shift)
      const shifts = await prisma.hrShift.findMany({ where: { schoolId, isActive: true }, orderBy: { isDefault: "desc" },
        include: { _count: { select: { assignments: { where: { isActive: true } } } } } });
      return reply.send({ success: true, data: { shifts: shifts.map(s => ({ ...s, assignedCount: s._count.assignments })) } });
    }
  );

  app.post("/admin/hr/shifts", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { name: string; shiftType?: string; startTime: string; endTime: string; graceMins?: number; halfDayAfter?: string; weeklyOffs?: string[]; isDefault?: boolean };
      if (!body.name || !body.startTime || !body.endTime) return reply.status(400).send({ success: false, message: "name, startTime, endTime required." });
      // FIX: prisma.hrShift
      if (body.isDefault) await prisma.hrShift.updateMany({ where: { schoolId }, data: { isDefault: false } });
      const s = await prisma.hrShift.create({ data: {
        schoolId, name: body.name, shiftType: body.shiftType as any ?? "GENERAL",
        startTime: body.startTime, endTime: body.endTime,
        graceMins: body.graceMins ?? 15,
        halfDayAfter: body.halfDayAfter ?? null,
        weeklyOffs: body.weeklyOffs ?? ["SUNDAY"],
        isDefault: body.isDefault ?? false,
      }});
      return reply.status(201).send({ success: true, data: { id: s.id } });
    }
  );

  app.put("/admin/hr/shifts/:id", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const body = req.body as any;
      // FIX: prisma.hrShift
      if (body.isDefault) await prisma.hrShift.updateMany({ where: { schoolId }, data: { isDefault: false } });
      await prisma.hrShift.updateMany({ where: { id: parseInt(id), schoolId }, data: body });
      return reply.send({ success: true });
    }
  );

  app.delete("/admin/hr/shifts/:id", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      // FIX: prisma.hrShift
      await prisma.hrShift.updateMany({ where: { id: parseInt(id), schoolId }, data: { isActive: false } });
      return reply.send({ success: true });
    }
  );

  // ─── SHIFT ASSIGNMENT ──────────────────────────────────────
  app.post("/admin/hr/shifts/assign", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { shiftId, staffIds, departmentId, fromDate, toDate } = req.body as { shiftId: number; staffIds?: number[]; departmentId?: number; fromDate: string; toDate?: string };
      if (!shiftId || !fromDate) return reply.status(400).send({ success: false, message: "shiftId and fromDate required." });

      let targets: number[] = staffIds ?? [];
      if (departmentId && !staffIds?.length) {
        const staff = await prisma.staff.findMany({ where: { schoolId, departmentId, status: { in: ["ACTIVE","PROBATION"] } }, select: { id: true } });
        targets = staff.map(s => s.id);
      }

      await prisma.shiftAssignment.updateMany({ where: { schoolId, staffId: { in: targets }, isActive: true }, data: { isActive: false } });

      for (const staffId of targets) {
        await prisma.shiftAssignment.create({ data: {
          schoolId, staffId, shiftId,
          fromDate: new Date(fromDate),
          toDate: toDate ? new Date(toDate) : null,
          assignedById: userId,
        }});
      }
      return reply.send({ success: true, message: `Shift assigned to ${targets.length} staff.` });
    }
  );

  // ─── CORRECTIONS ───────────────────────────────────────────
  app.get("/admin/hr/attendance/corrections", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { status?: string; page?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status) where.status = q.status;
      const [corrections, total] = await Promise.all([
        prisma.attendanceCorrection.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" },
          include: {
            staff: { include: { user: { select: { name: true, avatarUrl: true } }, departmentRef: { select: { name: true } } } },
            approvedBy: { select: { name: true } },
          }
        }),
        prisma.attendanceCorrection.count({ where }),
      ]);
      return reply.send({ success: true, data: { corrections, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  app.post("/admin/hr/attendance/corrections", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { staffId, date, reason, requestedStatus, requestedInTime, requestedOutTime } = req.body as { staffId: number; date: string; reason: string; requestedStatus?: string; requestedInTime?: string; requestedOutTime?: string };
      if (!staffId || !date || !reason) return reply.status(400).send({ success: false, message: "staffId, date, reason required." });
      const c = await prisma.attendanceCorrection.create({ data: { schoolId, staffId, date: new Date(date), reason, requestedStatus: requestedStatus as any ?? null, requestedInTime: requestedInTime ?? null, requestedOutTime: requestedOutTime ?? null } });
      return reply.status(201).send({ success: true, data: { id: c.id } });
    }
  );

  app.patch("/admin/hr/attendance/corrections/:id/approve", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any; const { id } = req.params as { id: string };
      const { status, remarks } = req.body as { status: "APPROVED" | "REJECTED"; remarks?: string };
      const correction = await prisma.attendanceCorrection.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!correction) return reply.status(404).send({ success: false, message: "Not found." });
      await prisma.$transaction(async tx => {
        await tx.attendanceCorrection.updateMany({ where: { id: parseInt(id) }, data: { status, approvedById: userId, approvedAt: new Date(), remarks: remarks ?? null } });
        if (status === "APPROVED") {
          const dateOnly = new Date(correction.date.getFullYear(), correction.date.getMonth(), correction.date.getDate());
          await tx.staffAttendance.upsert({
            where: { staffId_date: { staffId: correction.staffId, date: dateOnly } },
            update: { status: correction.requestedStatus ?? "PRESENT" as any, inTime: correction.requestedInTime ?? null, outTime: correction.requestedOutTime ?? null },
            create: { schoolId, staffId: correction.staffId, date: dateOnly, status: correction.requestedStatus ?? "PRESENT" as any, inTime: correction.requestedInTime ?? null, outTime: correction.requestedOutTime ?? null, markedById: userId },
          });
        }
      });
      return reply.send({ success: true, message: `Correction ${status.toLowerCase()}.` });
    }
  );

  // ─── LOGS ──────────────────────────────────────────────────
  app.get("/admin/hr/attendance/logs", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { staffId?: string; from?: string; to?: string; page?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 30;
      const where: any = { schoolId };
      if (q.staffId) where.staffId = parseInt(q.staffId);
      if (q.from || q.to) { where.punchTime = {}; if (q.from) where.punchTime.gte = new Date(q.from); if (q.to) where.punchTime.lte = new Date(q.to); }
      const [logs, total] = await Promise.all([
        prisma.attendanceLog.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { punchTime: "desc" } }),
        prisma.attendanceLog.count({ where }),
      ]);
      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ─── MONTHLY REPORT ────────────────────────────────────────
  app.get("/admin/hr/attendance/reports/monthly", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { year?: string; month?: string; departmentId?: string };
      const year  = parseInt(q.year  ?? String(new Date().getFullYear()));
      const month = parseInt(q.month ?? String(new Date().getMonth() + 1));
      const monthStart = new Date(year, month - 1, 1);
      const monthEnd   = new Date(year, month, 0);

      const staffWhere: any = { schoolId, status: { in: ["ACTIVE","PROBATION"] } };
      if (q.departmentId) staffWhere.departmentId = parseInt(q.departmentId);

      const staff = await prisma.staff.findMany({ where: staffWhere,
        include: {
          user:        { select: { name: true } },
          departmentRef:  { select: { name: true } },
          attendances: { where: { date: { gte: monthStart, lte: monthEnd } } },
        }
      });

      const report = staff.map(s => {
        const atts = s.attendances;
        const present  = atts.filter(a => a.status === "PRESENT" || a.status === "LATE").length;
        const absent   = atts.filter(a => a.status === "ABSENT").length;
        const late     = atts.filter(a => a.status === "LATE").length;
        const halfDay  = atts.filter(a => a.status === "HALF_DAY").length;
        const leave    = atts.filter(a => a.status === "LEAVE").length;
        const workingDays = atts.length;
        return {
          staffId: s.id, employeeId: s.employeeId, name: s.user.name, department: s.departmentRef?.name,
          present, absent, late, halfDay, leave, workingDays,
          attendancePercent: workingDays > 0 ? ((present / workingDays) * 100).toFixed(1) : "0",
        };
      });

      return reply.send({ success: true, data: { report, month, year, generatedAt: new Date().toISOString() } });
    }
  );
}
