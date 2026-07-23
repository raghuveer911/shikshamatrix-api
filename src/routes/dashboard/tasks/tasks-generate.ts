// apps/api/src/routes/staff/tasks-generate.ts
//
// v2 fixes vs original:
//   - ExamClass has NO `examId`/`exam` fields — it's `examConfigId`/
//     `examConfig`. Also ExamStatus has no "ONGOING" value — the
//     correct value for a running exam is "ACTIVE".
//   - StudentAttendance model doesn't exist — the real model is
//     `Attendance` (schema confirmed earlier).
//   - LibIssueStatus has an explicit "OVERDUE" value — using it
//     directly instead of ACTIVE + dueDate<today.
//   - LeaveStatus broadened to include SUBMITTED (an "awaiting
//     review" state distinct from PENDING).
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";

const ROLE_TASK_TYPES: Record<string, string[]> = {
  TEACHER:            ["ATTENDANCE_PENDING","MARKS_PENDING","HOMEWORK_PENDING"],
  ACCOUNTANT:         ["FEE_COLLECTION_DUE","PAYROLL_PENDING"],
  HR_EXECUTIVE:       ["LEAVE_APPROVAL","DOCUMENT_VERIFICATION","PAYROLL_PENDING"],
  FRONT_OFFICE:       ["DOCUMENT_VERIFICATION"],
  LIBRARIAN:          ["OVERDUE_BOOKS"],
  INVENTORY_MANAGER:  ["LOW_STOCK_ALERT"],
  TRANSPORT_MANAGER:  ["VEHICLE_DOC_EXPIRY","VEHICLE_MAINTENANCE"],
  HOSTEL_WARDEN:      ["HOSTEL_ALLOCATION_PENDING"],
  EXAM_COORDINATOR:   ["MARKS_PENDING","EXAM_SCHEDULE_PENDING"],
  SYSTEM_ADMIN:       ["LEAVE_APPROVAL","DOCUMENT_VERIFICATION","PAYROLL_PENDING","LOW_STOCK_ALERT"],
};

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) {
    console.log(`[tasks/generate] "${label}" failed:`, err?.message ?? err);
    return fallback;
  }
}

