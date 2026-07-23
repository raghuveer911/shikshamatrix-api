// apps/api/src/routes/admin/hr/hr-payroll-api.ts
// Pure TypeScript — NO JSX, NO React, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminHrPayrollRoutes(app: FastifyInstance) {

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get("/admin/hr/payroll/dashboard", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [totalActive, assigned, unassigned, revisions, structures, recentRevisions] = await Promise.all([
        prisma.staff.count({ where: { schoolId, status: { in: ["ACTIVE", "PROBATION"] } } }),
        prisma.hrEmployeeSalaryProfile.count({ where: { staff: { schoolId } } }),
        prisma.staff.count({
          where: { schoolId, status: { in: ["ACTIVE", "PROBATION"] }, salaryProfile: null },
        }),
        prisma.hrSalaryRevision.count({ where: { staff: { schoolId } } }),
        prisma.hrSalaryStructure.count({ where: { schoolId, isActive: true } }),
        prisma.hrSalaryRevision.findMany({
          where:   { staff: { schoolId } },
          orderBy: { createdAt: "desc" },
          take:    8,
          include: { staff: { include: { user: { select: { name: true } } } } },
        }),
      ]);

      // Total gross payroll from all active salary profiles
      const grossAgg = await prisma.hrEmployeeSalaryProfile.aggregate({
        where: { staff: { schoolId, status: { in: ["ACTIVE", "PROBATION"] } } },
        _sum:  { grossSalary: true },
      });

      return reply.send({
        success: true,
        data: {
          kpis: {
            totalActive,
            assigned,
            unassigned,
            revisions,
            structures,
            totalGrossPayroll: grossAgg._sum.grossSalary ?? 0,
          },
          recentRevisions,
        },
      });
    }
  );

  // ─── SALARY STRUCTURES ────────────────────────────────────
  app.get("/admin/hr/payroll/structures", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const structures = await prisma.hrSalaryStructure.findMany({
        where:   { schoolId, isActive: true },
        orderBy: { name: "asc" },
        include: {
          components: { where: { isActive: true }, orderBy: { sortOrder: "asc" } },
          _count:     { select: { profiles: true } },
        },
      });
      return reply.send({ success: true, data: { structures } });
    }
  );

  app.post("/admin/hr/payroll/structures", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { name, description, isDefault } = req.body as {
        name: string; description?: string; isDefault?: boolean;
      };
      if (!name) return reply.status(400).send({ success: false, message: "name required." });

      if (isDefault) {
        await prisma.hrSalaryStructure.updateMany({
          where: { schoolId }, data: { isDefault: false },
        });
      }
      const s = await prisma.hrSalaryStructure.create({
        data: { schoolId, name, description: description ?? null, isDefault: isDefault ?? false },
      });
      return reply.status(201).send({ success: true, data: { id: s.id } });
    }
  );

  app.put("/admin/hr/payroll/structures/:id", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const body = req.body as any;
      if (body.isDefault) {
        await prisma.hrSalaryStructure.updateMany({ where: { schoolId }, data: { isDefault: false } });
      }
      await prisma.hrSalaryStructure.updateMany({ where: { id: parseInt(id), schoolId }, data: body });
      return reply.send({ success: true });
    }
  );

  app.delete("/admin/hr/payroll/structures/:id", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const inUse = await prisma.hrEmployeeSalaryProfile.count({ where: { structureId: parseInt(id) } });
      if (inUse > 0) {
        await prisma.hrSalaryStructure.updateMany({ where: { id: parseInt(id), schoolId }, data: { isActive: false } });
        return reply.send({ success: true, message: "Deactivated (assigned to employees)." });
      }
      await prisma.hrSalaryStructure.deleteMany({ where: { id: parseInt(id), schoolId } });
      return reply.send({ success: true });
    }
  );

  // ─── SALARY COMPONENTS ────────────────────────────────────
  app.post("/admin/hr/payroll/structures/:id/components", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const body = req.body as {
        name: string; code: string; type: string; calcType?: string;
        value: number; isActive?: boolean; sortOrder?: number;
      };
      if (!body.name || !body.code || !body.type) {
        return reply.status(400).send({ success: false, message: "name, code, type required." });
      }
      const c = await prisma.hrSalaryComponent.create({
        data: {
          structureId: parseInt(id),
          name:        body.name,
          code:        body.code.toUpperCase(),
          type:        body.type as any,
          calcType:    body.calcType as any ?? "FIXED",
          value:       body.value,
          isActive:    body.isActive ?? true,
          sortOrder:   body.sortOrder ?? 0,
        },
      });
      return reply.status(201).send({ success: true, data: { id: c.id } });
    }
  );

  app.put("/admin/hr/payroll/components/:id", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      await prisma.hrSalaryComponent.update({ where: { id: parseInt(id) }, data: req.body as any });
      return reply.send({ success: true });
    }
  );

  app.delete("/admin/hr/payroll/components/:id", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      await prisma.hrSalaryComponent.update({ where: { id: parseInt(id) }, data: { isActive: false } });
      return reply.send({ success: true });
    }
  );

  // ─── EMPLOYEE SALARY PROFILES ─────────────────────────────
  app.get("/admin/hr/payroll/profiles", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; search?: string; structureId?: string };
      const page  = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 20;
      const where: any = { staff: { schoolId } };
      if (q.structureId) where.structureId = parseInt(q.structureId);
      if (q.search) {
        where.staff = { ...where.staff, user: { name: { contains: q.search, mode: "insensitive" } } };
      }
      const [profiles, total] = await Promise.all([
        prisma.hrEmployeeSalaryProfile.findMany({
          where, skip: (page-1)*limit, take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            staff:     { include: { user: { select: { name: true, avatarUrl: true } }, departmentRef: { select: { name: true } }, designationRef: { select: { name: true } } } },
            structure: { select: { name: true } },
          },
        }),
        prisma.hrEmployeeSalaryProfile.count({ where }),
      ]);
      return reply.send({ success: true, data: { profiles, total, totalPages: Math.ceil(total / limit) } });
    }
  );

  app.post("/admin/hr/payroll/profiles", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as {
        staffId: number; structureId: number; ctc: number;
        basicSalary: number; grossSalary: number; effectiveFrom: string; notes?: string;
      };
      if (!body.staffId || !body.structureId || !body.ctc || !body.effectiveFrom) {
        return reply.status(400).send({ success: false, message: "staffId, structureId, ctc, effectiveFrom required." });
      }

      // Verify staff belongs to school
      const staff = await prisma.staff.findFirst({ where: { id: body.staffId, schoolId } });
      if (!staff) return reply.status(404).send({ success: false, message: "Staff not found." });

      const profile = await prisma.hrEmployeeSalaryProfile.upsert({
        where:  { staffId: body.staffId },
        update: {
          structureId:   body.structureId,
          ctc:           body.ctc,
          basicSalary:   body.basicSalary,
          grossSalary:   body.grossSalary,
          effectiveFrom: new Date(body.effectiveFrom),
          notes:         body.notes ?? null,
        },
        create: {
        schoolId,
        staffId: body.staffId,
        structureId: body.structureId,
        ctc: body.ctc,
        basicSalary: body.basicSalary,
        grossSalary: body.grossSalary,
        effectiveFrom: new Date(body.effectiveFrom),
        }
      });
      return reply.send({ success: true, data: { id: profile.id } });
    }
  );

  // ─── UNASSIGNED STAFF ─────────────────────────────────────
  app.get("/admin/hr/payroll/unassigned", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const staff = await prisma.staff.findMany({
        where:   { schoolId, status: { in: ["ACTIVE", "PROBATION"] }, salaryProfile: null },
        include: {
          user:        { select: { name: true, avatarUrl: true } },
          departmentRef:  { select: { name: true } },
          designationRef: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      return reply.send({ success: true, data: { staff, count: staff.length } });
    }
  );

  // ─── PAYROLL PREVIEW ──────────────────────────────────────
  app.get("/admin/hr/payroll/preview", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { month, year, departmentId } = req.query as { month: string; year: string; departmentId?: string };
      if (!month || !year) return reply.status(400).send({ success: false, message: "month and year required." });

      const m = parseInt(month);
      const y = parseInt(year);
      const daysInMonth = new Date(y, m, 0).getDate();
      const from = new Date(y, m - 1, 1);
      const to   = new Date(y, m - 1, daysInMonth);

      const where: any = { staff: { schoolId } };
      if (departmentId) where.staff = { ...where.staff, departmentId: parseInt(departmentId) };

      const profiles = await prisma.hrEmployeeSalaryProfile.findMany({
        where,
        include: {
          staff: {
            include: {
              user:        { select: { name: true } },
              departmentRef:  { select: { name: true } },
              designationRef: { select: { name: true } },
              attendances: {
                where: { date: { gte: from, lte: to } },
                select: { status: true },
              },
            },
          },
          structure: { include: { components: { where: { isActive: true } } } },
        },
      });

      const previews = profiles.map(p => {
        const perDay = p.grossSalary / daysInMonth;
        const present = p.staff.attendances.filter(a => ["PRESENT", "HALF_DAY"].includes(a.status)).length;
        const halfDays = p.staff.attendances.filter(a => a.status === "HALF_DAY").length;
        const absent  = p.staff.attendances.filter(a => a.status === "ABSENT").length;

        const earnings   = p.structure.components.filter(c => c.type === "EARNING");
        const deductions = p.structure.components.filter(c => c.type === "DEDUCTION");

        const totalEarnings = earnings.reduce((sum, c) => {
          return sum + (c.calcType === "PERCENTAGE" ? (p.basicSalary * c.value / 100) : c.value);
        }, 0);
        const totalDeductions = deductions.reduce((sum, c) => {
          return sum + (c.calcType === "PERCENTAGE" ? (p.basicSalary * c.value / 100) : c.value);
        }, 0);

        const absentDeduction = absent * perDay + halfDays * perDay * 0.5;
        const netSalary = totalEarnings - totalDeductions - absentDeduction;

        return {
          staffId:        p.staffId,
          name:           p.staff.user.name,
          departmentRef:     p.staff.departmentRef?.name ?? "—",
          designationRef:    p.staff.designationRef?.name ?? "—",
          grossSalary:    p.grossSalary,
          present,
          absent,
          halfDays,
          totalEarnings,
          totalDeductions,
          absentDeduction: Math.round(absentDeduction),
          netSalary:      Math.round(netSalary),
          components:     { earnings, deductions },
        };
      });

      const totalGross = previews.reduce((s, p) => s + p.grossSalary, 0);
      const totalNet   = previews.reduce((s, p) => s + p.netSalary, 0);

      return reply.send({
        success: true,
        data: {
          previews, month: m, year: y,
          summary: { totalStaff: previews.length, totalGross, totalNet, daysInMonth },
        },
      });
    }
  );

  // ─── SALARY REVISIONS ─────────────────────────────────────
  app.get("/admin/hr/payroll/revisions", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { staffId, type } = req.query as { staffId?: string; type?: string };
      const where: any = { staff: { schoolId } };
      if (staffId) where.staffId = parseInt(staffId);
      if (type)    where.type    = type;
      const revisions = await prisma.hrSalaryRevision.findMany({
        where, orderBy: { effectiveDate: "desc" },
        include: { staff: { include: { user: { select: { name: true } } } } },
      });
      return reply.send({ success: true, data: { revisions } });
    }
  );

  app.post("/admin/hr/payroll/revisions", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        staffId: number; type: string; effectiveDate: string;
        newCtc: number; newBasic: number; reason?: string;
      };
      if (!body.staffId || !body.type || !body.effectiveDate || !body.newCtc) {
        return reply.status(400).send({ success: false, message: "staffId, type, effectiveDate, newCtc required." });
      }
      const staff = await prisma.staff.findFirst({ where: { id: body.staffId, schoolId } });
      if (!staff) return reply.status(404).send({ success: false, message: "Staff not found." });

      const existing = await prisma.hrEmployeeSalaryProfile.findUnique({ where: { staffId: body.staffId } });

      const revision = await prisma.$transaction(async (tx) => {
        const rev = await tx.hrSalaryRevision.create({
          data: {
            staffId:       body.staffId,
            schoolId,
            type:          body.type as any,
            effectiveDate: new Date(body.effectiveDate),
            previousCtc:   existing?.ctc ?? 0,
            newCtc:        body.newCtc,
            previousBasic: existing?.basicSalary ?? 0,
            newBasic:      body.newBasic,
            reason:        body.reason ?? null,
            approvedById:  userId,
          },
        });
        if (existing) {
          await tx.hrEmployeeSalaryProfile.update({
            where: { staffId: body.staffId },
            data:  { ctc: body.newCtc, basicSalary: body.newBasic, grossSalary: body.newCtc * 0.8 },
          });
        }
        return rev;
      });
      return reply.status(201).send({ success: true, data: { id: revision.id } });
    }
  );

  // ─── PER-STAFF HISTORY ────────────────────────────────────
  app.get("/admin/hr/payroll/staff/:staffId/history", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { staffId } = req.params as { staffId: string };
      const [profile, revisions] = await Promise.all([
        prisma.hrEmployeeSalaryProfile.findUnique({
          where:   { staffId: parseInt(staffId) },
          include: { structure: { include: { components: { where: { isActive: true } } } } },
        }),
        prisma.hrSalaryRevision.findMany({
          where:   { staffId: parseInt(staffId), staff: { schoolId } },
          orderBy: { effectiveDate: "desc" },
        }),
      ]);
      return reply.send({ success: true, data: { profile, revisions } });
    }
  );

  // ─── SALARY REGISTER REPORT ───────────────────────────────
  app.get("/admin/hr/payroll/reports/salary-register", { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { departmentId } = req.query as { departmentId?: string };
      const where: any = { staff: { schoolId, status: { in: ["ACTIVE", "PROBATION"] } } };
      if (departmentId) where.staff.departmentId = parseInt(departmentId);
      const profiles = await prisma.hrEmployeeSalaryProfile.findMany({
        where,
        include: {
          staff: {
            include: {
              user:        { select: { name: true } },
              departmentRef:  { select: { name: true } },
              designationRef: { select: { name: true } },
            },
          },
          structure: { select: { name: true } },
        },
        orderBy: [{ staff: { departmentRef: { name: "asc" } } }],
      });
      return reply.send({
        success: true,
        data: { profiles, generatedAt: new Date().toISOString(), total: profiles.length },
      });
    }
  );
}
