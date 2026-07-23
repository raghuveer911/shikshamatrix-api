// apps/api/src/routes/admin/discounts-scholarships.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminDiscountsRoutes(app: FastifyInstance) {

  // ─── DASHBOARD ─────────────────────────────────────────────
  app.get("/admin/discounts/dashboard", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [activeDiscounts, activeScholarships, totalBenefitVal, pendingApprovals,
             byCategory, recentApprovals, programsWithCounts] = await Promise.all([
        prisma.feeDiscount.count({ where: { schoolId, isActive: true } }),
        prisma.studentScholarship.count({ where: { schoolId, isActive: true, status: "APPROVED" } }),
        prisma.feeDiscount.aggregate({ where: { schoolId, isActive: true }, _sum: { value: true } }),
        prisma.studentScholarship.count({ where: { schoolId, status: "PENDING" } }),
        prisma.feeDiscount.groupBy({ by: ["category"], where: { schoolId, isActive: true }, _count: true, _sum: { value: true } }),
        prisma.studentScholarship.findMany({ where: { schoolId, status: "APPROVED" }, orderBy: { approvedAt: "desc" }, take: 8, include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, program: { select: { name: true } } } }),
        prisma.scholarshipProgram.findMany({ where: { schoolId, status: "ACTIVE" }, include: { _count: { select: { studentScholarships: true } } }, orderBy: { filledSeats: "desc" }, take: 5 }),
      ]);

      const totalBenefitScholar = await prisma.studentScholarship.aggregate({ where: { schoolId, isActive: true, status: "APPROVED" }, _sum: { benefitAmount: true } });

      return reply.send({ success: true, data: {
        kpi: {
          activeDiscounts,
          scholarshipStudents: activeScholarships,
          totalBenefitsGiven:  Number(totalBenefitVal._sum.value ?? 0) + Number(totalBenefitScholar._sum.benefitAmount ?? 0),
          pendingApprovals,
        },
        byCategory: byCategory.map(b => ({ category: b.category, count: b._count, totalValue: Number(b._sum.value ?? 0) })).sort((a,b) => b.totalValue - a.totalValue),
        recentApprovals,
        programs: programsWithCounts,
      }});
    }
  );

  // ─── DISCOUNTS CRUD ────────────────────────────────────────
  app.get("/admin/discounts", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; category?: string; search?: string; isActive?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.category)             where.category = q.category;
      if (q.isActive !== undefined) where.isActive = q.isActive === "true";
      if (q.search) where.OR = [
        { name: { contains: q.search, mode: "insensitive" } },
        { student: { user: { name: { contains: q.search, mode: "insensitive" } } } },
      ];
      const [discounts, total] = await Promise.all([
        prisma.feeDiscount.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" },
          include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, approvedBy: { select: { name: true } } } }),
        prisma.feeDiscount.count({ where }),
      ]);
      return reply.send({ success: true, data: { discounts, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  app.post("/admin/discounts", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { studentId: number; name: string; discountType: string; category?: string; value: number; academicYearId?: number; applicableHeads?: string[]; remarks?: string };
      if (!body.studentId || !body.name || !body.value) return reply.status(400).send({ success: false, message: "studentId, name and value required." });
      const d = await prisma.feeDiscount.create({ data: { schoolId, studentId: body.studentId, name: body.name, discountType: body.discountType as any, category: body.category as any ?? "CUSTOM", value: body.value, academicYearId: body.academicYearId ?? null, applicableHeads: body.applicableHeads ?? [], remarks: body.remarks ?? null, approvedById: userId, approvedAt: new Date() } });
      return reply.status(201).send({ success: true, data: { id: d.id } });
    }
  );

  app.put("/admin/discounts/:id", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const body = req.body as { name?: string; value?: number; isActive?: boolean; remarks?: string };
      await prisma.feeDiscount.updateMany({ where: { id: parseInt(id), schoolId }, data: body });
      return reply.send({ success: true });
    }
  );

  app.delete("/admin/discounts/:id", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      await prisma.feeDiscount.updateMany({ where: { id: parseInt(id), schoolId }, data: { isActive: false } });
      return reply.send({ success: true });
    }
  );

  // ─── SCHOLARSHIP PROGRAMS ──────────────────────────────────
  app.get("/admin/scholarship-programs", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { status?: string };
      const where: any = { schoolId };
      if (q.status) where.status = q.status;
      const programs = await prisma.scholarshipProgram.findMany({ where, orderBy: { createdAt: "desc" }, include: { _count: { select: { studentScholarships: true } }, createdBy: { select: { name: true } } } });
      return reply.send({ success: true, data: { programs } });
    }
  );

  app.post("/admin/scholarship-programs", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { name: string; code: string; description?: string; scholarshipType: string; discountType: string; discountValue: number; minPercentage?: number; applicableClasses?: number[]; academicYearId?: number; maxBenefitAmount?: number; validFrom?: string; validUntil?: string; isRenewable?: boolean; totalSeats?: number };
      if (!body.name || !body.code || !body.discountValue) return reply.status(400).send({ success: false, message: "name, code and discountValue required." });
      const p = await prisma.scholarshipProgram.create({ data: { schoolId, createdById: userId, name: body.name, code: body.code.toUpperCase(), description: body.description ?? null, scholarshipType: body.scholarshipType as any ?? "MERIT", discountType: body.discountType as any ?? "PERCENTAGE", discountValue: body.discountValue, minPercentage: body.minPercentage ?? null, applicableClasses: body.applicableClasses ?? [], academicYearId: body.academicYearId ?? null, maxBenefitAmount: body.maxBenefitAmount ?? null, validFrom: body.validFrom ? new Date(body.validFrom) : null, validUntil: body.validUntil ? new Date(body.validUntil) : null, isRenewable: body.isRenewable ?? false, totalSeats: body.totalSeats ?? null, status: "ACTIVE" } });
      return reply.status(201).send({ success: true, data: { id: p.id } });
    }
  );

  app.put("/admin/scholarship-programs/:id", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const body = req.body as any;
      const allowed = ["name","description","status","discountValue","minPercentage","maxBenefitAmount","validFrom","validUntil","isRenewable","totalSeats"];
      const data: any = {};
      allowed.forEach(k => { if (body[k] !== undefined) data[k] = ["validFrom","validUntil"].includes(k) && body[k] ? new Date(body[k]) : body[k]; });
      await prisma.scholarshipProgram.updateMany({ where: { id: parseInt(id), schoolId }, data });
      return reply.send({ success: true });
    }
  );

  // ─── STUDENT SCHOLARSHIPS ──────────────────────────────────
  app.get("/admin/student-scholarships", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; status?: string; programId?: string; search?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status)    where.status    = q.status;
      if (q.programId) where.programId = parseInt(q.programId);
      if (q.search)    where.student = { user: { name: { contains: q.search, mode: "insensitive" } } };
      const [scholarships, total] = await Promise.all([
        prisma.studentScholarship.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" },
          include: { student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } }, program: { select: { name: true, scholarshipType: true } }, approvedBy: { select: { name: true } } } }),
        prisma.studentScholarship.count({ where }),
      ]);
      return reply.send({ success: true, data: { scholarships, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  app.post("/admin/student-scholarships/assign", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { studentId: number; programId?: number; name: string; discountType: string; discountValue: number; originalFee?: number; applicableHeads?: string[]; academicYearId?: number; validFrom?: string; validUntil?: string; remarks?: string };
      if (!body.studentId || !body.name || !body.discountValue) return reply.status(400).send({ success: false, message: "studentId, name, discountValue required." });

      const benefitAmt = body.discountType === "PERCENTAGE" && body.originalFee ? (body.originalFee * body.discountValue / 100) : body.discountValue;
      const finalFee   = body.originalFee ? Math.max(0, body.originalFee - benefitAmt) : null;

      const s = await prisma.studentScholarship.create({ data: {
        schoolId, assignedById: userId,
        studentId: body.studentId, programId: body.programId ?? null,
        name: body.name, discountType: body.discountType as any,
        discountValue: body.discountValue, academicYearId: body.academicYearId ?? null,
        applicableHeads: body.applicableHeads ?? [],
        originalFee: body.originalFee ?? null, benefitAmount: benefitAmt, finalFee,
        validFrom: body.validFrom ? new Date(body.validFrom) : null,
        validUntil: body.validUntil ? new Date(body.validUntil) : null,
        remarks: body.remarks ?? null, status: "PENDING",
      }});

      // Increment filled seats if program
      if (body.programId) await prisma.scholarshipProgram.updateMany({ where: { id: body.programId, schoolId }, data: { filledSeats: { increment: 1 } } });

      return reply.status(201).send({ success: true, message: "Scholarship assigned — pending approval.", data: { id: s.id } });
    }
  );

  app.patch("/admin/student-scholarships/:id/approve", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any; const { id } = req.params as { id: string };
      await prisma.studentScholarship.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "APPROVED", approvedById: userId, approvedAt: new Date(), isActive: true } });
      return reply.send({ success: true, message: "Scholarship approved." });
    }
  );

  app.patch("/admin/student-scholarships/:id/reject", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };
      await prisma.studentScholarship.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "REJECTED", rejectedReason: reason, isActive: false } });
      return reply.send({ success: true });
    }
  );

  // ─── BENEFIT PREVIEW ───────────────────────────────────────
  app.get("/admin/discounts/benefit-preview/:studentId", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any; const { studentId } = req.params as { studentId: string };
      const [feePlan, discounts, scholarships] = await Promise.all([
        prisma.studentFeePlan.findFirst({ where: { studentId: parseInt(studentId), schoolId }, include: { plan: { include: { heads: true } } } }),
        prisma.feeDiscount.findMany({ where: { studentId: parseInt(studentId), schoolId, isActive: true } }),
        prisma.studentScholarship.findMany({ where: { studentId: parseInt(studentId), schoolId, isActive: true, status: "APPROVED" } }),
      ]);
      const originalFee   = Number(feePlan?.totalAmount ?? 0);
      const totalDiscount = discounts.reduce((s,d) => s + (d.discountType === "PERCENTAGE" ? originalFee * Number(d.value) / 100 : Number(d.value)), 0);
      const totalScholar  = scholarships.reduce((s,sch) => s + Number(sch.benefitAmount ?? 0), 0);
      const totalBenefit  = totalDiscount + totalScholar;
      return reply.send({ success: true, data: { originalFee, totalBenefit, totalDiscount, totalScholar, finalFee: Math.max(0, originalFee - totalBenefit), discounts, scholarships } });
    }
  );

  // ─── REPORTS ───────────────────────────────────────────────
  app.get("/admin/discounts/reports", { preHandler: [authenticate, requireCapability('finance.collection')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [byCategory, byType, scholarshipsByProgram] = await Promise.all([
        prisma.feeDiscount.groupBy({ by: ["category"], where: { schoolId, isActive: true }, _count: true, _sum: { value: true } }),
        prisma.feeDiscount.groupBy({ by: ["discountType"], where: { schoolId, isActive: true }, _count: true }),
        prisma.scholarshipProgram.findMany({ where: { schoolId }, include: { _count: { select: { studentScholarships: { where: { status: "APPROVED" } } } } }, orderBy: { filledSeats: "desc" } }),
      ]);
      return reply.send({ success: true, data: {
        byCategory: byCategory.map(b => ({ category: b.category, count: b._count, total: Number(b._sum.value ?? 0) })).sort((a,b) => b.total-a.total),
        byType:     byType.map(b => ({ type: b.discountType, count: b._count })),
        scholarshipsByProgram: scholarshipsByProgram.map(p => ({ id: p.id, name: p.name, type: p.scholarshipType, students: p._count.studentScholarships, seats: p.totalSeats })),
      }});
    }
  );
}
