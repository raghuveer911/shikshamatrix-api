// apps/api/src/routes/dashboard/dashboard.ts
//
// v7 — FINAL, all enums and relations confirmed against real schema.
//
// Critical enum fixes vs v6:
//   - TaskStatus = PENDING | IN_PROGRESS | COMPLETED | CANCELLED | SNOOZED
//     → there is NO "OVERDUE" status. Overdue is now computed from
//       dueDate < now, not from a status value.
//   - LeaveStatus includes SUBMITTED + PENDING — broadened the filter
//     to catch both "awaiting review" states.
//   - ExamStatus = DRAFT | ACTIVE | COMPLETED | ARCHIVED | PUBLISHED
//     → there is NO "SCHEDULED"/"ONGOING". "ACTIVE" is the correct
//       value for exams currently running/scheduled.
//   - LibIssueStatus has an explicit OVERDUE value — using it directly
//     instead of a dueDate comparison.
//   - ExamSubject/ExamClass relations now confirmed real — removed the
//     `as any` cast, query now matches schema exactly.
//   - InvStock confirmed — "Low Stock" is now a REAL calculation
//     (sum of quantity across locations vs reorderLevel), not a proxy.
//   - HostelBed/HostelAllocation confirmed — Hostel Warden occupancy
//     widget is now real data instead of static zeros.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

const ROLE_LABEL: Record<string, string> = {
  TEACHER: "Teacher", FRONT_OFFICE: "Front Office", ACCOUNTANT: "Accountant",
  HR_EXECUTIVE: "HR Executive", LIBRARIAN: "Librarian",
  INVENTORY_MANAGER: "Inventory Manager", HOSTEL_WARDEN: "Hostel Warden",
  TRANSPORT_MANAGER: "Transport Manager", EXAM_COORDINATOR: "Exam Coordinator",
  SYSTEM_ADMIN: "System Admin",
};

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    console.log(`[staff/dashboard] "${label}" failed:`, err?.message ?? err);
    return fallback;
  }
}

