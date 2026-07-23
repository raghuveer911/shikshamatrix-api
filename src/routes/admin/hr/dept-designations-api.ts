// apps/api/src/routes/admin/hr/dept-designations-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminDeptDesignationsRoutes(app: FastifyInstance) {

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get("/admin/hr/dept/dashboard", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [totalDepts, totalDesigs, activeStaff, vacantCount, deptWise, recentTransfers] =
        await Promise.all([
          prisma.department.count({ where: { schoolId, isActive: true } }),
          prisma.designation.count({ where: { schoolId, isActive: true } }),
          prisma.staff.count({ where: { schoolId, isActive: true } }),
          prisma.hrVacantPosition.count({ where: { schoolId, status: "OPEN" } }),
          prisma.department.findMany({
            where: { schoolId, isActive: true },
            include: { _count: { select: { staffMembers: true } } },
            orderBy: { name: "asc" },
          }),
          prisma.hrStaffTransfer.findMany({
            where: { schoolId },
            orderBy: { createdAt: "desc" },
            take: 5,
            include: {
              staff: { include: { user: { select: { name: true } } } },
              fromDept: { select: { name: true } },
            },
          }),
        ]);

      return rep.send({
        totalDepts, totalDesigs, activeStaff, vacantCount,
        deptWise, recentTransfers,
      });
    }
  );

  // ─── DEPARTMENTS CRUD ─────────────────────────────────────
  app.get("/admin/hr/dept/departments", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const depts = await prisma.department.findMany({
        where: {
          schoolId,
          ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}),
          ...(q.status === "active" ? { isActive: true } : q.status === "inactive" ? { isActive: false } : {}),
        },
        include: {
          _count: { select: { staffMembers: true, designations: true } },
          headUser: { select: { name: true } },
        },
        orderBy: { name: "asc" },
      });
      return rep.send({ depts });
    }
  );

  app.post("/admin/hr/dept/departments", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const dept = await prisma.department.create({
        data: {
          schoolId,
          name: b.name,
          code: b.code ?? null,
          description: b.description ?? null,
          headUserId: b.headUserId ? Number(b.headUserId) : null,
        },
      });
      return rep.send({ dept });
    }
  );

  app.put("/admin/hr/dept/departments/:id", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const dept = await prisma.department.update({
        where: { id, schoolId },
        data: {
          name: b.name,
          code: b.code ?? null,
          description: b.description ?? null,
          headUserId: b.headUserId ? Number(b.headUserId) : null,
          isActive: b.isActive !== undefined ? b.isActive : undefined,
        },
      });
      return rep.send({ dept });
    }
  );

  app.delete("/admin/hr/dept/departments/:id", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.department.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─── DESIGNATIONS CRUD ────────────────────────────────────
  app.get("/admin/hr/dept/designations", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const desigs = await prisma.designation.findMany({
        where: {
          schoolId,
          ...(q.deptId ? { departmentId: Number(q.deptId) } : {}),
          ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}),
          ...(q.status === "active" ? { isActive: true } : q.status === "inactive" ? { isActive: false } : {}),
        },
        include: {
          department: { select: { name: true } },
          _count: { select: { staffMembers: true } },
        },
        orderBy: { name: "asc" },
      });
      return rep.send({ desigs });
    }
  );

  app.post("/admin/hr/dept/designations", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const desig = await prisma.designation.create({
        data: {
          schoolId,
          name: b.name,
          departmentId: b.departmentId ? Number(b.departmentId) : null,
          employeeType: b.employeeType ?? "TEACHING",
        },
      });
      return rep.send({ desig });
    }
  );

  app.put("/admin/hr/dept/designations/:id", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const desig = await prisma.designation.update({
        where: { id, schoolId },
        data: {
          name: b.name,
          departmentId: b.departmentId ? Number(b.departmentId) : null,
          employeeType: b.employeeType,
          isActive: b.isActive !== undefined ? b.isActive : undefined,
        },
      });
      return rep.send({ desig });
    }
  );

  app.delete("/admin/hr/dept/designations/:id", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.designation.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─── STAFF MAPPING ────────────────────────────────────────
  app.get("/admin/hr/dept/staff-mapping", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const staff = await prisma.staff.findMany({
        where: {
          schoolId,
          isActive: true,
          ...(q.deptId ? { departmentId: Number(q.deptId) } : {}),
          ...(q.desigId ? { designationId: Number(q.desigId) } : {}),
        },
        include: {
          user: { select: { name: true, avatarUrl: true, email: true } },
          departmentRef: { select: { name: true } },
          designationRef: { select: { name: true } },
        },
        orderBy: { joinDate: "desc" },
      });
      return rep.send({ staff });
    }
  );

  // ─── ORG CHART ────────────────────────────────────────────
  app.get("/admin/hr/dept/org-chart", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const depts = await prisma.department.findMany({
        where: { schoolId, isActive: true },
        include: {
          headUser: { select: { name: true } },
          designations: {
            where: { isActive: true },
            include: { _count: { select: { staffMembers: true } } },
          },
          _count: { select: { staffMembers: true } },
        },
        orderBy: { name: "asc" },
      });
      return rep.send({ depts });
    }
  );

  // ─── VACANT POSITIONS ─────────────────────────────────────
  app.get("/admin/hr/dept/vacancies", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const vacancies = await prisma.hrVacantPosition.findMany({
        where: {
          schoolId,
          ...(q.status ? { status: q.status } : {}),
          ...(q.deptId ? { departmentId: Number(q.deptId) } : {}),
        },
        include: {
          department: { select: { name: true } },
          designation: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ vacancies });
    }
  );

  app.post("/admin/hr/dept/vacancies", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const vacancy = await prisma.hrVacantPosition.create({
        data: {
          schoolId,
          departmentId: Number(b.departmentId),
          designationId: Number(b.designationId),
          openings: Number(b.openings ?? 1),
          description: b.description ?? null,
          status: "OPEN",
        },
      });
      return rep.send({ vacancy });
    }
  );

  app.put("/admin/hr/dept/vacancies/:id", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const vacancy = await prisma.hrVacantPosition.update({
        where: { id, schoolId },
        data: {
          openings: b.openings ? Number(b.openings) : undefined,
          description: b.description,
          status: b.status,
          filledCount: b.filledCount !== undefined ? Number(b.filledCount) : undefined,
        },
      });
      return rep.send({ vacancy });
    }
  );

  // ─── TRANSFERS ────────────────────────────────────────────
  app.get("/admin/hr/dept/transfers", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const transfers = await prisma.hrStaffTransfer.findMany({
        where: {
          schoolId,
          ...(q.status ? { status: q.status as any } : {}),
        },
        include: {
          staff: { include: { user: { select: { name: true, avatarUrl: true } } } },
          fromDept: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ transfers });
    }
  );

  app.post("/admin/hr/dept/transfers", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const transfer = await prisma.hrStaffTransfer.create({
        data: {
          schoolId,
          staffId: Number(b.staffId),
          fromDeptId: Number(b.fromDeptId),
          toDeptId: Number(b.toDeptId),
          designationId: b.designationId ? Number(b.designationId) : null,
          reason: b.reason,
          effectiveDate: new Date(b.effectiveDate),
          status: "PENDING",
        },
      });
      return rep.send({ transfer });
    }
  );

  app.post("/admin/hr/dept/transfers/:id/approve", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const transfer = await prisma.hrStaffTransfer.update({
        where: { id, schoolId },
        data: { status: "APPROVED", approvedById: Number(userId), approvedAt: new Date() },
      });
      // Update staff department
      await prisma.staff.update({
        where: { id: transfer.staffId },
        data: {
          departmentId: transfer.toDeptId,
          ...(transfer.designationId ? { designationId: transfer.designationId } : {}),
        },
      });
      await prisma.hrStaffTransfer.update({ where: { id }, data: { status: "COMPLETED" } });
      return rep.send({ ok: true });
    }
  );

  app.post("/admin/hr/dept/transfers/:id/reject", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      await prisma.hrStaffTransfer.update({
        where: { id, schoolId },
        data: { status: "REJECTED", remarks: b.remarks ?? null },
      });
      return rep.send({ ok: true });
    }
  );
}
