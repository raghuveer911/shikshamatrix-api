import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";

export async function hrStaffRoutes(app: FastifyInstance) {

  // ── GET /hr/staff — Staff list ──────────────────────────────
  app.get("/hr/staff",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { search, departmentId, employeeType, page = "1" } =
        req.query as Record<string, string>;

      const skip = (parseInt(page) - 1) * 30;

      const where: any = {
        schoolId,
        isActive: true,
        ...(departmentId ? { departmentId: parseInt(departmentId) } : {}),
        ...(employeeType ? { employeeType } : {}),
        ...(search ? {
          OR: [
            { user:        { name: { contains: search, mode: "insensitive" } } },
            { employeeId:  { contains: search, mode: "insensitive" } },
            { user:        { phone: { contains: search } } },
          ],
        } : {}),
      };

      const [staff, total] = await Promise.all([
        prisma.staff.findMany({
          where,
          skip,
          take: 30,
          orderBy: { user: { name: "asc" } },
          select: {
            id:           true,
            employeeId:   true,
            employeeType: true,
            joinDate:     true,
            user: {
              select: { name: true, phone: true, email: true, gender: true, avatarUrl: true },
            },
            departmentRef:  { select: { name: true } },
            designationRef: { select: { name: true } },
            role:           true,
          },
        }),
        prisma.staff.count({ where }),
      ]);

      // Departments for filter
      const departments = await prisma.department.findMany({
        where:   { schoolId, isActive: true },
        select:  { id: true, name: true },
        orderBy: { name: "asc" },
      });

      return reply.send({
        success: true,
        data: {
          staff: staff.map((s) => ({
            id:           s.id,
            employeeId:   s.employeeId,
            employeeType: s.employeeType,
            joinDate:     s.joinDate,
            name:         s.user.name,
            phone:        s.user.phone,
            email:        s.user.email,
            gender:       s.user.gender,
            avatarUrl:    s.user.avatarUrl,
            department:   s.departmentRef?.name ?? "—",
            designation:  s.designationRef?.name ?? "—",
            role:         s.role,
          })),
          departments,
          pagination: {
            total,
            page:       parseInt(page),
            totalPages: Math.ceil(total / 30),
          },
        },
      });
    }
  );

  // ── GET /hr/staff/:id — Staff profile ───────────────────────
  app.get("/hr/staff/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };

      const staff = await prisma.staff.findFirst({
        where: { id: parseInt(id), schoolId },
        select: {
          id:           true,
          employeeId:   true,
          employeeType: true,
          joinDate:     true,
          isActive:     true,
          role:         true,
          user: {
            select: {
              name: true, phone: true, email: true,
              gender: true, avatarUrl: true,
            },
          },
          departmentRef:  { select: { name: true } },
          designationRef: { select: { name: true } },
          // Leave balance
          leaveBalances: {
            select: {
              totalDays:   true,
              usedDays:    true,
              pendingDays: true,
              leaveType:   { select: { name: true, color: true } },
            },
          },
          // Active contract
          contracts: {
            where:   { status: "ACTIVE" },
            select:  { contractType: true, startDate: true, endDate: true, status: true },
            take:    1,
          },
          // Salary profile
          salaryProfile: {
            select: {
              basicSalary: true,
              grossSalary: true,
              ctc:         true,
              effectiveFrom: true,
            },
          },
        },
      });

      if (!staff) {
        return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      }

      return reply.send({ success: true, data: { staff } });
    }
  );
}