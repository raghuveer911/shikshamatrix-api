// apps/api/src/routes/admin/hr/hr-reports-analytics-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminHrReportsRoutes(app: FastifyInstance) {
  const P = "/admin/hr/reports";

  // ─────────────────────────────────────────────────────────
  // HR DASHBOARD SNAPSHOT
  // ─────────────────────────────────────────────────────────
  app.get(`${P}/hr-dashboard`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const today = new Date(); today.setHours(0, 0, 0, 0);

      const [
        totalStaff, presentToday, onLeave, vacancies,
        newJoinings, activeContracts,
      ] = await Promise.all([
        prisma.staff.count({ where: { schoolId, isActive: true } }),
        prisma.staffAttendance.count({ where: { schoolId, date: today, status: "PRESENT" } }),
        prisma.hrLeaveApplication.count({
          where: { schoolId, status: "APPROVED", fromDate: { lte: today }, toDate: { gte: today } },
        }),
        prisma.hrVacantPosition.count({ where: { schoolId, status: "OPEN" } }),
        prisma.staff.count({
          where: { schoolId, joinDate: { gte: new Date(today.getFullYear(), today.getMonth(), 1) } },
        }),
        prisma.hrStaffContract.count({ where: { schoolId, status: "ACTIVE" } }),
      ]);

      // Attrition = resigned/retired/terminated this year / total staff * 100
      const yearStart = new Date(today.getFullYear(), 0, 1);
      const attritionCount = await prisma.staff.count({
        where: { schoolId, isActive: false, updatedAt: { gte: yearStart } },
      });
      const attritionRate = totalStaff > 0 ? ((attritionCount / totalStaff) * 100).toFixed(1) : "0.0";

      return rep.send({
        totalStaff, presentToday, onLeave, vacancies,
        newJoinings, activeContracts, attritionRate,
        presentPercent: totalStaff > 0 ? Math.round((presentToday / totalStaff) * 100) : 0,
      });
    }
  );

  // ─────────────────────────────────────────────────────────
  // WORKFORCE ANALYTICS
  // ─────────────────────────────────────────────────────────
  app.get(`${P}/workforce`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      // Dept-wise count
      const deptDistribution = await prisma.staff.groupBy({
        by: ["departmentId"],
        where: { schoolId, isActive: true },
        _count: { id: true },
      });

      // Enrich with dept names
      const depts = await prisma.department.findMany({
        where: { schoolId },
        select: { id: true, name: true },
      });
      const deptMap = Object.fromEntries(depts.map(d => [d.id, d.name]));

      const deptData = deptDistribution.map(d => ({
        deptId: d.departmentId,
        deptName: d.departmentId ? deptMap[d.departmentId] ?? "Unknown" : "Not Assigned",
        count: d._count.id,
      }));

      // Gender distribution
      const genderData = await prisma.staff.groupBy({
        by: ["gender"],
        where: { schoolId, isActive: true },
        _count: { id: true },
      });

      // Employment type distribution
      const empTypeData = await prisma.staff.groupBy({
        by: ["employeeType"],
        where: { schoolId, isActive: true },
        _count: { id: true },
      });

      // Experience distribution
      const allStaff = await prisma.staff.findMany({
        where: { schoolId, isActive: true },
        select: { experienceYears: true },
      });
      const expBuckets = { "0-2": 0, "2-5": 0, "5-10": 0, "10+": 0 };
      allStaff.forEach(s => {
        const y = s.experienceYears;
        if (y < 2) expBuckets["0-2"]++;
        else if (y < 5) expBuckets["2-5"]++;
        else if (y < 10) expBuckets["5-10"]++;
        else expBuckets["10+"]++;
      });

      // Designation distribution
      const desigData = await prisma.staff.groupBy({
        by: ["designationId"],
        where: { schoolId, isActive: true },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
      });
      const desigs = await prisma.designation.findMany({
        where: { schoolId },
        select: { id: true, name: true },
      });
      const desigMap = Object.fromEntries(desigs.map(d => [d.id, d.name]));
      const desigDistribution = desigData.map(d => ({
        desigId: d.designationId,
        desigName: d.designationId ? desigMap[d.designationId] ?? "Unknown" : "Not Assigned",
        count: d._count.id,
      }));

      return rep.send({ deptData, genderData, empTypeData, expBuckets, desigDistribution });
    }
  );

  // ─────────────────────────────────────────────────────────
  // ATTENDANCE ANALYTICS
  // ─────────────────────────────────────────────────────────
  app.get(`${P}/attendance`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const month = q.month ? Number(q.month) : new Date().getMonth() + 1;
      const year  = q.year  ? Number(q.year)  : new Date().getFullYear();

      const from = new Date(year, month - 1, 1);
      const to   = new Date(year, month, 0);

      // Monthly summary
      const summary = await prisma.staffAttendance.groupBy({
        by: ["status"],
        where: { schoolId, date: { gte: from, lte: to } },
        _count: { id: true },
      });

      // Daily attendance trend for the month
      const dailyRaw = await prisma.staffAttendance.findMany({
        where: { schoolId, date: { gte: from, lte: to }, status: "PRESENT" },
        select: { date: true },
      });
      const dailyMap: Record<string, number> = {};
      dailyRaw.forEach(r => {
        const key = r.date.toISOString().split("T")[0];
        dailyMap[key] = (dailyMap[key] ?? 0) + 1;
      });

      // Dept-wise avg attendance %
      const deptAttendance = await prisma.staffAttendance.groupBy({
        by: ["status"],
        where: { schoolId, date: { gte: from, lte: to } },
        _count: { id: true },
      });

      // Top 5 attendance
      const topStaff = await prisma.staffAttendance.groupBy({
        by: ["staffId"],
        where: { schoolId, date: { gte: from, lte: to }, status: "PRESENT" },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 5,
      });
      const topStaffIds = topStaff.map(s => s.staffId);
      const topStaffDetails = await prisma.staff.findMany({
        where: { id: { in: topStaffIds } },
        include: { user: { select: { name: true } } },
      });

      // Late arrivals
      const lateCount = await prisma.staffAttendance.count({
        where: { schoolId, date: { gte: from, lte: to }, status: "LATE" },
      });

      return rep.send({ summary, dailyMap, deptAttendance, topStaff: topStaff.map(s => ({
        staffId: s.staffId,
        presentDays: s._count.id,
        name: topStaffDetails.find(d => d.id === s.staffId)?.user?.name,
      })), lateCount, month, year });
    }
  );

  // ─────────────────────────────────────────────────────────
  // LEAVE ANALYTICS
  // ─────────────────────────────────────────────────────────
  app.get(`${P}/leave`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const year = q.year ? Number(q.year) : new Date().getFullYear();
      const from = new Date(year, 3, 1); // April 1
      const to   = new Date(year + 1, 2, 31); // March 31

      // Leave type usage
      const leaveTypeUsage = await prisma.hrLeaveApplication.groupBy({
        by: ["leaveTypeId"],
        where: { schoolId, appliedAt: { gte: from, lte: to }, status: "APPROVED" },
        _count: { id: true },
        _sum: { totalDays: true },
      });

      // Enrich with leave type names
      const leaveTypes = await prisma.hrLeaveType.findMany({
        where: { schoolId },
        select: { id: true, name: true, code: true, color: true },
      });
      const ltMap = Object.fromEntries(leaveTypes.map(l => [l.id, l]));

      const leaveTypeData = leaveTypeUsage.map(l => ({
        leaveTypeId: l.leaveTypeId,
        name: ltMap[l.leaveTypeId]?.name ?? "Unknown",
        code: ltMap[l.leaveTypeId]?.code ?? "?",
        color: ltMap[l.leaveTypeId]?.color ?? "#6366f1",
        applications: l._count.id,
        totalDays: l._sum.totalDays ?? 0,
      }));

      // Status breakdown
      const statusBreakdown = await prisma.hrLeaveApplication.groupBy({
        by: ["status"],
        where: { schoolId, appliedAt: { gte: from, lte: to } },
        _count: { id: true },
      });

      // Monthly trend
      const monthlyTrend: { month: number; count: number }[] = [];
      for (let m = 0; m < 12; m++) {
        const mFrom = new Date(year, m, 1);
        const mTo   = new Date(year, m + 1, 0);
        if (mFrom > to) break;
        const count = await prisma.hrLeaveApplication.count({
          where: { schoolId, appliedAt: { gte: mFrom, lte: mTo }, status: "APPROVED" },
        });
        monthlyTrend.push({ month: m + 1, count });
      }

      // Top leave takers
      const topTakers = await prisma.hrLeaveApplication.groupBy({
        by: ["staffId"],
        where: { schoolId, appliedAt: { gte: from, lte: to }, status: "APPROVED" },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
      });
      const takerIds = topTakers.map(t => t.staffId);
      const takerDetails = await prisma.staff.findMany({
        where: { id: { in: takerIds } },
        include: { user: { select: { name: true } } },
      });

      return rep.send({ leaveTypeData, statusBreakdown, monthlyTrend, topTakers: topTakers.map(t => ({
        staffId: t.staffId, applications: t._count.id,
        name: takerDetails.find(d => d.id === t.staffId)?.user?.name,
      })), year });
    }
  );

  // ─────────────────────────────────────────────────────────
  // RECRUITMENT ANALYTICS
  // ─────────────────────────────────────────────────────────
  app.get(`${P}/recruitment`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const year = q.year ? Number(q.year) : new Date().getFullYear();
      const from = new Date(year, 0, 1);
      const to   = new Date(year, 11, 31);

      const [openJobs, closedJobs, totalApps] = await Promise.all([
        prisma.hrJobOpening.count({ where: { schoolId, status: "PUBLISHED" } }),
        prisma.hrJobOpening.count({ where: { schoolId, status: "CLOSED", closedAt: { gte: from, lte: to } } }),
        prisma.hrJobApplication.count({ where: { schoolId, createdAt: { gte: from, lte: to } } }),
      ]);

      // Stage funnel
      const stageFunnel = await prisma.hrJobApplication.groupBy({
        by: ["stage"],
        where: { schoolId, createdAt: { gte: from, lte: to } },
        _count: { id: true },
      });

      // Dept-wise openings
      const deptOpenings = await prisma.hrJobOpening.groupBy({
        by: ["departmentId"],
        where: { schoolId },
        _count: { id: true },
      });
      const depts = await prisma.department.findMany({ where: { schoolId }, select: { id: true, name: true } });
      const deptMap = Object.fromEntries(depts.map(d => [d.id, d.name]));

      // Time to hire (avg days from job creation to JOINED stage)
      const joinedApps = await prisma.hrJobApplication.findMany({
        where: { schoolId, stage: "JOINED", createdAt: { gte: from, lte: to } },
        select: { createdAt: true, joinedAt: true },
      });
      const avgHireDays = joinedApps.length > 0
        ? joinedApps.reduce((sum, a) => sum + (a.joinedAt ? (a.joinedAt.getTime() - a.createdAt.getTime()) / (86400000) : 0), 0) / joinedApps.length
        : 0;

      return rep.send({
        openJobs, closedJobs, totalApps, stageFunnel, avgHireDays: Math.round(avgHireDays),
        deptOpenings: deptOpenings.map(d => ({ deptId: d.departmentId, name: d.departmentId ? deptMap[d.departmentId] ?? "?" : "?", count: d._count.id })),
        year,
      });
    }
  );

  // ─────────────────────────────────────────────────────────
  // PERFORMANCE ANALYTICS
  // ─────────────────────────────────────────────────────────
  app.get(`${P}/performance`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const [topPerformers, lowPerformers, avgScore, goalStats] = await Promise.all([
        prisma.hrPerformanceReview.findMany({
          where: { schoolId, status: "PUBLISHED", percentage: { gte: 80 } },
          orderBy: { percentage: "desc" },
          take: 10,
          include: { staff: { include: { user: { select: { name: true } }, departmentRef: { select: { name: true } } } } },
        }),
        prisma.hrPerformanceReview.findMany({
          where: { schoolId, status: "PUBLISHED", percentage: { lt: 50 } },
          orderBy: { percentage: "asc" },
          take: 10,
          include: { staff: { include: { user: { select: { name: true } }, departmentRef: { select: { name: true } } } } },
        }),
        prisma.hrPerformanceReview.aggregate({
          where: { schoolId, status: "PUBLISHED" },
          _avg: { percentage: true },
        }),
        prisma.hrGoal.groupBy({
          by: ["status"],
          where: { schoolId },
          _count: { id: true },
        }),
      ]);

      // Dept-wise avg performance
      const deptPerf = await prisma.hrPerformanceReview.findMany({
        where: { schoolId, status: "PUBLISHED" },
        include: { staff: { select: { departmentId: true } } },
      });
      const deptAgg: Record<number, { sum: number; count: number }> = {};
      deptPerf.forEach(r => {
        const dId = r.staff?.departmentId;
        if (!dId) return;
        if (!deptAgg[dId]) deptAgg[dId] = { sum: 0, count: 0 };
        deptAgg[dId].sum += Number(r.percentage ?? 0);
        deptAgg[dId].count++;
      });
      const depts = await prisma.department.findMany({ where: { schoolId }, select: { id: true, name: true } });
      const deptPerfData = Object.entries(deptAgg).map(([id, v]) => ({
        deptId: Number(id),
        name: depts.find(d => d.id === Number(id))?.name ?? "?",
        avgScore: Math.round(v.sum / v.count),
      })).sort((a, b) => b.avgScore - a.avgScore);

      // Appraisal status breakdown
      const appraisalStats = await prisma.hrAppraisal.groupBy({
        by: ["status"],
        where: { schoolId },
        _count: { id: true },
      });

      return rep.send({ topPerformers, lowPerformers, avgScore: avgScore._avg.percentage, goalStats, deptPerfData, appraisalStats });
    }
  );

  // ─────────────────────────────────────────────────────────
  // PAYROLL ANALYTICS
  // ─────────────────────────────────────────────────────────
  app.get(`${P}/payroll`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const year = q.year ? Number(q.year) : new Date().getFullYear();

      // Monthly payroll trend from HrEmployeeSalaryProfile
      const profiles = await prisma.hrEmployeeSalaryProfile.findMany({
        where: { schoolId },
        select: { grossSalary: true, ctc: true, basicSalary: true, staffId: true },
      });

      const staffList = await prisma.staff.findMany({
        where: { schoolId, isActive: true },
        include: { departmentRef: { select: { name: true } } },
        select: { id: true, salary: true, departmentId: true, employeeType: true, departmentRef: true } as any,
      });

      // Dept-wise salary cost
      const deptSalary: Record<string, { name: string; total: Decimal; count: number }> = {};
      for (const s of staffList as any[]) {
        const deptName = (s.departmentRef?.name ?? "Unassigned") as string;
        if (!deptSalary[deptName]) deptSalary[deptName] = { name: deptName, total: BigInt(0) as any, count: 0 };
        deptSalary[deptName].total = (parseFloat(deptSalary[deptName].total as any) + parseFloat(s.salary ?? 0)) as any;
        deptSalary[deptName].count++;
      }

      // Salary range distribution
      const salaryRanges = { "0-20k": 0, "20-40k": 0, "40-60k": 0, "60-100k": 0, "100k+": 0 };
      (staffList as any[]).forEach(s => {
        const sal = parseFloat(s.salary ?? 0);
        if (sal < 20000) salaryRanges["0-20k"]++;
        else if (sal < 40000) salaryRanges["20-40k"]++;
        else if (sal < 60000) salaryRanges["40-60k"]++;
        else if (sal < 100000) salaryRanges["60-100k"]++;
        else salaryRanges["100k+"]++;
      });

      const totalPayroll = (staffList as any[]).reduce((sum, s) => sum + parseFloat(s.salary ?? 0), 0);

      return rep.send({
        totalPayroll, deptSalary: Object.values(deptSalary).map(d => ({ ...d, total: parseFloat(d.total as any) })),
        salaryRanges, totalStaff: staffList.length, profiles: profiles.length,
      });
    }
  );

  // ─────────────────────────────────────────────────────────
  // COMPLIANCE ANALYTICS
  // ─────────────────────────────────────────────────────────
  app.get(`${P}/compliance`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();
      const in30Days = new Date(now.getTime() + 30 * 86400000);

      const [totalDocs, verifiedDocs, pendingDocs, expiringSoon, missingRecords] = await Promise.all([
        prisma.staffDocument.count({ where: { schoolId } }),
        prisma.staffDocument.count({ where: { schoolId, verification: "VERIFIED" } }),
        prisma.staffDocument.count({ where: { schoolId, verification: "PENDING" } }),
        prisma.staffDocument.count({ where: { schoolId, expiryDate: { gte: now, lte: in30Days } } }),
        prisma.hrComplianceRecord.count({ where: { schoolId, status: "MISSING" } }),
      ]);

      const verificationRate = totalDocs > 0 ? Math.round((verifiedDocs / totalDocs) * 100) : 0;

      // Verification by doc type
      const docTypeStats = await prisma.staffDocument.groupBy({
        by: ["docType", "verification"],
        where: { schoolId },
        _count: { id: true },
      });

      // Compliance record status breakdown
      const complianceStatusStats = await prisma.hrComplianceRecord.groupBy({
        by: ["status"],
        where: { schoolId },
        _count: { id: true },
      });

      return rep.send({ totalDocs, verifiedDocs, pendingDocs, expiringSoon, missingRecords, verificationRate, docTypeStats, complianceStatusStats });
    }
  );

  // ─────────────────────────────────────────────────────────
  // SAVED REPORTS CRUD
  // ─────────────────────────────────────────────────────────
  app.get(`${P}/saved`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const reports = await prisma.hrSavedReport.findMany({
        where: { schoolId, ...(q.category ? { category: q.category as any } : {}) },
        include: { createdBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: Number(q.limit ?? 50),
      });
      return rep.send({ reports });
    }
  );

  app.post(`${P}/saved`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const report = await prisma.hrSavedReport.create({
        data: {
          schoolId, createdById: Number(userId),
          title: b.title, category: b.category as any,
          format: b.format ?? "PDF", status: "READY",
          filters: b.filters ?? null, fileUrl: b.fileUrl ?? null,
          rowCount: b.rowCount ?? 0, isShared: b.isShared ?? false,
          notes: b.notes ?? null,
        },
      });
      return rep.code(201).send({ report });
    }
  );

  app.delete(`${P}/saved/:id`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.hrSavedReport.delete({ where: { id, schoolId } });
      return rep.send({ ok: true });
    }
  );

  // ─────────────────────────────────────────────────────────
  // SCHEDULED REPORTS CRUD
  // ─────────────────────────────────────────────────────────
  app.get(`${P}/scheduled`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const reports = await prisma.hrScheduledReport.findMany({
        where: { schoolId },
        include: { createdBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ reports });
    }
  );

  app.post(`${P}/scheduled`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const report = await prisma.hrScheduledReport.create({
        data: {
          schoolId, createdById: Number(userId),
          title: b.title, category: b.category as any,
          format: b.format ?? "PDF", frequency: b.frequency,
          filters: b.filters ?? null, recipients: b.recipients ?? [],
          isActive: true,
          nextRunAt: b.nextRunAt ? new Date(b.nextRunAt) : null,
        },
      });
      return rep.code(201).send({ report });
    }
  );

  app.put(`${P}/scheduled/:id`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const report = await prisma.hrScheduledReport.update({
        where: { id, schoolId },
        data: {
          title: b.title, frequency: b.frequency,
          recipients: b.recipients, isActive: b.isActive,
          nextRunAt: b.nextRunAt ? new Date(b.nextRunAt) : undefined,
        },
      });
      return rep.send({ report });
    }
  );

  app.delete(`${P}/scheduled/:id`, { preHandler: [authenticate, requireCapability('hr.reportsAnalytics')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.hrScheduledReport.delete({ where: { id, schoolId } });
      return rep.send({ ok: true });
    }
  );
}