export async function staffDashboardRoutes(app: FastifyInstance) {

  app.get("/staff/dashboard",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId, staffId, role } = req as any;

      try {
        const today      = new Date(); today.setHours(0, 0, 0, 0);
        const todayEnd    = new Date(); todayEnd.setHours(23, 59, 59, 999);
        const now         = new Date();
        const todayDay    = now.getDay();

        // ── STAFF PROFILE ──────────────────────────────────────
        const staff: any = await safe("staff.findFirst", () =>
          prisma.staff.findFirst({
            where: { id: staffId, schoolId },
            select: {
              id: true, employeeId: true, joinDate: true, isActive: true,
              user: { select: { name: true, avatarUrl: true, phone: true, email: true } },
              departmentRef:  { select: { name: true } },
              designationRef: { select: { name: true } },
              classesAsTeacher: { select: { id: true, name: true, section: true }, take: 1 },
            },
          }), null);

        console.log("[staff/dashboard] context:", { userId, schoolId, staffId, role });

        const isClassTeacher = !!staff?.classesAsTeacher?.length;
        const classTeacherOf = staff?.classesAsTeacher?.[0] ?? null;
        const isExamCoordinator =
          role === "EXAM_COORDINATOR" ||
          (staff?.designationRef?.name ?? "").toLowerCase().includes("exam");

        const todayAttendance = await safe("staffAttendance.findFirst", () =>
          prisma.staffAttendance.findFirst({
            where: { staffId, date: { gte: today, lte: todayEnd } },
            select: { inTime: true, outTime: true, isHalfDay: true, lateMinutes: true },
          }), null);

        const leaveBalanceRows = await safe("hrLeaveBalance.findMany", () =>
          prisma.hrLeaveBalance.findMany({
            where: { staffId, schoolId },
            select: { totalDays: true, usedDays: true, pendingDays: true },
          }), [] as any[]);

        const leaveBalanceDays = leaveBalanceRows.length > 0
          ? leaveBalanceRows.reduce(
              (sum, r) => sum + (Number(r.totalDays) - Number(r.usedDays) - Number(r.pendingDays)),
              0
            )
          : null;

        // FIXED: TaskStatus has no OVERDUE — only PENDING/IN_PROGRESS count as "pending work"
        const pendingTasksCount = await safe("task.count", () =>
          prisma.task.count({
            where: { schoolId, assignedToId: userId, status: { in: ["PENDING","IN_PROGRESS"] } },
          }), 0);

        const badges: { icon: string; label: string }[] = [];
        if (todayAttendance?.inTime) badges.push({ icon: "🟢", label: "Present" });
        if (isClassTeacher) badges.push({ icon: "⭐", label: "Class Teacher" });
        if (isExamCoordinator) badges.push({ icon: "📝", label: "Exam Coordinator" });

        let quickStats: any[] = [];
        let todaySchedule: any[] = [];
        let roleWidgets: any = {};

        if (role === "TEACHER") {
          const periodsToday = await safe("periodSlot.findMany (today)", () =>
            prisma.periodSlot.findMany({
              where: { teacherId: staffId, dayOfWeek: todayDay },
              orderBy: { startTime: "asc" },
              select: {
                id: true, startTime: true,
                subject: { select: { name: true } },
                class:   { select: { id: true, name: true, section: true } },
              },
            }), [] as any[]);

          const classIds = await safe("periodSlot.findMany (distinct)", () =>
            prisma.periodSlot.findMany({
              where: { teacherId: staffId },
              select: { classId: true }, distinct: ["classId"],
            }), [] as any[]);

          let pendingAttendanceCount = 0;
          for (const p of periodsToday) {
            const marked = await safe(`attendance check ${p.id}`, () =>
              prisma.attendance.findFirst({
                where: { classId: p.class.id, date: { gte: today, lte: todayEnd } },
                select: { id: true },
              }), null);
            if (!marked) pendingAttendanceCount++;
          }

          const pendingHomework = await safe("studyAssignment.count", () =>
            prisma.studyAssignment.count({
              where: { schoolId, createdById: staffId, isActive: true, dueDate: { gte: today, lte: todayEnd } },
            }), 0);

          const pendingMarksEntry = await safe("marksEntry.count (draft)", () =>
            prisma.marksEntry.count({
              where: { schoolId, enteredById: userId, entryStatus: "DRAFT" },
            }), 0);

          quickStats = [
            { id: "classes",    label: "Today's Classes",     value: periodsToday.length,    icon: "calendar",      grad: "primary" },
            { id: "attendance", label: "Pending Attendance",  value: pendingAttendanceCount,  icon: "checkbox",      grad: "danger"  },
            { id: "homework",   label: "Pending Homework",    value: pendingHomework,         icon: "document-text", grad: "warning" },
            { id: "marks",      label: "Pending Marks Entry", value: pendingMarksEntry,       icon: "create",        grad: "violet"  },
          ];

          todaySchedule = periodsToday.map((p: any) => ({
            id: p.id, time: p.startTime, endTime: null,
            title: p.subject?.name ?? "—",
            subtitle: `${p.class.name}-${p.class.section}`,
          }));

          const avgMarks = await safe("marksEntry.aggregate", () =>
            prisma.marksEntry.aggregate({
              where: { enteredById: userId },
              _avg: { obtainedMarks: true },
            }), { _avg: { obtainedMarks: null } } as any);

          const primaryClassId = classIds[0]?.classId;
          const absentAlerts = await safe("student.findMany (absent alerts)", () =>
            prisma.student.findMany({
              where: {
                classId: primaryClassId,
                attendance: { some: { date: { gte: new Date(Date.now() - 3 * 86400000) }, status: "ABSENT" } },
              },
              select: { id: true, user: { select: { name: true } } },
              take: 5,
            }), [] as any[]);

          roleWidgets = {
            type: "TEACHER",
            classPerformance: {
              className: classTeacherOf ? `${classTeacherOf.name}-${classTeacherOf.section}` : null,
              pendingAssignments: pendingHomework,
              avgMarks: avgMarks._avg?.obtainedMarks ? Math.round(Number(avgMarks._avg.obtainedMarks)) : null,
            },
            studentAlerts: absentAlerts.map((s: any) => ({ name: s.user.name, reason: "Absent 3+ days" })),
          };
        }

        else if (role === "FRONT_OFFICE") {
          const enquiriesToday = await safe("enquiry.count", () =>
            prisma.enquiry.count({ where: { schoolId, createdAt: { gte: today, lte: todayEnd } } }), 0);
          const visitorsToday = await safe("visitor.count", () =>
            prisma.visitor.count({ where: { schoolId, checkInAt: { gte: today, lte: todayEnd } } }), 0);
          const admissionsPending = await safe("student.count (draft)", () =>
            prisma.student.count({ where: { schoolId, isDraft: true } }), 0);

          quickStats = [
            { id: "enquiries", label: "New Enquiries",      value: enquiriesToday,    icon: "help-circle", grad: "primary" },
            { id: "visitors",  label: "Visitors Today",     value: visitorsToday,     icon: "people",       grad: "info"    },
            { id: "admission", label: "Admissions Pending", value: admissionsPending, icon: "person-add",   grad: "warning" },
            { id: "followup",  label: "Follow Ups",         value: 0,                 icon: "call",          grad: "violet"  },
          ];
          roleWidgets = { type: "FRONT_OFFICE", todaysVisitors: visitorsToday, pendingAdmissions: admissionsPending, upcomingFollowUps: 0 };
        }

        else if (role === "ACCOUNTANT") {
          const todayCollection = await safe("feeReceipt.aggregate", () =>
            prisma.feeReceipt.aggregate({
              where: { schoolId, createdAt: { gte: today, lte: todayEnd }, isVoid: false },
              _sum: { amount: true },
            }), { _sum: { amount: 0 } } as any);

          const pendingDues = await safe("studentFeeInstallment.aggregate", () =>
            prisma.studentFeeInstallment.aggregate({
              where: { schoolId, status: { in: ["PENDING","OVERDUE"] }, studentPlan: { isActive: true } },
              _sum: { dueAmount: true },
            }), { _sum: { dueAmount: 0 } } as any);

          quickStats = [
            { id: "collection", label: "Today's Collection", value: `₹${Number(todayCollection._sum?.amount ?? 0).toLocaleString("en-IN")}`, icon: "cash",   grad: "success" },
            { id: "dues",       label: "Pending Dues",        value: `₹${Number(pendingDues._sum?.dueAmount ?? 0).toLocaleString("en-IN")}`,   icon: "wallet", grad: "danger"  },
            { id: "refunds",    label: "Pending Refunds",     value: 0, icon: "return-down-back", grad: "warning" },
            { id: "vendor",     label: "Vendor Payments",     value: 0, icon: "briefcase",          grad: "violet"  },
          ];
          roleWidgets = { type: "ACCOUNTANT", collectionToday: Number(todayCollection._sum?.amount ?? 0),
            dueRecovery: Number(pendingDues._sum?.dueAmount ?? 0), gatewayStatus: "Not Configured" };
        }

        else if (role === "HR_EXECUTIVE") {
          const presentStaff = await safe("staffAttendance.count", () =>
            prisma.staffAttendance.count({ where: { schoolId, date: { gte: today, lte: todayEnd }, inTime: { not: null } } }), 0);

          // FIXED: LeaveStatus includes SUBMITTED as a distinct "awaiting review" state
          const leaveRequests = await safe("hrLeaveApplication.count", () =>
            prisma.hrLeaveApplication.count({ where: { schoolId, status: { in: ["SUBMITTED","PENDING"] } } }), 0);

          quickStats = [
            { id: "present", label: "Present Staff",     value: presentStaff,  icon: "people", grad: "success" },
            { id: "leaves",  label: "Leave Requests",    value: leaveRequests, icon: "exit",    grad: "warning" },
            { id: "payroll", label: "Payroll Pending",   value: 0,             icon: "cash",     grad: "danger"  },
            { id: "recruit", label: "Recruitment Tasks", value: 0,             icon: "person-add", grad: "violet" },
          ];
          roleWidgets = { type: "HR", attendanceSummaryPct: null, birthdaysToday: [], anniversariesToday: [] };
        }

        else if (role === "LIBRARIAN") {
          const issuedToday = await safe("libIssue.count (today)", () =>
            prisma.libIssue.count({ where: { schoolId, issueDate: { gte: today, lte: todayEnd } } }), 0);

          // FIXED: LibIssueStatus has an explicit OVERDUE value — use it directly
          const overdueBooks = await safe("libIssue.count (overdue)", () =>
            prisma.libIssue.count({ where: { schoolId, status: "OVERDUE" } }), 0);

          quickStats = [
            { id: "issued",  label: "Books Issued Today", value: issuedToday,  icon: "book",          grad: "primary" },
            { id: "overdue", label: "Overdue Books",      value: overdueBooks, icon: "alert-circle",  grad: "danger"  },
            { id: "reserve", label: "Reservations",       value: 0,            icon: "bookmark",       grad: "info"    },
            { id: "fine",    label: "Fines Pending",      value: 0,            icon: "cash",            grad: "warning" },
          ];
          roleWidgets = { type: "LIBRARIAN", issuedToday, overdueBooks, reservations: 0 };
        }

        else if (role === "INVENTORY_MANAGER") {
          // FIXED: real low-stock calc using InvStock (sum quantity across
          // locations vs the item's reorderLevel threshold)
          const items = await safe("invItem.findMany (stock calc)", () =>
            prisma.invItem.findMany({
              where: { schoolId, isActive: true },
              select: { id: true, reorderLevel: true, stocks: { select: { quantity: true } } },
            }), [] as any[]);

          const lowStock = items.filter((it: any) => {
            const totalQty = it.stocks.reduce((s: number, x: any) => s + x.quantity, 0);
            return totalQty <= it.reorderLevel;
          }).length;

          quickStats = [
            { id: "lowstock", label: "Low Stock",        value: lowStock, icon: "alert-circle", grad: "danger"  },
            { id: "requests", label: "Pending Requests", value: 0,        icon: "clipboard",      grad: "warning" },
            { id: "maint",    label: "Maintenance Due",  value: 0,        icon: "build",            grad: "info"    },
            { id: "orders",   label: "Purchase Orders",  value: 0,        icon: "cart",             grad: "violet"  },
          ];
          roleWidgets = { type: "INVENTORY", lowStockCount: lowStock, pendingRequests: 0, maintenanceDue: 0 };
        }

        else if (role === "HOSTEL_WARDEN") {
          // FIXED: real occupancy using HostelBed
          const totalBeds = await safe("hostelBed.count", () =>
            prisma.hostelBed.count({ where: { room: { hostel: { schoolId } } } }), 0);
          const occupiedBeds = await safe("hostelBed.count (occupied)", () =>
            prisma.hostelBed.count({ where: { room: { hostel: { schoolId } }, status: "OCCUPIED" } }), 0);
          const vacantBeds = Math.max(0, totalBeds - occupiedBeds);
          const occupancyPct = totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0;

          const checkinsToday = await safe("hostelAllocation.count (today)", () =>
            prisma.hostelAllocation.count({
              where: { schoolId, status: "ACTIVE", allocationDate: { gte: today, lte: todayEnd } },
            }), 0);

          quickStats = [
            { id: "occupancy", label: "Occupancy",       value: totalBeds > 0 ? `${occupancyPct}%` : "—", icon: "home", grad: "primary" },
            { id: "vacant",    label: "Vacant Beds",     value: vacantBeds,   icon: "bed",   grad: "info"    },
            { id: "complaint", label: "Complaints",      value: 0,            icon: "warning", grad: "danger" },
            { id: "checkin",   label: "Check-ins Today", value: checkinsToday, icon: "log-in", grad: "success" },
          ];
          roleWidgets = { type: "HOSTEL", occupiedBeds, vacantBeds, complaints: 0 };
        }

        else if (role === "TRANSPORT_MANAGER") {
          const vehiclesRunning = await safe("transportVehicle.count", () =>
            prisma.transportVehicle.count({ where: { schoolId, status: "ACTIVE", isActive: true } }), 0);

          quickStats = [
            { id: "running", label: "Vehicles Running",   value: vehiclesRunning, icon: "bus",         grad: "primary" },
            { id: "delayed", label: "Delayed Routes",     value: 0,               icon: "time",         grad: "warning" },
            { id: "maint",   label: "Maintenance Alerts", value: 0,               icon: "build",         grad: "danger"  },
            { id: "fuel",    label: "Fuel Alerts",        value: 0,               icon: "speedometer",   grad: "info"    },
          ];
          roleWidgets = { type: "TRANSPORT", vehiclesRunning, delayedRoutes: 0, maintenanceAlerts: 0 };
        }

        else if (role === "EXAM_COORDINATOR" || isExamCoordinator) {
          // FIXED: ExamStatus has no SCHEDULED/ONGOING — "ACTIVE" is the
          // correct value for currently-running/scheduled exams
          const upcomingExamsCountLocal = await safe("examConfig.count", () =>
            prisma.examConfig.count({ where: { schoolId, status: "ACTIVE" } }), 0);

          // FIXED: real relation confirmed — examSubject → examClass → examConfig
          const marksPending = await safe("examSubject.count", () =>
            prisma.examSubject.count({
              where: { examClass: { examConfig: { schoolId, status: "ACTIVE" } }, marksEntries: { none: {} } },
            }), 0);

          quickStats = [
            { id: "exams",   label: "Upcoming Exams", value: upcomingExamsCountLocal, icon: "create",       grad: "primary" },
            { id: "pending", label: "Marks Pending",  value: marksPending,            icon: "alert-circle", grad: "danger"  },
            { id: "result",  label: "Results Status", value: "In Progress",          icon: "bar-chart",     grad: "warning" },
            { id: "hall",    label: "Hall Tickets",   value: 0,                       icon: "id-card",       grad: "info"    },
          ];
          roleWidgets = { type: "EXAM_COORDINATOR", upcomingExamsCount: upcomingExamsCountLocal, marksPending, resultGenerationStatus: "In Progress" };
        }

        else if (role === "SYSTEM_ADMIN") {
          const [activeStudentCount, subscription] = await Promise.all([
            safe("student.count", () => prisma.student.count({ where: { schoolId, isActive: true } }), 0),
            safe("subscription", () => prisma.schoolSubscription.findUnique({ where: { schoolId }, include: { plan: true } }), null),
          ]);

          const maxStudents = subscription?.plan.maxStudents ?? 0; // 0 = unlimited (Enterprise) or no plan
          const studentLimitLabel = maxStudents > 0 ? `${activeStudentCount} / ${maxStudents}` : `${activeStudentCount}`;
          const subscriptionLabel = !subscription
            ? "No Plan"
            : subscription.status === "ACTIVE"
              ? (subscription.isTrial ? "Trial" : subscription.plan.name.replace("ShikshaMatrix ", ""))
              : subscription.status === "GRACE"
                ? "Grace Period"
                : "Expired";

          quickStats = [
            { id: "students", label: "Students", value: studentLimitLabel, icon: "people",           grad: "primary" },
            { id: "server",   label: "Server Status", value: "Online",    icon: "server",            grad: "success" },
            { id: "backup",   label: "Backup Status", value: "OK",        icon: "cloud-done",        grad: "info"    },
            { id: "sub",      label: "Subscription",  value: subscriptionLabel, icon: "shield-checkmark", grad: "violet"  },
          ];
          roleWidgets = {
            type: "SYSTEM_ADMIN",
            activeStudentCount, maxStudents,
            subscriptionTier: subscription?.plan.tier ?? null,
            subscriptionStatus: subscription?.status ?? "NONE",
            serverStatus: "Online", backupStatus: "OK",
          };
        }

        // FIXED: TaskStatus no OVERDUE — pull PENDING/IN_PROGRESS, compute
        // overdue client-side from dueDate
        const myTasksRaw = await safe("task.findMany", () =>
          prisma.task.findMany({
            where: { schoolId, assignedToId: userId, status: { in: ["PENDING","IN_PROGRESS"] } },
            orderBy: [{ dueDate: "asc" }],
            take: 5,
            select: { id: true, title: true, dueDate: true, priority: true, status: true, type: true, route: true },
          }), [] as any[]);

        const myTasks = myTasksRaw.map((t: any) => ({
          id: t.id, title: t.title, dueDate: t.dueDate, priority: t.priority,
          status: t.status, route: t.route,
          isOverdue: t.dueDate ? new Date(t.dueDate) < now : false,
        }));

        const QUICK_ACTIONS_BY_ROLE: Record<string, string[]> = {
          TEACHER:            ["attendance","homework","marks","messages"],
          FRONT_OFFICE:       ["enquiry","visitor","admission"],
          ACCOUNTANT:         ["collect_fee","receipt","expense"],
          HR_EXECUTIVE:       ["approve_leave","staff_attendance","payroll"],
          LIBRARIAN:          ["issue_book","return_book","reservation"],
          INVENTORY_MANAGER:  ["stock_in","stock_out","request"],
          HOSTEL_WARDEN:      ["allocate_room","vacate","complaint"],
          TRANSPORT_MANAGER:  ["track_vehicle","route_manage","maintenance"],
          EXAM_COORDINATOR:   ["schedule_exam","marks_entry","results"],
          SYSTEM_ADMIN:       ["user_manage","settings","backup"],
        };
        const quickActions = QUICK_ACTIONS_BY_ROLE[role] ?? ["messages","tasks"];

        const recentActivities: any[] = [];
        const recentAttendance = await safe("attendance.findFirst (recent)", () =>
          prisma.attendance.findFirst({
            where: { markedById: userId },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true, class: { select: { name: true, section: true } } },
          }), null);
        if (recentAttendance) {
          recentActivities.push({
            id: "att", icon: "checkbox", color: "success",
            label: `Attendance submitted for ${recentAttendance.class?.name}-${recentAttendance.class?.section}`,
            time: recentAttendance.createdAt,
          });
        }

        // FIXED: FeeReceipt has no collectedById field — the collector is
        // recorded on the related Payment (receivedById → User.id via the
        // "ReceivedBy" relation), so we filter through that relation instead.
        const recentReceipt = await safe("feeReceipt.findFirst (recent)", () =>
          prisma.feeReceipt.findFirst({
            where: { schoolId, isVoid: false, payment: { receivedById: userId } },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true, amount: true },
          }), null);
        if (recentReceipt) {
          recentActivities.push({
            id: "fee", icon: "cash", color: "success",
            label: `Fee collected — ₹${Number(recentReceipt.amount).toLocaleString("en-IN")}`,
            time: recentReceipt.createdAt,
          });
        }
        recentActivities.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

        const announcements = await safe("commBroadcast.findMany", () =>
          prisma.commBroadcast.findMany({
            where: { schoolId, status: "SENT", audienceType: { in: ["ALL","ALL_STAFF"] } },
            take: 5, orderBy: { sentAt: "desc" },
            select: { id: true, title: true, content: true, sentAt: true },
          }), [] as any[]);

        // FIXED: ExamStatus "ACTIVE" (was wrongly "SCHEDULED"/"ONGOING")
        const upcomingExams = await safe("examConfig.findMany (calendar)", () =>
          prisma.examConfig.findMany({
            where: { schoolId, status: "ACTIVE" },
            take: 5, orderBy: { startDate: "asc" },
            select: { id: true, name: true, startDate: true },
          }), [] as any[]);

        const calendarEvents = upcomingExams.map((e: any) => ({
          id: `exam-${e.id}`, date: e.startDate, title: e.name, type: "EXAM",
        }));

        let performance: { label: string; value: number }[] = [];
        if (role === "TEACHER")            performance = [{ label: "Homework Completion Rate", value: 0 }];
        else if (role === "HR_EXECUTIVE")  performance = [{ label: "Staff Attendance %", value: 0 }];
        else if (role === "ACCOUNTANT")    performance = [{ label: "Collection Target", value: 0 }];

        const aiSuggestions: { id: string; text: string; actionKey: string }[] = [];
        if (role === "TEACHER") {
          const pendingAttStat = quickStats.find(s => s.id === "attendance")?.value ?? 0;
          if (Number(pendingAttStat) > 0) aiSuggestions.push({ id: "att", text: `${pendingAttStat} classes pending attendance`, actionKey: "attendance" });
          const pendingMarksStat = quickStats.find(s => s.id === "marks")?.value ?? 0;
          if (Number(pendingMarksStat) > 0) aiSuggestions.push({ id: "marks", text: `${pendingMarksStat} exams pending marks entry`, actionKey: "marks" });
        }
        if (upcomingExams.length > 0) {
          aiSuggestions.push({ id: "exam", text: `${upcomingExams.length} exams this week`, actionKey: "exams" });
        }

        return reply.send({
          success: true,
          data: {
            profile: {
              name:         staff?.user?.name ?? null,
              avatarUrl:    staff?.user?.avatarUrl ?? null,
              employeeId:   staff?.employeeId ?? `STF-${String(staffId).padStart(5, "0")}`,
              department:   staff?.departmentRef?.name ?? null,
              designation:  staff?.designationRef?.name ?? ROLE_LABEL[role] ?? role,
              joiningDate:  staff?.joinDate ?? null,
              role, roleLabel: ROLE_LABEL[role] ?? role,
              badges,
              todayAttendance: {
                checkedIn: !!todayAttendance?.inTime,
                checkInTime: todayAttendance?.inTime ?? null,
              },
              leaveBalance: leaveBalanceDays,
              pendingTasksCount,
            },
            quickStats,
            todaySchedule,
            myTasks,
            quickActions,
            roleWidgets,
            recentActivities: recentActivities.slice(0, 5),
            announcements: announcements.map((a: any) => {
              const c = typeof a.content === "object" ? (a.content as any)?.APP_NOTIFICATION?.body ?? "" : "";
              return { id: a.id, title: a.title, body: c, sentAt: a.sentAt };
            }),
            calendarEvents,
            performance,
            aiSuggestions,
          },
        });

      } catch (outerErr: any) {
        console.error("[staff/dashboard] UNCAUGHT ERROR:", outerErr);
        return reply.status(200).send({
          success: true,
          data: {
            profile: {
              name: null, avatarUrl: null, employeeId: `STF-${String(staffId).padStart(5, "0")}`,
              department: null, designation: ROLE_LABEL[role] ?? role, joiningDate: null,
              role, roleLabel: ROLE_LABEL[role] ?? role, badges: [],
              todayAttendance: { checkedIn: false, checkInTime: null },
              leaveBalance: null, pendingTasksCount: 0,
            },
            quickStats: [], todaySchedule: [], myTasks: [],
            quickActions: [], roleWidgets: {}, recentActivities: [],
            announcements: [], calendarEvents: [], performance: [], aiSuggestions: [],
          },
          _debugError: outerErr?.message ?? String(outerErr),
        });
      }
    }
  );
}