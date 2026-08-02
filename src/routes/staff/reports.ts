import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log("[staff/reports] category failed:", err?.message ?? err); return fallback; }
}

export async function staffReportsRoutes(app: FastifyInstance) {
  const P = "/staff/reports";

  // ── GET /staff/reports/overview ─────────────────────────
  // Returns headline stats for every category this school actually has
  // data for. No capability gate on the endpoint itself — the FRONTEND
  // decides which category cards to render based on the staff member's
  // own role (ROLE_MODULES), so a Librarian's app just never asks for
  // "finance" in the first place. Categories the school doesn't use (or
  // whose tables error out) silently return null rather than failing
  // the whole response.
  app.get(`${P}/overview`, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const [students, academics, finance, accounts, hr, library, inventory, transport, hostel] = await Promise.all([
        safe(async () => {
          const [total, active] = await Promise.all([
            prisma.student.count({ where: { schoolId } }),
            prisma.student.count({ where: { schoolId, isActive: true } }),
          ]);
          return { total, active };
        }, null),

        safe(async () => {
          const [classCount, staffCount] = await Promise.all([
            prisma.class.count({ where: { schoolId } }),
            prisma.staff.count({ where: { schoolId, isActive: true, user: { role: "TEACHER" } } }),
          ]);
          return { classes: classCount, teachers: staffCount };
        }, null),

        safe(async () => {
          const [monthAgg, dueAgg] = await Promise.all([
            prisma.feeReceipt.aggregate({ where: { schoolId, isVoid: false, createdAt: { gte: monthStart } }, _sum: { amount: true } }),
            prisma.studentFeeInstallment.aggregate({ where: { schoolId, status: { in: ["PENDING", "PARTIAL", "OVERDUE"] }, studentPlan: { isActive: true } }, _sum: { dueAmount: true, paidAmount: true } }),
          ]);
          return {
            monthCollection: Number(monthAgg._sum.amount ?? 0),
            totalDue: Math.max(0, Number(dueAgg._sum.dueAmount ?? 0) - Number(dueAgg._sum.paidAmount ?? 0)),
          };
        }, null),

        safe(async () => {
          const [pendingReim, pendingLoans] = await Promise.all([
            prisma.reimbursement.count({ where: { schoolId, status: { in: ["SUBMITTED", "UNDER_REVIEW"] } } }),
            prisma.staffLoan.count({ where: { schoolId, status: "PENDING" } }),
          ]);
          return { pendingReimbursements: pendingReim, pendingLoans };
        }, null),

        safe(async () => {
          const [totalStaff, presentToday, pendingLeaves] = await Promise.all([
            prisma.staff.count({ where: { schoolId, isActive: true } }),
            prisma.staffAttendance.count({ where: { schoolId, date: todayStart, status: "PRESENT" } }),
            prisma.hrLeaveApplication.count({ where: { schoolId, status: "PENDING" } }),
          ]);
          return { totalStaff, presentToday, pendingLeaves };
        }, null),

        safe(async () => {
          const [totalBooks, issuedCopies, overdueCount] = await Promise.all([
            prisma.libBook.count({ where: { schoolId, isActive: true } }),
            prisma.libBookCopy.count({ where: { schoolId, status: "ISSUED" } }),
            prisma.libIssue.count({ where: { schoolId, status: "ACTIVE", dueDate: { lt: now } } }),
          ]);
          return { totalBooks, issuedCopies, overdueCount };
        }, null),

        safe(async () => {
          const stocks = await prisma.invStock.findMany({ where: { schoolId }, include: { item: { select: { isActive: true, minimumLevel: true } } } });
          const totalItems = await prisma.invItem.count({ where: { schoolId, isActive: true } });
          const lowStockCount = stocks.filter((s) => s.item.isActive && s.item.minimumLevel > 0 && s.quantity <= s.item.minimumLevel).length;
          return { totalItems, lowStockCount };
        }, null),

        safe(async () => {
          const [totalVehicles, totalRoutes] = await Promise.all([
            prisma.transportVehicle.count({ where: { schoolId, isActive: true } }),
            prisma.transportRoute.count({ where: { schoolId, isActive: true } }),
          ]);
          return { totalVehicles, totalRoutes };
        }, null),

        safe(async () => {
          const bedAgg = await prisma.hostel.aggregate({ where: { schoolId, isActive: true }, _sum: { totalBeds: true, occupiedBeds: true } });
          return { totalBeds: bedAgg._sum.totalBeds ?? 0, occupiedBeds: bedAgg._sum.occupiedBeds ?? 0 };
        }, null),
      ]);

      return reply.send({
        success: true,
        data: { students, academics, finance, accounts, hr, library, inventory, transport, hostel },
      });
    }
  );
}
