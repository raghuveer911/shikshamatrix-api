// apps/api/src/routes/staff/profile-payroll.ts
//
// Payslip history + salary structure summary.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[profile/payroll] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function profilePayrollRoutes(app: FastifyInstance) {

  app.get("/profile/payroll",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const staff = await prisma.staff.findFirst({ where: { userId, schoolId }, select: { id: true } });
      if (!staff) return reply.status(404).send({ success: false, error: "STAFF_NOT_FOUND" });

      const [salaryProfile, revisions] = await Promise.all([
        safe("hrEmployeeSalaryProfile.findUnique", () =>
          prisma.hrEmployeeSalaryProfile.findUnique({
            where: { staffId: staff.id },
            select: { ctc: true, basicSalary: true, grossSalary: true, effectiveFrom: true },
          }), null),
        // NOTE: HR's payroll system tracks salary structure/revision history,
        // not month-by-month payroll runs with payslip PDFs — that concept
        // doesn't exist yet on this side. Showing revision history as the
        // closest available substitute until a payslip-generation flow is
        // built into the HR payroll module.
        safe("hrSalaryRevision.findMany", () =>
          prisma.hrSalaryRevision.findMany({
            where: { schoolId, staffId: staff.id },
            orderBy: { effectiveDate: "desc" }, take: 12,
            select: {
              id: true, type: true, effectiveDate: true,
              previousCtc: true, newCtc: true, previousBasic: true, newBasic: true, reason: true,
            },
          }), [] as any[]),
      ]);

      return reply.send({
        success: true,
        data: { salaryProfile, revisions, payslips: [] },
      });
    }
  );
}