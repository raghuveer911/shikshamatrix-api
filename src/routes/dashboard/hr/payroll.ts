import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";

export async function hrPayrollRoutes(app: FastifyInstance) {

  // ── GET /hr/payroll — Staff salary list (view only) ─────────
  app.get("/hr/payroll",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { departmentId, page = "1" } = req.query as Record<string, string>;

      const skip = (parseInt(page) - 1) * 30;

      const profiles = await prisma.hrEmployeeSalaryProfile.findMany({
        where: {
          staff: {
            schoolId,
            isActive: true,
            ...(departmentId ? { departmentId: parseInt(departmentId) } : {}),
          },
        },
        skip,
        take: 30,
        select: {
          id:           true,
          basicSalary:  true,
          grossSalary:  true,
          ctc:          true,
          effectiveFrom: true,
          structure: { select: { name: true } },
          staff: {
            select: {
              id:           true,
              employeeId:   true,
              employeeType: true,
              user:           { select: { name: true, avatarUrl: true } },
              departmentRef:  { select: { name: true } },
              designationRef: { select: { name: true } },
            },
          },
        },
      });

      const total = await prisma.hrEmployeeSalaryProfile.count({
        where: {
          staff: { schoolId, isActive: true },
        },
      });

      return reply.send({
        success: true,
        data: {
          profiles: profiles.map((p) => ({
            id:           p.id,
            basicSalary:  p.basicSalary,
            grossSalary:  p.grossSalary,
            ctc:          p.ctc,
            effectiveFrom: p.effectiveFrom,
            structure:    p.structure.name,
            staffId:      p.staff.id,
            employeeId:   p.staff.employeeId,
            employeeType: p.staff.employeeType,
            name:         p.staff.user.name,
            avatarUrl:    p.staff.user.avatarUrl,
            department:   p.staff.departmentRef?.name ?? "—",
            designation:  p.staff.designationRef?.name ?? "—",
          })),
          pagination: {
            total,
            page:       parseInt(page),
            totalPages: Math.ceil(total / 30),
          },
        },
      });
    }
  );
}