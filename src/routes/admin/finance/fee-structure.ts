// apps/api/src/routes/admin/fee-structure.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminFeeStructureRoutes(app: FastifyInstance) {

  // ─── FEE GROUPS ────────────────────────────────────────────

  app.get("/admin/fee-groups", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const groups = await prisma.feeGroup.findMany({ where: { schoolId, isActive: true }, orderBy: { sortOrder: "asc" }, include: { _count: { select: { plans: true } } } });
      return reply.send({ success: true, data: { groups } });
    }
  );

  app.post("/admin/fee-groups", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { name, description, sortOrder } = req.body as { name: string; description?: string; sortOrder?: number };
      if (!name?.trim()) return reply.status(400).send({ success: false, message: "Name required." });
      const g = await prisma.feeGroup.create({ data: { schoolId, name: name.trim(), description: description ?? null, sortOrder: sortOrder ?? 1 } });
      return reply.status(201).send({ success: true, data: { id: g.id } });
    }
  );

  app.put("/admin/fee-groups/:id", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const body = req.body as { name?: string; description?: string; isActive?: boolean; sortOrder?: number };
      await prisma.feeGroup.updateMany({ where: { id: parseInt(id), schoolId }, data: body });
      return reply.send({ success: true });
    }
  );

  // ─── FEE PLANS ─────────────────────────────────────────────

  app.get("/admin/fee-plans", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { academicYearId?: string; status?: string; groupId?: string };
      const where: any = { schoolId };
      if (q.academicYearId) where.academicYearId = parseInt(q.academicYearId);
      if (q.status)         where.status         = q.status;
      if (q.groupId)        where.groupId        = parseInt(q.groupId);
      const plans = await prisma.feePlan.findMany({ where, orderBy: { createdAt: "desc" },
        include: { group: true, academicYear: true, _count: { select: { heads: true, installments: true, studentPlans: true } }, createdBy: { select: { name: true } } } });
      return reply.send({ success: true, data: { plans } });
    }
  );

  app.get("/admin/fee-plans/:id", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const plan = await prisma.feePlan.findFirst({ where: { id: parseInt(id), schoolId },
        include: { group: true, academicYear: true, heads: { orderBy: { sortOrder: "asc" } }, installments: { orderBy: { installmentNo: "asc" } }, _count: { select: { studentPlans: true } }, createdBy: { select: { name: true } } } });
      if (!plan) return reply.status(404).send({ success: false, message: "Fee plan not found." });
      return reply.send({ success: true, data: { plan } });
    }
  );

  app.post("/admin/fee-plans", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        name: string; description?: string; groupId?: number; academicYearId: number;
        applicableClasses?: number[]; effectiveFrom?: string;
        heads: { name: string; category: string; amount: number; frequency: string; isOptional?: boolean; sortOrder?: number; description?: string }[];
        installments?: { name: string; installmentNo: number; dueDate: string; amount: number; lateFineMode?: string; lateFineValue?: number; lateFineDays?: number }[];
      };

      if (!body.name?.trim() || !body.academicYearId || !body.heads?.length) {
        return reply.status(400).send({ success: false, message: "name, academicYearId and heads required." });
      }

      const totalAmount = body.heads.reduce((s, h) => s + h.amount, 0);

      const plan = await prisma.feePlan.create({ data: {
        schoolId, createdById: userId,
        name: body.name.trim(), description: body.description ?? null,
        groupId: body.groupId ?? null, academicYearId: body.academicYearId,
        applicableClasses: body.applicableClasses ?? [],
        totalAmount, effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null,
        status: "DRAFT",
        heads: {
          create: body.heads.map(h => ({
            schoolId, name: h.name, category: h.category as any,
            amount: h.amount, frequency: h.frequency as any,
            isOptional: h.isOptional ?? false, isMandatory: !h.isOptional,
            sortOrder: h.sortOrder ?? 1, description: h.description ?? null,
          })),
        },
        ...(body.installments?.length ? {
          installments: {
            create: body.installments.map(i => ({
              schoolId, name: i.name, installmentNo: i.installmentNo,
              dueDate: new Date(i.dueDate), amount: i.amount,
              lateFineMode: i.lateFineMode as any ?? "NONE",
              lateFineValue: i.lateFineValue ?? 0, lateFineDays: i.lateFineDays ?? 0,
            })),
          },
        } : {}),
      }});

      return reply.status(201).send({ success: true, message: "Fee plan created.", data: { id: plan.id } });
    }
  );

  app.put("/admin/fee-plans/:id", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const body = req.body as { name?: string; description?: string; status?: string; applicableClasses?: number[]; effectiveFrom?: string };
      const data: any = {};
      if (body.name)              data.name              = body.name;
      if (body.description)       data.description       = body.description;
      if (body.status)            data.status            = body.status;
      if (body.applicableClasses) data.applicableClasses = body.applicableClasses;
      if (body.effectiveFrom)     data.effectiveFrom     = new Date(body.effectiveFrom);
      await prisma.feePlan.updateMany({ where: { id: parseInt(id), schoolId }, data });
      return reply.send({ success: true, message: "Fee plan updated." });
    }
  );

  // ─── UPDATE HEADS ──────────────────────────────────────────

  app.put("/admin/fee-plans/:planId/heads", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { planId } = req.params as { planId: string };
      const { heads } = req.body as { heads: { id?: number; name: string; category: string; amount: number; frequency: string; isOptional?: boolean; sortOrder?: number }[] };
      await prisma.feePlanHead.deleteMany({ where: { planId: parseInt(planId), schoolId } });
      await prisma.feePlanHead.createMany({ data: heads.map(h => ({ planId: parseInt(planId), schoolId, name: h.name, category: h.category as any, amount: h.amount, frequency: h.frequency as any, isOptional: h.isOptional ?? false, isMandatory: !h.isOptional, sortOrder: h.sortOrder ?? 1 })) });
      const totalAmount = heads.reduce((s, h) => s + h.amount, 0);
      await prisma.feePlan.updateMany({ where: { id: parseInt(planId), schoolId }, data: { totalAmount } });
      return reply.send({ success: true, message: "Fee heads updated." });
    }
  );

  // ─── UPDATE INSTALLMENTS ───────────────────────────────────

  app.put("/admin/fee-plans/:planId/installments", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { planId } = req.params as { planId: string };
      const { installments } = req.body as { installments: { name: string; installmentNo: number; dueDate: string; amount: number; lateFineMode?: string; lateFineValue?: number; lateFineDays?: number }[] };
      await prisma.feePlanInstallment.deleteMany({ where: { planId: parseInt(planId), schoolId } });
      await prisma.feePlanInstallment.createMany({ data: installments.map(i => ({ planId: parseInt(planId), schoolId, name: i.name, installmentNo: i.installmentNo, dueDate: new Date(i.dueDate), amount: i.amount, lateFineMode: i.lateFineMode as any ?? "NONE", lateFineValue: i.lateFineValue ?? 0, lateFineDays: i.lateFineDays ?? 0 })) });
      return reply.send({ success: true, message: "Installments updated." });
    }
  );

  // ─── CLONE PLAN ────────────────────────────────────────────

  app.post("/admin/fee-plans/:id/clone", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any; const { id } = req.params as { id: string };
      const { newName, newAcademicYearId } = req.body as { newName: string; newAcademicYearId: number };

      const source = await prisma.feePlan.findFirst({ where: { id: parseInt(id), schoolId }, include: { heads: true, installments: true } });
      if (!source) return reply.status(404).send({ success: false, message: "Source plan not found." });

      const cloned = await prisma.feePlan.create({ data: {
        schoolId, createdById: userId, clonedFromId: source.id,
        name: newName ?? `${source.name} (Copy)`, description: source.description,
        groupId: source.groupId, academicYearId: newAcademicYearId ?? source.academicYearId,
        applicableClasses: source.applicableClasses, totalAmount: source.totalAmount,
        status: "DRAFT", effectiveFrom: source.effectiveFrom,
        heads: { create: source.heads.map(h => ({ schoolId, name: h.name, category: h.category, amount: h.amount, frequency: h.frequency, isOptional: h.isOptional, isMandatory: h.isMandatory, sortOrder: h.sortOrder, description: h.description })) },
        installments: { create: source.installments.map(i => ({ schoolId, name: i.name, installmentNo: i.installmentNo, dueDate: i.dueDate, amount: i.amount, lateFineMode: i.lateFineMode, lateFineValue: i.lateFineValue, lateFineDays: i.lateFineDays })) },
      }});

      return reply.status(201).send({ success: true, message: "Fee plan cloned.", data: { id: cloned.id } });
    }
  );

  // ─── PUBLISH PLAN ──────────────────────────────────────────

  app.patch("/admin/fee-plans/:id/publish", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const plan = await prisma.feePlan.findFirst({ where: { id: parseInt(id), schoolId }, include: { _count: { select: { heads: true, installments: true } } } });
      if (!plan) return reply.status(404).send({ success: false, message: "Not found." });
      if (plan._count.heads === 0) return reply.status(400).send({ success: false, message: "Add at least one fee head before publishing." });
      await prisma.feePlan.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "ACTIVE" } });
      return reply.send({ success: true, message: "Fee plan published and is now active." });
    }
  );

  // ─── ASSIGN PLAN TO STUDENTS ───────────────────────────────

  app.post("/admin/fee-plans/:id/assign", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const { classIds, academicYearId } = req.body as { classIds?: number[]; academicYearId: number };

      const plan = await prisma.feePlan.findFirst({ where: { id: parseInt(id), schoolId }, include: { installments: true } });
      if (!plan) return reply.status(404).send({ success: false, message: "Plan not found." });

      // Find eligible students
      const students = await prisma.student.findMany({ where: { schoolId, isActive: true, ...(classIds?.length ? { classId: { in: classIds } } : {}) } });
      let assigned = 0;

      for (const student of students) {
        // A student should only ever have ONE active fee plan per academic
        // year — deactivate any other active assignment first (e.g. an
        // older/now-archived plan) so Collect Fees and the Student Ledger
        // always resolve to the plan just assigned, not a stale one.
        // This must run BEFORE the "already has this plan" check below,
        // otherwise re-running Assign for a plan that was tried before
        // (already has a row) would silently skip fixing the old one.
        await prisma.studentFeePlan.updateMany({
          where: { studentId: student.id, academicYearId, isActive: true, planId: { not: parseInt(id) } },
          data: { isActive: false },
        });

        const existing = await prisma.studentFeePlan.findFirst({ where: { studentId: student.id, planId: parseInt(id) } });
        if (existing) {
          if (!existing.isActive) {
            await prisma.studentFeePlan.update({ where: { id: existing.id }, data: { isActive: true } });
            assigned++;
          }
          continue;
        }

        const sfp = await prisma.studentFeePlan.create({ data: { schoolId, studentId: student.id, planId: parseInt(id), academicYearId, totalAmount: plan.totalAmount, paidAmount: 0, discountAmount: 0, fineAmount: 0, dueAmount: plan.totalAmount } });

        // Create installment records for this student
        if (plan.installments.length > 0) {
          await prisma.studentFeeInstallment.createMany({ data: plan.installments.map(inst => ({ schoolId, studentPlanId: sfp.id, installmentId: inst.id, studentId: student.id, dueAmount: inst.amount, paidAmount: 0, fineAmount: 0, discountAmount: 0, dueDate: inst.dueDate, status: "PENDING" as any })) });
        }
        assigned++;
      }

      return reply.send({ success: true, message: `Plan assigned to ${assigned} students.`, data: { assigned } });
    }
  );

  // ─── DELETE (archive) PLAN ─────────────────────────────────
  app.delete("/admin/fee-plans/:id", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      await prisma.feePlan.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "ARCHIVED" } });
      // A student shouldn't still show an active plan that's now archived
      // just because they were never re-assigned to something new.
      await prisma.studentFeePlan.updateMany({ where: { planId: parseInt(id), schoolId, isActive: true }, data: { isActive: false } });
      return reply.send({ success: true, message: "Plan archived." });
    }
  );

  // ─── PURGE (hard-delete) an ARCHIVED plan ──────────────────
  // Only allowed when NO payment was ever collected against it — a
  // plan with real payment history must stay archived, never deleted,
  // so receipts/ledgers/audit trails always resolve correctly.
  app.delete("/admin/fee-plans/:id/purge", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const planId = parseInt(id);

      const plan = await prisma.feePlan.findFirst({ where: { id: planId, schoolId } });
      if (!plan) return reply.status(404).send({ success: false, message: "Plan not found." });
      if (plan.status !== "ARCHIVED") {
        return reply.status(400).send({ success: false, message: "Archive the plan first before deleting it completely." });
      }

      const paidCount = await prisma.studentFeeInstallment.count({
        where: { studentPlan: { planId }, paidAmount: { gt: 0 } },
      });
      if (paidCount > 0) {
        return reply.status(409).send({
          success: false,
          message: `This plan has payment history (${paidCount} paid installment${paidCount > 1 ? "s" : ""}) — it can't be fully deleted, only archived, to keep receipts and ledgers accurate.`,
        });
      }

      const affectedStudents = await prisma.studentFeePlan.count({ where: { planId, schoolId } });

      await prisma.$transaction(async (tx) => {
        // StudentFeeInstallment cascades automatically when its
        // StudentFeePlan is deleted (see schema onDelete: Cascade).
        await tx.studentFeePlan.deleteMany({ where: { planId, schoolId } });
        // FeePlanHead / FeePlanInstallment cascade automatically when
        // FeePlan itself is deleted.
        await tx.feePlan.delete({ where: { id: planId } });
      });

      return reply.send({
        success: true,
        message: `Plan and ${affectedStudents} student assignment${affectedStudents === 1 ? "" : "s"} permanently deleted.`,
      });
    }
  );

  // ─── GET /admin/fee-plans/:id/student-assignments ─────────

  app.get("/admin/fee-plans/:id/student-assignments", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const q = req.query as { page?: string; classId?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { planId: parseInt(id), schoolId };
      if (q.classId) where.student = { classId: parseInt(q.classId) };
      const [assignments, total] = await Promise.all([
        prisma.studentFeePlan.findMany({ where, skip: (page-1)*limit, take: limit,
          include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, installments: { include: { installment: true } } } }),
        prisma.studentFeePlan.count({ where }),
      ]);
      return reply.send({ success: true, data: { assignments, total, totalPages: Math.ceil(total/limit) } });
    }
  );
}
