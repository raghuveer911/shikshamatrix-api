// apps/api/src/routes/admin/hr/hr-dashboard-api.ts
// Pure TypeScript — no JSX, no React

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminHrDashboardRoutes(app: FastifyInstance) {

  // ─── MAIN DASHBOARD ────────────────────────────────────────
  app.get("/admin/hr/dashboard", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const today       = new Date();
      const todayDate   = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const monthStart  = new Date(today.getFullYear(), today.getMonth(), 1);
      const next30Days  = new Date(today.getTime() + 30 * 86400000);

      const [
        totalStaff,
        presentToday,
        absentToday,
        onLeave,
        newJoinings,
        pendingCorrections,
        expiringDocs,
        expiringContracts,
        byEmpType,
        leaveStats,
        lateToday,
        missingPunch,
        recentStaff,
        todayAttList,
      ] = await Promise.all([
        prisma.hrStaffProfile.count({
          where: { schoolId, status: { in: ["ACTIVE", "PROBATION"] } },
        }),
        prisma.staffAttendance.count({ where: { schoolId, date: todayDate, status: "PRESENT" } }),
        prisma.staffAttendance.count({ where: { schoolId, date: todayDate, status: "ABSENT" } }),
        prisma.staffAttendance.count({ where: { schoolId, date: todayDate, status: "LEAVE" } }),
        prisma.hrStaffProfile.count({ where: { schoolId, joinDate: { gte: monthStart } } }),
        prisma.attendanceCorrection.count({ where: { schoolId, status: "PENDING" } }),
        prisma.staffDocument.count({ where: { schoolId, expiryDate: { gte: today, lte: next30Days } } }),
        prisma.hrStaffProfile.count({ where: { schoolId, contractEnd: { gte: today, lte: next30Days } } }),
        prisma.hrStaffProfile.groupBy({
          by: ["employeeType"],
          where: { schoolId, status: { in: ["ACTIVE", "PROBATION"] } },
          _count: true,
        }),
        prisma.staffAttendance.groupBy({
          by: ["status"],
          where: { schoolId, date: todayDate },
          _count: true,
        }),
        prisma.staffAttendance.count({ where: { schoolId, date: todayDate, status: "LATE" } }),
        prisma.staffAttendance.count({ where: { schoolId, date: todayDate, status: "MISSING_PUNCH" } }),
        prisma.hrStaffProfile.findMany({
          where: { schoolId },
          orderBy: { createdAt: "desc" },
          take: 8,
          include: {
            user:        { select: { name: true, avatarUrl: true } },
            department:  { select: { name: true } },
            designation: { select: { name: true } },
          },
        }),
        prisma.staffAttendance.findMany({
          where: { schoolId, date: todayDate },
          take: 20,
          orderBy: { createdAt: "desc" },
          include: {
            staff: {
              include: {
                user:       { select: { name: true, avatarUrl: true } },
                department: { select: { name: true } },
              },
            },
          },
        }),
      ]);

      // Department-wise staff count
      const deptRaw = await prisma.hrStaffProfile.groupBy({
        by: ["departmentId"],
        where: { schoolId, status: { in: ["ACTIVE", "PROBATION"] } },
        _count: true,
      });
      const deptIds = deptRaw.map(r => r.departmentId).filter(Boolean) as number[];
      const depts   = await prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } });
      const byDept  = deptRaw.map(r => ({
        deptId: r.departmentId,
        count:  r._count,
        name:   depts.find(d => d.id === r.departmentId)?.name ?? "Unassigned",
      }));

      // Upcoming birthdays (next 30 days)
      const allBdays = await prisma.hrStaffProfile.findMany({
        where: { schoolId, dob: { not: null }, status: { in: ["ACTIVE", "PROBATION"] } },
        select: {
          id: true, employeeId: true, dob: true,
          user:       { select: { name: true, avatarUrl: true } },
          department: { select: { name: true } },
        },
        take: 200,
      });
      const now = new Date();
      const upcomingBirthdays = allBdays
        .map(s => {
          if (!s.dob) return null;
          const b = new Date(s.dob);
          const thisYear = new Date(now.getFullYear(), b.getMonth(), b.getDate());
          const diff = thisYear.getTime() - now.getTime();
          if (diff < 0 || diff > 30 * 86400000) return null;
          return { ...s, daysUntil: Math.ceil(diff / 86400000) };
        })
        .filter(Boolean)
        .slice(0, 5);

      return reply.send({
        success: true,
        data: {
          kpi: {
            totalStaff, presentToday, absentToday, onLeave,
            newJoinings, pendingApprovals: pendingCorrections,
            missingPunch, lateToday,
            halfDay:     leaveStats.find(b => b.status === "HALF_DAY")?._count ?? 0,
            presentRate: totalStaff > 0
              ? ((presentToday / totalStaff) * 100).toFixed(1)
              : "0",
          },
          byDept,
          byEmpType:   byEmpType.map(e => ({ type: e.employeeType, count: e._count })),
          leaveStats:  leaveStats.map(l => ({ status: l.status, count: l._count })),
          alerts:      { expiringDocs, expiringContracts },
          upcomingBirthdays,
          recentStaff: recentStaff.map(s => ({
            id:          s.id,
            employeeId:  s.employeeId,
            name:        s.user.name,
            avatar:      s.user.avatarUrl,
            dept:        s.department?.name,
            designation: s.designation?.name,
            status:      s.status,
            joinDate:    s.joinDate,
          })),
          todayAttList: todayAttList.map(a => ({
            staffId: a.staffId,
            name:    a.staff.user.name,
            avatar:  a.staff.user.avatarUrl,
            dept:    a.staff.department?.name,
            status:  a.status,
            inTime:  a.inTime,
            outTime: a.outTime,
          })),
        },
      });
    }
  );

  // ─── WORKFORCE TREND (12 months) ──────────────────────────
  app.get("/admin/hr/dashboard/trend", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const months = await Promise.all(
        Array.from({ length: 12 }, (_, i) => {
          const d1 = new Date();
          d1.setDate(1);
          d1.setMonth(d1.getMonth() - (11 - i));
          const d2 = new Date(d1);
          d2.setMonth(d2.getMonth() + 1);
          return prisma.hrStaffProfile
            .count({ where: { schoolId, joinDate: { lt: d2 } } })
            .then(count => ({
              month:    d1.toLocaleDateString("en-IN", { month: "short", year: "2-digit" }),
              strength: count,
            }));
        })
      );
      return reply.send({ success: true, data: { months } });
    }
  );

  // ─── ATTENDANCE HEATMAP (last 30 days) ────────────────────
  app.get("/admin/hr/dashboard/attendance-heatmap", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { departmentId } = req.query as { departmentId?: string };

      const dates = await Promise.all(
        Array.from({ length: 30 }, (_, i) => {
          const d     = new Date();
          d.setDate(d.getDate() - (29 - i));
          const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
          const dEnd   = new Date(dStart);
          dEnd.setDate(dEnd.getDate() + 1);

          const where: any = { schoolId, date: { gte: dStart, lt: dEnd } };
          if (departmentId) where.staff = { departmentId: parseInt(departmentId) };

          return Promise.all([
            prisma.staffAttendance.count({ where: { ...where, status: "PRESENT" } }),
            prisma.staffAttendance.count({ where }),
          ]).then(([present, total]) => ({
            date:    dStart.toISOString().split("T")[0],
            present,
            total,
            rate:    total > 0 ? ((present / total) * 100).toFixed(0) : "0",
          }));
        })
      );

      return reply.send({ success: true, data: { heatmap: dates } });
    }
  );
}