// apps/api/src/routes/staff/profile-core.ts
//
// FIXED: renamed `staff` → `staffMember` everywhere this refers to
// the User model's relation to Staff — confirmed via Prisma error
// that the actual relation name on User is `staffMember`, not `staff`.
// (Direct `prisma.staff.findFirst(...)` calls elsewhere in this file
// are untouched — those query the Staff model directly, not through
// User, and were never broken.)
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { z } from "zod";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[profile] "${label}" failed:`, err?.message ?? err); return fallback; }
}

const applyLeaveSchema = z.object({
  leaveTypeId: z.number(), fromDate: z.string(), toDate: z.string(),
  totalDays: z.number(), isHalfDay: z.boolean().optional(),
  halfDayType: z.string().optional(), reason: z.string().min(5),
});

export async function profileRoutes(app: FastifyInstance) {

  // ── GET /profile — Premium overview payload ──────────────────
  app.get("/profile",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const user = await safe("user.findUnique", () =>
        prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true, name: true, phone: true, email: true,
            gender: true, avatarUrl: true, role: true,
            staffMember: {
              select: {
                id: true, employeeId: true, employeeType: true, status: true,
                joinDate: true, probationEnd: true, contractEnd: true, dob: true,
                currentAddress: true, permanentAddress: true,
                emergencyName: true, emergencyPhone: true, emergencyRelation: true,
                bloodGroup: true, maritalStatus: true,
                departmentRef:  { select: { id: true, name: true } },
                designationRef: { select: { id: true, name: true, level: true,
                  reportingTo: { select: { name: true } } } },
                salaryProfile: { select: { grossSalary: true, ctc: true } },
              },
            },
            school: { select: { name: true, logoUrl: true } },
          },
        }), null);

      if (!user) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      const staffId = user.staffMember?.id;
      const today = new Date(); today.setHours(0,0,0,0);
      const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);

      const [
        idCard, leaveBalances, todayAttendance,
        pendingDocsCount, totalDocsCount,
        pendingReimbCount, pendingLoanCount,
        compOffBalance,
      ] = await Promise.all([
        safe("hrStaffIdCard.findFirst", () =>
          prisma.hrStaffIdCard.findFirst({
            where: { staffId, status: "ACTIVE" },
            select: { cardNumber: true, issueDate: true, validUntil: true,
              qrCode: true, frontImageUrl: true, pdfUrl: true },
          }), null),
        safe("hrLeaveBalance.findMany", () =>
          prisma.hrLeaveBalance.findMany({
            where: { staffId, schoolId },
            select: { totalDays: true, usedDays: true, pendingDays: true,
              leaveType: { select: { name: true, color: true, isPaid: true } } },
          }), [] as any[]),
        safe("staffAttendance.findFirst", () =>
          prisma.staffAttendance.findFirst({
            where: { staffId, date: { gte: today, lte: todayEnd } },
            select: { inTime: true, outTime: true, status: true },
          }), null),
        safe("staffDocument.count (pending)", () =>
          prisma.staffDocument.count({ where: { staffId, verification: "PENDING" } }), 0),
        safe("staffDocument.count (total)", () =>
          prisma.staffDocument.count({ where: { staffId } }), 0),
        safe("reimbursement.count", () =>
          prisma.reimbursement.count({ where: { staffId, status: { in: ["SUBMITTED"] } } }), 0),
        safe("hrLoanRequest.count", () =>
          prisma.hrLoanRequest.count({ where: { staffId, status: "PENDING" } }), 0),
        safe("hrCompOff.findMany", () =>
          prisma.hrCompOff.findMany({
            where: { staffId, isActive: true },
            select: { earnedDays: true, usedDays: true },
          }), [] as any[]),
      ]);

      const compOffAvailable = compOffBalance.reduce(
        (sum: number, c: any) => sum + (Number(c.earnedDays) - Number(c.usedDays)), 0
      );

      const totalLeaveAvailable = leaveBalances.reduce(
        (sum: number, lb: any) => sum + (Number(lb.totalDays) - Number(lb.usedDays) - Number(lb.pendingDays)), 0
      );

      return reply.send({
        success: true,
        data: {
          user: {
            id: user.id, name: user.name, phone: user.phone, email: user.email,
            gender: user.gender, dob: user.staffMember?.dob ?? null, avatarUrl: user.avatarUrl, role: user.role,
            employeeId:   user.staffMember?.employeeId,
            employeeType: user.staffMember?.employeeType,
            status:       user.staffMember?.status,
            joinDate:     user.staffMember?.joinDate,
            probationEnd: user.staffMember?.probationEnd,
            contractEnd:  user.staffMember?.contractEnd,
            department:   user.staffMember?.departmentRef?.name ?? "—",
            designation:  user.staffMember?.designationRef?.name ?? "—",
            designationLevel: user.staffMember?.designationRef?.level ?? null,
            reportingTo:  user.staffMember?.designationRef?.reportingTo?.name ?? null,
            bloodGroup:   user.staffMember?.bloodGroup,
            maritalStatus: user.staffMember?.maritalStatus,
            currentAddress: user.staffMember?.currentAddress,
            permanentAddress: user.staffMember?.permanentAddress,
            emergencyContact: {
              name: user.staffMember?.emergencyName, phone: user.staffMember?.emergencyPhone,
              relation: user.staffMember?.emergencyRelation,
            },
            schoolName: user.school?.name,
          },
          idCard,
          leaveBalances,
          stats: {
            todayCheckedIn: !!todayAttendance?.inTime,
            todayCheckInTime: todayAttendance?.inTime ?? null,
            totalLeaveAvailable,
            compOffAvailable,
            pendingDocsCount, totalDocsCount,
            pendingReimbCount, pendingLoanCount,
          },
        },
      });
    }
  );

  // ── GET /profile/id-card — full-screen digital ID card ───────
  // (Unchanged — already queries Staff directly via prisma.staff.findFirst,
  // not through the User relation, so it was never affected by this bug.)
  app.get("/profile/id-card",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const staff = await safe("staff.findFirst", () =>
        prisma.staff.findFirst({
          where: { userId, schoolId },
          select: {
            id: true, employeeId: true,
            user: { select: { name: true, avatarUrl: true } },
            departmentRef: { select: { name: true } },
            designationRef: { select: { name: true } },
          },
        }), null);

      if (!staff) return reply.status(404).send({ success: false, error: "STAFF_NOT_FOUND" });

      const idCard = await safe("hrStaffIdCard.findFirst", () =>
        prisma.hrStaffIdCard.findFirst({
          where: { staffId: staff.id, status: "ACTIVE" },
          select: {
            cardNumber: true, issueDate: true, validUntil: true,
            qrCode: true, frontImageUrl: true, backImageUrl: true, pdfUrl: true,
          },
        }), null);

      if (!idCard) {
        return reply.send({ success: true, data: { issued: false } });
      }

      return reply.send({
        success: true,
        data: {
          issued: true,
          name: staff.user.name, avatarUrl: staff.user.avatarUrl,
          employeeId: staff.employeeId,
          department: staff.departmentRef?.name, designation: staff.designationRef?.name,
          ...idCard,
        },
      });
    }
  );

  // ── GET /profile/attendance — unchanged from your working version ──
  app.get("/profile/attendance",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { month, year } = req.query as Record<string, string>;

      const staff = await prisma.staff.findFirst({ where: { userId, schoolId }, select: { id: true } });
      if (!staff) return reply.status(404).send({ success: false, error: "STAFF_NOT_FOUND" });

      const now = new Date();
      const m = month ? parseInt(month) - 1 : now.getMonth();
      const y = year  ? parseInt(year)      : now.getFullYear();
      const monthStart = new Date(y, m, 1);
      const monthEnd   = new Date(y, m + 1, 0, 23, 59, 59);

      const records = await prisma.staffAttendance.findMany({
        where: { staffId: staff.id, date: { gte: monthStart, lte: monthEnd } },
        orderBy: { date: "desc" },
        select: { id: true, date: true, status: true, inTime: true, outTime: true,
          lateMinutes: true, isHalfDay: true, remarks: true },
      });

      const summary = {
        present: records.filter(r => r.status === "PRESENT").length,
        absent:  records.filter(r => r.status === "ABSENT").length,
        late:    records.filter(r => r.status === "LATE").length,
        halfDay: records.filter(r => r.isHalfDay).length,
        onLeave: records.filter(r => r.status === "ON_LEAVE").length,
        total: records.length,
        workingDays: new Date(y, m + 1, 0).getDate(),
      };

      return reply.send({ success: true, data: { records, summary, month: m + 1, year: y } });
    }
  );

  // ── GET /profile/leaves — unchanged ───────────────────────────
  app.get("/profile/leaves",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { status } = req.query as Record<string, string>;

      const staff = await prisma.staff.findFirst({ where: { userId, schoolId }, select: { id: true } });
      if (!staff) return reply.status(404).send({ success: false, error: "STAFF_NOT_FOUND" });

      const [leaves, leaveTypes, balances] = await Promise.all([
        prisma.hrLeaveApplication.findMany({
          where: { staffId: staff.id, schoolId, ...(status ? { status: status as any } : {}) },
          orderBy: { appliedAt: "desc" }, take: 30,
          select: {
            id: true, fromDate: true, toDate: true, totalDays: true,
            isHalfDay: true, reason: true, status: true, appliedAt: true,
            hrNote: true, hrActionAt: true,
            leaveType: { select: { name: true, color: true } },
          },
        }),
        prisma.hrLeaveType.findMany({
          where: { schoolId, isActive: true },
          select: { id: true, name: true, color: true, isPaid: true,
            halfDayAllowed: true, minDays: true, maxDays: true },
        }),
        prisma.hrLeaveBalance.findMany({
          where: { staffId: staff.id, schoolId },
          select: { totalDays: true, usedDays: true, pendingDays: true,
            leaveType: { select: { name: true, color: true } } },
        }),
      ]);

      return reply.send({ success: true, data: { leaves, leaveTypes, balances } });
    }
  );

  // ── POST /profile/leaves/apply — unchanged ────────────────────
  app.post("/profile/leaves/apply",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const parsed = applyLeaveSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });

      const staff = await prisma.staff.findFirst({ where: { userId, schoolId }, select: { id: true } });
      if (!staff) return reply.status(404).send({ success: false, error: "STAFF_NOT_FOUND" });

      const { leaveTypeId, fromDate, toDate, totalDays, isHalfDay, halfDayType, reason } = parsed.data;

      const balance = await prisma.hrLeaveBalance.findFirst({ where: { staffId: staff.id, leaveTypeId } });
      const available = (balance?.totalDays ?? 0) - (balance?.usedDays ?? 0) - (balance?.pendingDays ?? 0);
      if (available < totalDays) {
        return reply.status(400).send({ success: false, error: "INSUFFICIENT_BALANCE",
          message: `Only ${available} days available` });
      }

      await prisma.$transaction(async (tx) => {
        await tx.hrLeaveApplication.create({
          data: { schoolId, staffId: staff.id, leaveTypeId,
            fromDate: new Date(fromDate), toDate: new Date(toDate),
            totalDays, isHalfDay: isHalfDay ?? false, halfDayType: halfDayType ?? null,
            reason, status: "PENDING", appliedAt: new Date() },
        });
        await tx.hrLeaveBalance.updateMany({
          where: { staffId: staff.id, leaveTypeId },
          data: { pendingDays: { increment: totalDays } },
        });
      });

      return reply.status(201).send({ success: true, message: "Leave application submitted" });
    }
  );
}