export async function tasksGenerateRoutes(app: FastifyInstance) {

  app.post("/tasks/generate",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId, role } = req as any;

      const taskTypes = ROLE_TASK_TYPES[role] ?? [];
      if (taskTypes.length === 0) {
        return reply.send({ success: true, data: { generated: 0 } });
      }

      const today    = new Date(); today.setHours(0,0,0,0);
      const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
      const tasksToCreate: any[] = [];

      const alreadyExists = async (type: string, refId: string) =>
        safe(`alreadyExists ${type}`, async () => {
          const existing = await prisma.task.findFirst({
            where: {
              schoolId, assignedToId: userId, type: type as any,
              referenceId: refId, status: { in: ["PENDING","IN_PROGRESS"] },
            },
          });
          return !!existing;
        }, false);

      const staff = await safe("staff.findFirst", () =>
        prisma.staff.findFirst({ where: { userId, schoolId }, select: { id: true } }), null);

      // ── ATTENDANCE_PENDING (Teachers) — FIXED: Attendance not StudentAttendance ──
      if (taskTypes.includes("ATTENDANCE_PENDING") && staff) {
        const assignedClasses = await safe("periodSlot.findMany (classes)", () =>
        prisma.periodSlot.findMany({
        where: {teacherId: staff.id,},
        select: { classId: true },
        distinct: ["classId"],}), [] as any[]);

        for (const { classId } of assignedClasses) {
          const submitted = await safe(`attendance check ${classId}`, () =>
            prisma.attendance.findFirst({
              where: { classId, date: { gte: today, lte: todayEnd } },
            }), null);

          if (!submitted) {
            const refId = `att-${classId}-${today.toISOString().split("T")[0]}`;
            if (!(await alreadyExists("ATTENDANCE_PENDING", refId))) {
              const cls = await safe(`class.findUnique ${classId}`, () =>
                prisma.class.findUnique({ where: { id: classId }, select: { name: true, section: true } }), null);
              tasksToCreate.push({
                schoolId, title: `Take Attendance — ${cls?.name ?? ""} ${cls?.section ?? ""}`,
                description: "Attendance not marked for today",
                type: "ATTENDANCE_PENDING", priority: "HIGH", module: "students",
                route: `/(staff)/modules/students/attendance?classId=${classId}`,
                referenceId: refId, assignedToId: userId, assignedById: userId,
                isSystemGenerated: true,
                dueDate: new Date(today.getTime() + 10 * 3600000),
              });
            }
          }
        }
      }

      // ── MARKS_PENDING — FIXED: examConfigId/examConfig, status "ACTIVE" ──
      if (taskTypes.includes("MARKS_PENDING") && staff) {
        const pendingExams = await safe("examClass.findMany", () =>
        prisma.examClass.findMany({
        where: {examConfig: { schoolId, status: "ACTIVE" },
        subjects: {
        some: {subject: { teacherId: staff.id },   // ← filter through subject relation
        marksEntries: { none: {} },},},},
        select: {
        examConfigId: true, classId: true,
        examConfig: { select: { name: true } },},take: 5,}), [] as any[]);

        for (const ec of pendingExams) {
          const refId = `marks-${ec.examConfigId}-${ec.classId}`;
          if (!(await alreadyExists("MARKS_PENDING", refId))) {
            tasksToCreate.push({
              schoolId, title: `Enter Marks — ${ec.examConfig.name}`,
              description: "Marks entry pending for ongoing exam",
              type: "MARKS_PENDING", priority: "HIGH", module: "academics",
              route: `/(staff)/modules/academics/marks/${ec.examConfigId}`,
              referenceId: refId, assignedToId: userId, assignedById: userId,
              isSystemGenerated: true,
              dueDate: new Date(Date.now() + 24 * 3600000),
            });
          }
        }
      }

      // ── LEAVE_APPROVAL — broadened to SUBMITTED + PENDING ──
      if (taskTypes.includes("LEAVE_APPROVAL")) {
        const pendingLeaves = await safe("hrLeaveApplication.findMany", () =>
          prisma.hrLeaveApplication.findMany({
            where: { schoolId, status: { in: ["SUBMITTED","PENDING"] } },
            select: { id: true, staff: { select: { user: { select: { name: true } } } } },
            take: 10,
          }), [] as any[]);

        for (const leave of pendingLeaves) {
          const refId = `leave-${leave.id}`;
          if (!(await alreadyExists("LEAVE_APPROVAL", refId))) {
            tasksToCreate.push({
              schoolId, title: `Approve Leave — ${leave.staff.user.name}`,
              description: "Leave application pending for approval",
              type: "LEAVE_APPROVAL", priority: "HIGH", module: "hr",
              route: `/(staff)/modules/hr/leaves/${leave.id}`,
              referenceId: refId, assignedToId: userId, assignedById: userId,
              isSystemGenerated: true,
              dueDate: new Date(Date.now() + 12 * 3600000),
            });
          }
        }
      }

      // ── FEE_COLLECTION_DUE ──
      if (taskTypes.includes("FEE_COLLECTION_DUE")) {
        const overdueCount = await safe("studentFeeInstallment.count", () =>
          prisma.studentFeeInstallment.count({
            where: { schoolId, status: "OVERDUE", dueDate: { lt: today } },
          }), 0);

        if (overdueCount > 0) {
          const refId = `fee-overdue-${today.toISOString().split("T")[0]}`;
          if (!(await alreadyExists("FEE_COLLECTION_DUE", refId))) {
            tasksToCreate.push({
              schoolId, title: `${overdueCount} Overdue Fee Installments`,
              description: "Students with overdue fees need follow-up",
              type: "FEE_COLLECTION_DUE", priority: "CRITICAL", module: "finance",
              route: `/(staff)/modules/finance/dues`,
              referenceId: refId, assignedToId: userId, assignedById: userId,
              isSystemGenerated: true, dueDate: today,
            });
          }
        }
      }

      // ── OVERDUE_BOOKS — FIXED: use explicit OVERDUE status ──
      if (taskTypes.includes("OVERDUE_BOOKS")) {
        const overdueBooks = await safe("libIssue.count", () =>
          prisma.libIssue.count({ where: { schoolId, status: "OVERDUE" } }), 0);

        if (overdueBooks > 0) {
          const refId = `lib-overdue-${today.toISOString().split("T")[0]}`;
          if (!(await alreadyExists("OVERDUE_BOOKS", refId))) {
            tasksToCreate.push({
              schoolId, title: `${overdueBooks} Overdue Books`,
              description: "Books not returned past due date",
              type: "OVERDUE_BOOKS", priority: "MEDIUM", module: "library",
              route: `/(staff)/modules/library/issues?filter=overdue`,
              referenceId: refId, assignedToId: userId, assignedById: userId,
              isSystemGenerated: true, dueDate: todayEnd,
            });
          }
        }
      }

      // ── VEHICLE_DOC_EXPIRY ──
      if (taskTypes.includes("VEHICLE_DOC_EXPIRY")) {
        const thirtyDays = new Date(Date.now() + 30 * 86400000);
        const expiringDocs = await safe("transportVehicleDoc.findMany", () =>
          prisma.transportVehicleDoc.findMany({
            where: { vehicle: { schoolId, isActive: true }, expiryDate: { gte: today, lte: thirtyDays } },
            select: { id: true, docType: true, vehicle: { select: { vehicleNo: true } } },
            take: 5,
          }), [] as any[]);

        for (const doc of expiringDocs) {
          const refId = `vehicledoc-${doc.id}`;
          if (!(await alreadyExists("VEHICLE_DOC_EXPIRY", refId))) {
            tasksToCreate.push({
              schoolId, title: `${doc.docType} Expiring — ${doc.vehicle.vehicleNo}`,
              description: "Vehicle document expiring within 30 days",
              type: "VEHICLE_DOC_EXPIRY", priority: "HIGH", module: "transport",
              route: `/(staff)/modules/transport/vehicles`,
              referenceId: refId, assignedToId: userId, assignedById: userId,
              isSystemGenerated: true, dueDate: thirtyDays,
            });
          }
        }
      }

      // ── LOW_STOCK_ALERT — InvStock confirmed, this already matches ──
      if (taskTypes.includes("LOW_STOCK_ALERT")) {
        const items = await safe("invItem.findMany", () =>
          prisma.invItem.findMany({
            where: { schoolId, isActive: true },
            select: { id: true, name: true, minimumLevel: true, stocks: { select: { quantity: true } } },
          }), [] as any[]);

        const lowStockItems = items.filter((i: any) =>
          i.stocks.reduce((s: number, st: any) => s + st.quantity, 0) <= i.minimumLevel
        );

        if (lowStockItems.length > 0) {
          const refId = `lowstock-${today.toISOString().split("T")[0]}`;
          if (!(await alreadyExists("LOW_STOCK_ALERT", refId))) {
            tasksToCreate.push({
              schoolId, title: `${lowStockItems.length} Items Low on Stock`,
              description: lowStockItems.slice(0,3).map((i: any) => i.name).join(", "),
              type: "LOW_STOCK_ALERT", priority: "MEDIUM", module: "inventory",
              route: `/(staff)/modules/inventory/items?lowStock=true`,
              referenceId: refId, assignedToId: userId, assignedById: userId,
              isSystemGenerated: true, dueDate: todayEnd,
            });
          }
        }
      }

      // ── DOCUMENT_VERIFICATION — HrComplianceRecord confirmed, matches ──
      if (taskTypes.includes("DOCUMENT_VERIFICATION")) {
        const missingDocs = await safe("hrComplianceRecord.count", () =>
          prisma.hrComplianceRecord.count({ where: { schoolId, status: "MISSING" } }), 0);

        if (missingDocs > 0) {
          const refId = `docs-missing-${today.toISOString().split("T")[0]}`;
          if (!(await alreadyExists("DOCUMENT_VERIFICATION", refId))) {
            tasksToCreate.push({
              schoolId, title: `${missingDocs} Documents Missing`,
              description: "Staff documents pending verification",
              type: "DOCUMENT_VERIFICATION", priority: "MEDIUM", module: "hr",
              route: `/(staff)/modules/hr/staff/index`,
              referenceId: refId, assignedToId: userId, assignedById: userId,
              isSystemGenerated: true,
              dueDate: new Date(Date.now() + 48 * 3600000),
            });
          }
        }
      }

      if (tasksToCreate.length > 0) {
        await safe("task.createMany", () => prisma.task.createMany({ data: tasksToCreate }), null);
      }

      return reply.send({ success: true, data: { generated: tasksToCreate.length } });
    }
  );
}