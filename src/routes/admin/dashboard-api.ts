// apps/api/src/routes/admin/dashboard-api.ts
// Master Dashboard — aggregates real data from across modules.
// Rebuilt to use the ACTUAL Prisma models (the previous version queried
// non-existent models — hrLeaveRequest, feePayment, commNoticeboard —
// which silently failed via .catch() fallbacks and always returned 0.

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log("[admin/dashboard] query failed:", err?.message ?? err); return fallback; }
}

export async function adminDashboardRoutes(app: FastifyInstance) {
  const P = "/admin/dashboard";

  // ─── MAIN DASHBOARD DATA ─────────────────────────────────
  app.get(P, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const todayEnd = new Date(today.getTime() + 86400000);
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const [
        totalStudents, totalStaff, studentsPresentToday,
        collectedTodayAgg, dueAgg,
        pendingLeaves, staffOnLeaveToday,
        boysHostel, girlsHostel,
        totalVehicles, activeRoutes,
        newAdmissionsToday, newStaffThisMonth,
      ] = await Promise.all([
        safe(() => prisma.student.count({ where: { schoolId, isActive: true } }), 0),
        safe(() => prisma.staff.count({ where: { schoolId, isActive: true } }), 0),
        safe(() => prisma.attendance.count({ where: { schoolId, date: today, status: "PRESENT" } }), 0),

        safe(() => prisma.feeReceipt.aggregate({
          where: { schoolId, isVoid: false, createdAt: { gte: today, lt: todayEnd } }, _sum: { amount: true },
        }), { _sum: { amount: null } } as any),

        safe(() => prisma.studentFeeInstallment.aggregate({
          where: { schoolId, status: { in: ["PENDING", "PARTIAL", "OVERDUE"] } },
          _sum: { dueAmount: true, paidAmount: true, fineAmount: true, discountAmount: true },
        }), { _sum: { dueAmount: null, paidAmount: null, fineAmount: null, discountAmount: null } } as any),

        safe(() => prisma.hrLeaveApplication.count({ where: { schoolId, status: "PENDING" } }), 0),
        safe(() => prisma.hrLeaveApplication.count({
          where: { schoolId, status: "APPROVED", fromDate: { lte: today }, toDate: { gte: today } },
        }), 0),

        safe(() => prisma.hostel.findMany({ where: { schoolId, isActive: true, hostelType: "BOYS" }, select: { totalBeds: true, occupiedBeds: true } }), []),
        safe(() => prisma.hostel.findMany({ where: { schoolId, isActive: true, hostelType: "GIRLS" }, select: { totalBeds: true, occupiedBeds: true } }), []),

        safe(() => prisma.transportVehicle.count({ where: { schoolId, isActive: true, status: "ACTIVE" } }), 0),
        safe(() => prisma.transportRoute.count({ where: { schoolId, isActive: true, status: "ACTIVE" } }), 0),

        safe(() => prisma.student.count({ where: { schoolId, admissionDate: { gte: today, lt: todayEnd } } }), 0),
        safe(() => prisma.staff.count({ where: { schoolId, createdAt: { gte: monthStart } } }), 0),
      ]);

      const hostelTotalBeds = [...boysHostel, ...girlsHostel].reduce((s, h) => s + h.totalBeds, 0);
      const hostelOccupiedBeds = [...boysHostel, ...girlsHostel].reduce((s, h) => s + h.occupiedBeds, 0);
      const hostelCapacityPct = hostelTotalBeds > 0 ? Math.round((hostelOccupiedBeds / hostelTotalBeds) * 100) : 0;
      const attendancePct = totalStudents > 0 ? Math.round((studentsPresentToday / totalStudents) * 100) : 0;
      const collectedToday = Number(collectedTodayAgg._sum.amount ?? 0);
      const totalFeesDue = Math.max(0, Number(dueAgg._sum.dueAmount ?? 0) + Number(dueAgg._sum.fineAmount ?? 0) - Number(dueAgg._sum.discountAmount ?? 0) - Number(dueAgg._sum.paidAmount ?? 0));

      // ── WEEKLY ATTENDANCE TREND (last 7 days) ─────────────
      const weeklyAttendance: { date: string; present: number; total: number; pct: number }[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 86400000);
        const dEnd = new Date(d.getTime() + 86400000);
        const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
        const [present, total] = await Promise.all([
          safe(() => prisma.attendance.count({ where: { schoolId, date: { gte: d, lt: dEnd }, status: "PRESENT" } }), 0),
          safe(() => prisma.attendance.count({ where: { schoolId, date: { gte: d, lt: dEnd } } }), 0),
        ]);
        weeklyAttendance.push({ date: dayName, present, total, pct: total > 0 ? Math.round((present / total) * 100) : 0 });
      }

      // ── FINANCIAL TREND (6 months, collections only — "outstanding"
      // as a historical monthly figure doesn't really make sense since
      // dues are a running balance, not month-scoped, so this now just
      // tracks how much was actually collected each month) ───────────
      const financialTrend: { month: string; collected: number }[] = [];
      for (let i = 5; i >= 0; i--) {
        const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
        const collected = await safe(() => prisma.feeReceipt.aggregate({
          where: { schoolId, isVoid: false, createdAt: { gte: from, lte: to } }, _sum: { amount: true },
        }), { _sum: { amount: null } } as any);
        financialTrend.push({ month: from.toLocaleString("default", { month: "short", year: "2-digit" }), collected: Number(collected._sum.amount ?? 0) });
      }

      // ── STUDENT BREAKDOWN ─────────────────────────────────
      const [byClassRaw, byGender, newThisMonth] = await Promise.all([
        safe(() => prisma.student.groupBy({ by: ["classId"], where: { schoolId, isActive: true }, _count: { id: true }, orderBy: { _count: { id: "desc" } }, take: 8 }), []),
        safe(() => prisma.user.groupBy({ by: ["gender"], where: { schoolId, role: "STUDENT", isActive: true }, _count: { id: true } }), []),
        safe(() => prisma.student.count({ where: { schoolId, admissionDate: { gte: monthStart } } }), 0),
      ]);
      const classIds = byClassRaw.map((c: any) => c.classId).filter(Boolean) as number[];
      const classes = await safe(() => prisma.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } }), []);
      const classMap = Object.fromEntries(classes.map((c: any) => [c.id, c.name]));

      // ── STAFF BREAKDOWN ───────────────────────────────────
      const staffByRole = await safe(() => prisma.user.groupBy({
        by: ["role"], where: { schoolId, staffMember: { isActive: true } }, _count: { id: true }, orderBy: { _count: { id: "desc" } }, take: 6,
      }), []);

      // ── OFFICIAL NOTICES (recent, published) ──────────────
      const notices = await safe(() => prisma.commNotice.findMany({
        where: { schoolId, status: "PUBLISHED" },
        orderBy: { publishAt: "desc" }, take: 5,
        select: { id: true, title: true, category: true, priority: true, publishAt: true, expiresAt: true, audienceType: true },
      }), []);

      // ── UPCOMING EXAMS (next 30 days) ─────────────────────
      // ExamSchedule is just the session wrapper (title, date-RANGE) — the
      // actual per-subject exam entries with a real date live on ExamSlot.
      const upcomingExams = await safe(() => prisma.examSlot.findMany({
        where: { schoolId, examDate: { gte: today, lt: new Date(today.getTime() + 30 * 86400000) } },
        include: { schedule: { select: { title: true } }, subject: { select: { name: true } } },
        orderBy: { examDate: "asc" }, take: 5,
      }), []);

      // ── ADMISSIONS FUNNEL (this academic year) ────────────
      const yearStart = new Date(now.getFullYear(), 0, 1);
      const [registrationsMonth, admissionsYear] = await Promise.all([
        safe(() => prisma.student.count({ where: { schoolId, isActive: true, admissionDate: { gte: monthStart } } }), 0),
        safe(() => prisma.student.count({ where: { schoolId, isActive: true, admissionDate: { gte: yearStart } } }), 0),
      ]);

      // ── INVENTORY ALERTS ──────────────────────────────────
      const lowStockItems = await safe(async () => {
        const stocks = await prisma.invStock.findMany({ where: { schoolId }, include: { item: { select: { isActive: true, minimumLevel: true } } } });
        return stocks.filter((s) => s.item.isActive && s.item.minimumLevel > 0 && s.quantity <= s.item.minimumLevel).length;
      }, 0);

      // ── LIVE ACTIVITY STREAM ──────────────────────────────
      const liveStream = await safe(() => prisma.auditLog.findMany({
        where: { schoolId }, include: { user: { select: { name: true, avatarUrl: true } } },
        orderBy: { occurredAt: "desc" }, take: 10,
      }), []);

      return rep.send({
        kpis: {
          totalStudents, totalStaff, attendancePct, attendancePresent: studentsPresentToday,
          collectedToday, totalFeesDue,
          pendingLeaves, staffOnLeaveToday,
          hostelCapacityPct, hostelOccupied: hostelOccupiedBeds, hostelTotal: hostelTotalBeds,
          totalVehicles, activeRoutes,
          newAdmissionsToday, newStaffThisMonth,
          lowStockItems,
        },

        weeklyAttendance,
        financialTrend,

        students: {
          total: totalStudents,
          byClass: byClassRaw.map((c: any) => ({ classId: c.classId, name: classMap[c.classId] ?? "Unknown", count: c._count.id })),
          byGender,
          newThisMonth,
        },

        hr: { total: totalStaff, byRole: staffByRole, pendingLeaves, staffOnLeaveToday },

        notices,
        upcomingExams,
        admissions: { registrationsMonth, admissionsYear },
        liveStream,

        timestamp: now.toISOString(),
      });
    }
  );

  // ── QUICK STATS ENDPOINT (lightweight refresh) ────────────
  app.get(`${P}/quick-stats`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const today = new Date(new Date().toDateString());
      const todayEnd = new Date(today.getTime() + 86400000);
      const [students, staff, present, collected] = await Promise.all([
        safe(() => prisma.student.count({ where: { schoolId, isActive: true } }), 0),
        safe(() => prisma.staff.count({ where: { schoolId, isActive: true } }), 0),
        safe(() => prisma.attendance.count({ where: { schoolId, date: today, status: "PRESENT" } }), 0),
        safe(() => prisma.feeReceipt.aggregate({ where: { schoolId, isVoid: false, createdAt: { gte: today, lt: todayEnd } }, _sum: { amount: true } }), { _sum: { amount: null } } as any),
      ]);
      return rep.send({
        students, staff, present,
        attendancePct: students > 0 ? Math.round((present / students) * 100) : 0,
        collectedToday: Number(collected._sum.amount ?? 0),
      });
    }
  );
}
