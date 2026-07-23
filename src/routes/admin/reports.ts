import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";

export async function adminReportRoutes(app: FastifyInstance) {

  // ── GET /admin/reports/overview ───────────────────────────
  app.get("/admin/reports/overview",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const today = new Date();
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);

      const [
        totalStudents, totalStaff, totalClasses,
        activeStudents, activeStaff,
        todayPresent, todayAbsent, todayTotal,
        monthFeeCollection, totalPendingFees,
        pendingLeaves, newStudentsThisMonth,
        announcements,
      ] = await Promise.all([
        prisma.student.count({ where: { schoolId } }),
        prisma.staff.count({ where: { schoolId } }),
        prisma.class.count({ where: { schoolId, isActive: true } }),
        prisma.student.count({ where: { schoolId, isActive: true } }),
        prisma.staff.count({ where: { schoolId, isActive: true } }),

        // Today attendance
        prisma.attendance.count({ where: { schoolId, date: { gte: new Date(today.setHours(0,0,0,0)), lte: new Date(today.setHours(23,59,59,999)) }, status: "PRESENT" } }),
        prisma.attendance.count({ where: { schoolId, date: { gte: new Date(new Date().setHours(0,0,0,0)), lte: new Date(new Date().setHours(23,59,59,999)) }, status: "ABSENT" } }),
        prisma.attendance.count({ where: { schoolId, date: { gte: new Date(new Date().setHours(0,0,0,0)), lte: new Date(new Date().setHours(23,59,59,999)) } } }),

        // Fee collection this month
        prisma.payment.aggregate({
          where: { invoice: { schoolId }, paidAt: { gte: monthStart } },
          _sum: { amount: true },
        }),

        // Pending fees
        prisma.invoice.aggregate({
          where: { schoolId, status: { in: ["PENDING", "OVERDUE", "PARTIAL"] } },
          _sum: { dueAmount: true },
        }),

        prisma.leaveRequest.count({ where: { schoolId, status: "PENDING" } }),

        prisma.student.count({
          where: { schoolId, admissionDate: { gte: monthStart } },
        }),

        prisma.announcement.count({ where: { schoolId, status: "PUBLISHED" } }),
      ]);

      // Last 6 months fee trend
      const feeMonths = [];
      for (let i = 5; i >= 0; i--) {
        const mStart = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const mEnd = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
        const collected = await prisma.payment.aggregate({
          where: { invoice: { schoolId }, paidAt: { gte: mStart, lte: mEnd } },
          _sum: { amount: true },
        });
        const pending = await prisma.invoice.aggregate({
          where: { schoolId, status: { in: ["PENDING","OVERDUE","PARTIAL"] }, dueDate: { gte: mStart, lte: mEnd } },
          _sum: { dueAmount: true },
        });
        feeMonths.push({
          month: mStart.toLocaleString("en-IN", { month: "short", year: "2-digit" }),
          collected: Number(collected._sum.amount ?? 0),
          pending: Number(pending._sum.dueAmount ?? 0),
        });
      }

      // Last 7 days attendance trend
      const attTrend = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dayStart = new Date(d); dayStart.setHours(0,0,0,0);
        const dayEnd = new Date(d); dayEnd.setHours(23,59,59,999);
        const [present, absent, late] = await Promise.all([
          prisma.attendance.count({ where: { schoolId, date: { gte: dayStart, lte: dayEnd }, status: "PRESENT" } }),
          prisma.attendance.count({ where: { schoolId, date: { gte: dayStart, lte: dayEnd }, status: "ABSENT" } }),
          prisma.attendance.count({ where: { schoolId, date: { gte: dayStart, lte: dayEnd }, status: "LATE" } }),
        ]);
        attTrend.push({
          date: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
          present, absent, late,
        });
      }

      return reply.send({
        success: true,
        data: {
          overview: {
            totalStudents, activeStudents, totalStaff, activeStaff,
            totalClasses, announcements, pendingLeaves, newStudentsThisMonth,
          },
          today: {
            present: todayPresent, absent: todayAbsent, total: todayTotal,
            rate: todayTotal > 0 ? Math.round((todayPresent / todayTotal) * 100) : 0,
          },
          fees: {
            collectedThisMonth: Number(monthFeeCollection._sum.amount ?? 0),
            totalPending: Number(totalPendingFees._sum.dueAmount ?? 0),
          },
          feeMonths,
          attTrend,
        },
      });
    }
  );

  // ── GET /admin/reports/attendance ─────────────────────────
  app.get("/admin/reports/attendance",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { from?: string; to?: string; classId?: string };

      const from = q.from ? new Date(q.from) : new Date(new Date().setDate(1));
      const to = q.to ? new Date(q.to) : new Date();
      to.setHours(23,59,59,999);

      const where: any = { schoolId, date: { gte: from, lte: to } };
      if (q.classId) where.classId = parseInt(q.classId);

      const [total, present, absent, late, halfDay] = await Promise.all([
        prisma.attendance.count({ where }),
        prisma.attendance.count({ where: { ...where, status: "PRESENT" } }),
        prisma.attendance.count({ where: { ...where, status: "ABSENT" } }),
        prisma.attendance.count({ where: { ...where, status: "LATE" } }),
        prisma.attendance.count({ where: { ...where, status: "HALF_DAY" } }),
      ]);

      // Class-wise attendance
      const classes = await prisma.class.findMany({
        where: { schoolId, isActive: true },
        select: { id: true, name: true },
        orderBy: [{ classNumber: "asc" }, { section: "asc" }],
      });

      const classWise = await Promise.all(classes.map(async cls => {
        const [t, p, a] = await Promise.all([
          prisma.attendance.count({ where: { ...where, classId: cls.id } }),
          prisma.attendance.count({ where: { ...where, classId: cls.id, status: "PRESENT" } }),
          prisma.attendance.count({ where: { ...where, classId: cls.id, status: "ABSENT" } }),
        ]);
        return { class: cls.name, total: t, present: p, absent: a, rate: t > 0 ? Math.round((p/t)*100) : 0 };
      }));

      // Daily trend
      const dailyTrend = [];
      const days = Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
      const limit = Math.min(days, 30);
      for (let i = limit - 1; i >= 0; i--) {
        const d = new Date(to);
        d.setDate(d.getDate() - i);
        const dayStart = new Date(d); dayStart.setHours(0,0,0,0);
        const dayEnd = new Date(d); dayEnd.setHours(23,59,59,999);
        const [dp, da] = await Promise.all([
          prisma.attendance.count({ where: { schoolId, date: { gte: dayStart, lte: dayEnd }, status: "PRESENT", ...(q.classId && { classId: parseInt(q.classId) }) } }),
          prisma.attendance.count({ where: { schoolId, date: { gte: dayStart, lte: dayEnd }, status: "ABSENT", ...(q.classId && { classId: parseInt(q.classId) }) } }),
        ]);
        if (dp + da > 0) {
          dailyTrend.push({ date: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }), present: dp, absent: da });
        }
      }

      // Frequent absentees (top 10)
      const absentees = await prisma.attendance.groupBy({
        by: ["studentId"],
        where: { ...where, status: "ABSENT" },
        _count: { status: true },
        orderBy: { _count: { status: "desc" } },
        take: 10,
      });

      const absenteeDetails = await Promise.all(absentees.map(async a => {
        const student = await prisma.student.findFirst({
          where: { id: a.studentId },
          include: { user: { select: { name: true } }, class: { select: { name: true } } },
        });
        return {
          name: student?.user.name ?? "Unknown",
          class: student?.class?.name ?? "—",
          absences: a._count.status,
        };
      }));

      return reply.send({
        success: true,
        data: {
          summary: { total, present, absent, late, halfDay, rate: total > 0 ? Math.round((present/total)*100) : 0 },
          classWise, dailyTrend,
          absentees: absenteeDetails,
        },
      });
    }
  );

  // ── GET /admin/reports/fees ───────────────────────────────
  app.get("/admin/reports/fees",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { academicYearId?: string };

      const [
        totalInvoiced, totalCollected, totalPending, totalOverdue,
        paidCount, pendingCount, overdueCount, partialCount,
      ] = await Promise.all([
        prisma.invoice.aggregate({ where: { schoolId }, _sum: { totalAmount: true } }),
        prisma.invoice.aggregate({ where: { schoolId }, _sum: { paidAmount: true } }),
        prisma.invoice.aggregate({ where: { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] } }, _sum: { dueAmount: true } }),
        prisma.invoice.aggregate({ where: { schoolId, status: "OVERDUE" }, _sum: { dueAmount: true } }),
        prisma.invoice.count({ where: { schoolId, status: "PAID" } }),
        prisma.invoice.count({ where: { schoolId, status: "PENDING" } }),
        prisma.invoice.count({ where: { schoolId, status: "OVERDUE" } }),
        prisma.invoice.count({ where: { schoolId, status: "PARTIAL" } }),
      ]);

      // Monthly collection (last 6 months)
      const today = new Date();
      const monthlyCollection = [];
      for (let i = 5; i >= 0; i--) {
        const mStart = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const mEnd = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
        const res = await prisma.payment.aggregate({
          where: { invoice: { schoolId }, paidAt: { gte: mStart, lte: mEnd } },
          _sum: { amount: true },
          _count: true,
        });
        monthlyCollection.push({
          month: mStart.toLocaleString("en-IN", { month: "short", year: "2-digit" }),
          collected: Number(res._sum.amount ?? 0),
          transactions: res._count,
        });
      }

      // Category breakdown
      const categoryBreakdown = await prisma.invoiceItem.groupBy({
        by: ["category"],
        where: { invoice: { schoolId } },
        _sum: { amount: true },
        _count: true,
      });

      // Payment method breakdown
      const methodBreakdown = await prisma.payment.groupBy({
        by: ["method"],
        where: { invoice: { schoolId } },
        _sum: { amount: true },
        _count: true,
      });

      // Top defaulters (overdue invoices)
      const defaulters = await prisma.invoice.findMany({
        where: { schoolId, status: { in: ["OVERDUE", "PARTIAL"] } },
        orderBy: { dueAmount: "desc" },
        take: 10,
        include: {
          student: {
            include: {
              user: { select: { name: true, phone: true } },
              class: { select: { name: true } },
            },
          },
        },
      });

      return reply.send({
        success: true,
        data: {
          summary: {
            totalInvoiced: Number(totalInvoiced._sum.totalAmount ?? 0),
            totalCollected: Number(totalCollected._sum.paidAmount ?? 0),
            totalPending: Number(totalPending._sum.dueAmount ?? 0),
            totalOverdue: Number(totalOverdue._sum.dueAmount ?? 0),
            collectionRate: Number(totalInvoiced._sum.totalAmount) > 0
              ? Math.round((Number(totalCollected._sum.paidAmount) / Number(totalInvoiced._sum.totalAmount)) * 100)
              : 0,
            counts: { paid: paidCount, pending: pendingCount, overdue: overdueCount, partial: partialCount },
          },
          monthlyCollection,
          categoryBreakdown: categoryBreakdown.map(c => ({
            category: c.category, amount: Number(c._sum.amount ?? 0), count: c._count,
          })),
          methodBreakdown: methodBreakdown.map(m => ({
            method: m.method, amount: Number(m._sum.amount ?? 0), count: m._count,
          })),
          defaulters: defaulters.map(d => ({
            name: d.student.user.name,
            phone: d.student.user.phone,
            class: d.student.class?.name ?? "—",
            invoiceNumber: d.invoiceNumber,
            dueAmount: Number(d.dueAmount),
            status: d.status,
            dueDate: d.dueDate,
          })),
        },
      });
    }
  );

  // ── GET /admin/reports/leaves ─────────────────────────────
  app.get("/admin/reports/leaves",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const today = new Date();
      const yearStart = new Date(today.getFullYear(), 0, 1);

      const [
        totalStaff, totalStudent, pendingStaff, pendingStudent,
        approvedStaff, approvedStudent, rejectedStaff, rejectedStudent,
      ] = await Promise.all([
        prisma.leaveRequest.count({ where: { schoolId, applicantType: "STAFF" } }),
        prisma.leaveRequest.count({ where: { schoolId, applicantType: "STUDENT" } }),
        prisma.leaveRequest.count({ where: { schoolId, applicantType: "STAFF", status: "PENDING" } }),
        prisma.leaveRequest.count({ where: { schoolId, applicantType: "STUDENT", status: "PENDING" } }),
        prisma.leaveRequest.count({ where: { schoolId, applicantType: "STAFF", status: "APPROVED" } }),
        prisma.leaveRequest.count({ where: { schoolId, applicantType: "STUDENT", status: "APPROVED" } }),
        prisma.leaveRequest.count({ where: { schoolId, applicantType: "STAFF", status: "REJECTED" } }),
        prisma.leaveRequest.count({ where: { schoolId, applicantType: "STUDENT", status: "REJECTED" } }),
      ]);

      // Leave type breakdown
      const leaveTypeBreakdown = await prisma.leaveRequest.groupBy({
        by: ["leaveType"],
        where: { schoolId },
        _count: true,
        _sum: { totalDays: true },
      });

      // Monthly trend (last 6 months)
      const monthlyTrend = [];
      for (let i = 5; i >= 0; i--) {
        const mStart = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const mEnd = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
        const [approved, rejected, pending] = await Promise.all([
          prisma.leaveRequest.count({ where: { schoolId, status: "APPROVED", createdAt: { gte: mStart, lte: mEnd } } }),
          prisma.leaveRequest.count({ where: { schoolId, status: "REJECTED", createdAt: { gte: mStart, lte: mEnd } } }),
          prisma.leaveRequest.count({ where: { schoolId, status: "PENDING", createdAt: { gte: mStart, lte: mEnd } } }),
        ]);
        monthlyTrend.push({
          month: mStart.toLocaleString("en-IN", { month: "short", year: "2-digit" }),
          approved, rejected, pending,
        });
      }

      // Top leave takers (staff)
      const topLeaves = await prisma.leaveRequest.groupBy({
        by: ["staffId"],
        where: { schoolId, applicantType: "STAFF", status: "APPROVED" },
        _count: true,
        _sum: { totalDays: true },
        orderBy: { _sum: { totalDays: "desc" } },
        take: 5,
      });

      const topLeaveDetails = await Promise.all(topLeaves.filter(l => l.staffId).map(async l => {
        const staff = await prisma.staff.findFirst({
          where: { id: l.staffId! },
          include: { user: { select: { name: true } } },
        });
        return {
          name: staff?.user.name ?? "Unknown",
          designation: staff?.designation ?? "—",
          requests: l._count,
          days: l._sum.totalDays ?? 0,
        };
      }));

      // Leave balances summary
      const balances = await prisma.leaveBalance.findMany({
        where: { schoolId, year: today.getFullYear() },
        include: { staff: { include: { user: { select: { name: true } } } } },
        take: 10,
      });

      return reply.send({
        success: true,
        data: {
          summary: {
            staff: { total: totalStaff, pending: pendingStaff, approved: approvedStaff, rejected: rejectedStaff },
            student: { total: totalStudent, pending: pendingStudent, approved: approvedStudent, rejected: rejectedStudent },
          },
          leaveTypeBreakdown: leaveTypeBreakdown.map(l => ({
            type: l.leaveType, count: l._count, days: l._sum.totalDays ?? 0,
          })),
          monthlyTrend,
          topLeaveDetails,
          balances: balances.map(b => ({
            name: b.staff.user.name,
            sick: { total: b.sickTotal, used: b.sickUsed, remaining: b.sickTotal - b.sickUsed },
            casual: { total: b.casualTotal, used: b.casualUsed, remaining: b.casualTotal - b.casualUsed },
            earned: { total: b.earnedTotal, used: b.earnedUsed, remaining: b.earnedTotal - b.earnedUsed },
          })),
        },
      });
    }
  );

  // ── GET /admin/reports/students ───────────────────────────
  app.get("/admin/reports/students",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const [
        totalStudents, activeStudents, totalStaff, activeStaff,
        maleStudents, femaleStudents, otherStudents,
        maleStaff, femaleStaff,
      ] = await Promise.all([
        prisma.student.count({ where: { schoolId } }),
        prisma.student.count({ where: { schoolId, isActive: true } }),
        prisma.staff.count({ where: { schoolId } }),
        prisma.staff.count({ where: { schoolId, isActive: true } }),
        prisma.student.count({ where: { schoolId, user: { gender: "MALE" } } }),
        prisma.student.count({ where: { schoolId, user: { gender: "FEMALE" } } }),
        prisma.student.count({ where: { schoolId, user: { gender: "OTHER" } } }),
        prisma.staff.count({ where: { schoolId, user: { gender: "MALE" } } }),
        prisma.staff.count({ where: { schoolId, user: { gender: "FEMALE" } } }),
      ]);

      // Class-wise student count
      const classes = await prisma.class.findMany({
        where: { schoolId, isActive: true },
        select: { id: true, name: true, capacity: true, classNumber: true },
        orderBy: [{ classNumber: "asc" }, { section: "asc" }],
      });

      const classWise = await Promise.all(classes.map(async cls => {
        const [total, male, female] = await Promise.all([
          prisma.student.count({ where: { schoolId, classId: cls.id, isActive: true } }),
          prisma.student.count({ where: { schoolId, classId: cls.id, isActive: true, user: { gender: "MALE" } } }),
          prisma.student.count({ where: { schoolId, classId: cls.id, isActive: true, user: { gender: "FEMALE" } } }),
        ]);
        return { class: cls.name, capacity: cls.capacity, total, male, female, fillRate: Math.round((total / cls.capacity) * 100) };
      }));

      // Department-wise staff
      const deptBreakdown = await prisma.staff.groupBy({
        by: ["department"],
        where: { schoolId },
        _count: true,
      });

      // Employment type breakdown
      const empTypeBreakdown = await prisma.staff.groupBy({
        by: ["employmentType"],
        where: { schoolId },
        _count: true,
      });

      // Monthly new admissions (last 6 months)
      const today = new Date();
      const admissionTrend = [];
      for (let i = 5; i >= 0; i--) {
        const mStart = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const mEnd = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
        const count = await prisma.student.count({
          where: { schoolId, admissionDate: { gte: mStart, lte: mEnd } },
        });
        admissionTrend.push({
          month: mStart.toLocaleString("en-IN", { month: "short", year: "2-digit" }),
          admissions: count,
        });
      }

      return reply.send({
        success: true,
        data: {
          students: {
            total: totalStudents, active: activeStudents,
            male: maleStudents, female: femaleStudents, other: otherStudents,
          },
          staff: {
            total: totalStaff, active: activeStaff,
            male: maleStaff, female: femaleStaff,
          },
          classWise,
          deptBreakdown: deptBreakdown.map(d => ({ dept: d.department, count: d._count })),
          empTypeBreakdown: empTypeBreakdown.map(e => ({ type: e.employmentType, count: e._count })),
          admissionTrend,
        },
      });
    }
  );
}