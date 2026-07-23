// apps/api/src/routes/admin/hr/hr-docs-compliance-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { assertStorageLimitNotExceeded, StorageLimitError } from "../../../services/storage.service.js";

export async function adminHrDocsComplianceRoutes(app: FastifyInstance) {
  const P = "/admin/hr/docs";

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [
        totalDocs, verified, pending, contracts,
        expiringDocs, expiringContracts, missingCount,
      ] = await Promise.all([
        prisma.staffDocument.count({ where: { schoolId } }),
        prisma.staffDocument.count({ where: { schoolId, verification: "VERIFIED" } }),
        prisma.staffDocument.count({ where: { schoolId, verification: "PENDING" } }),
        prisma.hrStaffContract.count({ where: { schoolId, status: "ACTIVE" } }),
        prisma.staffDocument.count({
          where: {
            schoolId,
            expiryDate: { lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
            verification: { not: "REJECTED" },
          },
        }),
        prisma.hrStaffContract.count({
          where: {
            schoolId,
            status: "ACTIVE",
            endDate: { lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
          },
        }),
        prisma.hrComplianceRecord.count({ where: { schoolId, status: "MISSING" } }),
      ]);

      const verificationBreakdown = await prisma.staffDocument.groupBy({
        by: ["verification"],
        where: { schoolId },
        _count: { id: true },
      });

      const recentUploads = await prisma.staffDocument.findMany({
        where: { schoolId },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { staff: { include: { user: { select: { name: true } } } } },
      });

      return rep.send({
        totalDocs, verified, pending, contracts,
        expiringDocs, expiringContracts, missingCount,
        verificationBreakdown, recentUploads,
      });
    }
  );

  // ─── EMPLOYEE DOCUMENTS ───────────────────────────────────
  // List documents for a specific staff or all
  app.get(`${P}/documents`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const docs = await prisma.staffDocument.findMany({
        where: {
          schoolId,
          ...(q.staffId ? { staffId: Number(q.staffId) } : {}),
          ...(q.docType ? { docType: q.docType as any } : {}),
          ...(q.verification ? { verification: q.verification as any } : {}),
          ...(q.expiringSoon === "true" ? {
            expiryDate: { lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
          } : {}),
        },
        include: {
          staff: {
            include: {
              user: { select: { name: true, avatarUrl: true } },
              departmentRef: { select: { name: true } },
              designationRef: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ docs });
    }
  );

  // Get one staff's full document profile
  app.get(`${P}/documents/staff/:staffId`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const staffId = Number((req.params as any).staffId);

      const [staff, docs, compliance, qualifications, bgChecks, contracts] = await Promise.all([
        prisma.staff.findFirst({
          where: { id: staffId, schoolId },
          include: {
            user: { select: { name: true, email: true, avatarUrl: true } },
            departmentRef: { select: { name: true } },
            designationRef: { select: { name: true } },
          },
        }),
        prisma.staffDocument.findMany({ where: { staffId, schoolId }, orderBy: { docType: "asc" } }),
        prisma.hrComplianceRecord.findMany({ where: { staffId, schoolId }, orderBy: { docType: "asc" } }),
        prisma.hrQualificationRecord.findMany({ where: { staffId, schoolId }, orderBy: { passYear: "desc" } }),
        prisma.hrBackgroundCheck.findMany({ where: { staffId, schoolId }, orderBy: { initiatedDate: "desc" } }),
        prisma.hrStaffContract.findMany({ where: { staffId, schoolId }, orderBy: { startDate: "desc" } }),
      ]);

      // Calculate compliance score
      const total = compliance.length;
      const compliant = compliance.filter(c => c.status === "VERIFIED").length;
      const score = total > 0 ? Math.round((compliant / total) * 100) : 0;

      return rep.send({ staff, docs, compliance, qualifications, bgChecks, contracts, complianceScore: score });
    }
  );

  // Upload / create document record
  app.post(`${P}/documents`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;

      try {
        await assertStorageLimitNotExceeded(schoolId, b.fileSize ? Number(b.fileSize) : 0);
      } catch (err) {
        if (err instanceof StorageLimitError) return rep.status(507).send({ success: false, message: err.message });
        throw err;
      }

      const doc = await prisma.staffDocument.create({
        data: {
          schoolId,
          staffId: Number(b.staffId),
          docType: b.docType as any,
          fileName: b.fileName,
          fileUrl: b.fileUrl ?? null,
          fileSize: b.fileSize ? Number(b.fileSize) : null,
          verification: "PENDING",
          remarks: b.remarks ?? null,
          expiryDate: b.expiryDate ? new Date(b.expiryDate) : null,
        },
      });

      // Auto-update compliance record
      await prisma.hrComplianceRecord.upsert({
        where: { staffId_docType: { staffId: Number(b.staffId), docType: b.docType } },
        create: {
          schoolId,
          staffId: Number(b.staffId),
          docType: b.docType,
          status: "UPLOADED",
          documentId: doc.id,
          lastCheckedAt: new Date(),
        },
        update: { status: "UPLOADED", documentId: doc.id, lastCheckedAt: new Date() },
      });

      return rep.code(201).send({ doc });
    }
  );

  // Update document (remarks, expiryDate etc.)
  app.put(`${P}/documents/:id`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const doc = await prisma.staffDocument.update({
        where: { id, schoolId },
        data: {
          fileName: b.fileName,
          fileUrl: b.fileUrl,
          remarks: b.remarks,
          expiryDate: b.expiryDate ? new Date(b.expiryDate) : null,
        },
      });
      return rep.send({ doc });
    }
  );

  app.delete(`${P}/documents/:id`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.staffDocument.delete({ where: { id, schoolId } });
      return rep.send({ ok: true });
    }
  );

  // ─── VERIFICATION CENTER ──────────────────────────────────
  app.post(`${P}/documents/:id/verify`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const doc = await prisma.staffDocument.update({
        where: { id, schoolId },
        data: {
          verification: b.status as any, // VERIFIED | REJECTED
          verifiedById: Number(userId),
          remarks: b.remarks ?? null,
        },
      });

      // Update compliance record
      const newStatus = b.status === "VERIFIED" ? "VERIFIED" : "REJECTED";
      await prisma.hrComplianceRecord.updateMany({
        where: { schoolId, documentId: id },
        data: { status: newStatus, lastCheckedAt: new Date() },
      });

      return rep.send({ doc });
    }
  );

  // Bulk verify
  app.post(`${P}/documents/bulk-verify`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { ids, status } = req.body as any;

      await prisma.staffDocument.updateMany({
        where: { id: { in: ids.map(Number) }, schoolId },
        data: { verification: status as any, verifiedById: Number(userId) },
      });

      return rep.send({ ok: true, count: ids.length });
    }
  );

  // ─── COMPLIANCE RULES ─────────────────────────────────────
  app.get(`${P}/compliance-rules`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const rules = await prisma.hrComplianceRule.findMany({
        where: { schoolId },
        orderBy: [{ employeeType: "asc" }, { priority: "asc" }],
      });
      return rep.send({ rules });
    }
  );

  app.post(`${P}/compliance-rules`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const rule = await prisma.hrComplianceRule.create({
        data: {
          schoolId,
          name: b.name,
          employeeType: b.employeeType,
          docType: b.docType,
          isRequired: b.isRequired ?? true,
          priority: Number(b.priority ?? 1),
          description: b.description ?? null,
        },
      });
      return rep.code(201).send({ rule });
    }
  );

  app.put(`${P}/compliance-rules/:id`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const rule = await prisma.hrComplianceRule.update({
        where: { id, schoolId },
        data: {
          name: b.name, priority: b.priority ? Number(b.priority) : undefined,
          isRequired: b.isRequired, description: b.description, isActive: b.isActive,
        },
      });
      return rep.send({ rule });
    }
  );

  app.delete(`${P}/compliance-rules/:id`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.hrComplianceRule.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // Compliance overview — list all staff with their compliance scores
  app.get(`${P}/compliance-overview`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const staff = await prisma.staff.findMany({
        where: { schoolId, isActive: true },
        include: {
          user: { select: { name: true, avatarUrl: true } },
          departmentRef: { select: { name: true } },
          designationRef: { select: { name: true } },
          complianceRecords: true,
        },
        orderBy: { user: { name: "asc" } },
        take: Number(q.limit ?? 50),
        skip: Number(q.skip ?? 0),
      });

      const result = staff.map(s => {
        const total = s.complianceRecords.length;
        const compliant = s.complianceRecords.filter(r => r.status === "VERIFIED").length;
        const missing = s.complianceRecords.filter(r => r.status === "MISSING").length;
        const score = total > 0 ? Math.round((compliant / total) * 100) : null;
        return { ...s, complianceScore: score, missingCount: missing };
      });

      return rep.send({ staff: result });
    }
  );

  // ─── EXPIRY MANAGEMENT ────────────────────────────────────
  app.get(`${P}/expiring`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const days = Number((req.query as any).days ?? 30);
      const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

      const [expiringDocs, expiringContracts] = await Promise.all([
        prisma.staffDocument.findMany({
          where: { schoolId, expiryDate: { lte: cutoff, gte: new Date() } },
          include: {
            staff: { include: { user: { select: { name: true, avatarUrl: true } } } },
          },
          orderBy: { expiryDate: "asc" },
        }),
        prisma.hrStaffContract.findMany({
          where: {
            schoolId, status: "ACTIVE",
            endDate: { lte: cutoff, gte: new Date() },
          },
          include: {
            staff: { include: { user: { select: { name: true, avatarUrl: true } } } },
          },
          orderBy: { endDate: "asc" },
        }),
      ]);

      return rep.send({ expiringDocs, expiringContracts, days });
    }
  );

  // ─── CONTRACT MANAGEMENT ─────────────────────────────────
  app.get(`${P}/contracts`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const contracts = await prisma.hrStaffContract.findMany({
        where: {
          schoolId,
          ...(q.staffId ? { staffId: Number(q.staffId) } : {}),
          ...(q.status ? { status: q.status as any } : {}),
          ...(q.type ? { contractType: q.type as any } : {}),
        },
        include: {
          staff: {
            include: {
              user: { select: { name: true, avatarUrl: true } },
              departmentRef: { select: { name: true } },
            },
          },
        },
        orderBy: { startDate: "desc" },
      });
      return rep.send({ contracts });
    }
  );

  app.post(`${P}/contracts`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const contract = await prisma.hrStaffContract.create({
        data: {
          schoolId,
          staffId: Number(b.staffId),
          contractType: b.contractType as any ?? "CONTRACT",
          title: b.title,
          startDate: new Date(b.startDate),
          endDate: b.endDate ? new Date(b.endDate) : null,
          renewalDate: b.renewalDate ? new Date(b.renewalDate) : null,
          salary: b.salary ? Number(b.salary) : null,
          terms: b.terms ?? null,
          fileUrl: b.fileUrl ?? null,
          isAutoRenew: b.isAutoRenew ?? false,
          alertDays: Number(b.alertDays ?? 30),
          status: "ACTIVE",
          createdById: Number(userId),
        },
      });
      return rep.code(201).send({ contract });
    }
  );

  app.put(`${P}/contracts/:id`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const contract = await prisma.hrStaffContract.update({
        where: { id, schoolId },
        data: {
          title: b.title,
          endDate: b.endDate ? new Date(b.endDate) : undefined,
          renewalDate: b.renewalDate ? new Date(b.renewalDate) : undefined,
          status: b.status as any,
          salary: b.salary ? Number(b.salary) : undefined,
          terms: b.terms,
          fileUrl: b.fileUrl,
          isAutoRenew: b.isAutoRenew,
          alertDays: b.alertDays ? Number(b.alertDays) : undefined,
        },
      });
      return rep.send({ contract });
    }
  );

  // ─── QUALIFICATION RECORDS ────────────────────────────────
  app.get(`${P}/qualifications`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const quals = await prisma.hrQualificationRecord.findMany({
        where: {
          schoolId,
          ...(q.staffId ? { staffId: Number(q.staffId) } : {}),
          ...(q.category ? { category: q.category } : {}),
        },
        include: {
          staff: { include: { user: { select: { name: true, avatarUrl: true } } } },
        },
        orderBy: { passYear: "desc" },
      });
      return rep.send({ quals });
    }
  );

  app.post(`${P}/qualifications`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const qual = await prisma.hrQualificationRecord.create({
        data: {
          schoolId,
          staffId: Number(b.staffId),
          qualName: b.qualName,
          category: b.category ?? "DEGREE",
          institution: b.institution ?? null,
          boardOrUniv: b.boardOrUniv ?? null,
          passYear: b.passYear ? Number(b.passYear) : null,
          grade: b.grade ?? null,
          percentage: b.percentage ? Number(b.percentage) : null,
          certificateUrl: b.certificateUrl ?? null,
          expiryDate: b.expiryDate ? new Date(b.expiryDate) : null,
        },
      });
      return rep.code(201).send({ qual });
    }
  );

  app.put(`${P}/qualifications/:id`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const qual = await prisma.hrQualificationRecord.update({
        where: { id, schoolId },
        data: {
          qualName: b.qualName, institution: b.institution, boardOrUniv: b.boardOrUniv,
          passYear: b.passYear ? Number(b.passYear) : null,
          grade: b.grade, percentage: b.percentage ? Number(b.percentage) : null,
          certificateUrl: b.certificateUrl,
          expiryDate: b.expiryDate ? new Date(b.expiryDate) : null,
          isVerified: b.isVerified,
        },
      });
      return rep.send({ qual });
    }
  );

  app.delete(`${P}/qualifications/:id`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.hrQualificationRecord.delete({ where: { id, schoolId } });
      return rep.send({ ok: true });
    }
  );

  // ─── BACKGROUND CHECKS ────────────────────────────────────
  app.get(`${P}/bg-checks`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const checks = await prisma.hrBackgroundCheck.findMany({
        where: {
          schoolId,
          ...(q.staffId ? { staffId: Number(q.staffId) } : {}),
          ...(q.status ? { status: q.status as any } : {}),
        },
        include: {
          staff: { include: { user: { select: { name: true, avatarUrl: true } } } },
        },
        orderBy: { initiatedDate: "desc" },
      });
      return rep.send({ checks });
    }
  );

  app.post(`${P}/bg-checks`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const check = await prisma.hrBackgroundCheck.create({
        data: {
          schoolId,
          staffId: Number(b.staffId),
          checkType: b.checkType,
          agency: b.agency ?? null,
          initiatedDate: new Date(b.initiatedDate ?? Date.now()),
          status: "PENDING",
          remarks: b.remarks ?? null,
          nextRenewalDate: b.nextRenewalDate ? new Date(b.nextRenewalDate) : null,
          initiatedById: Number(userId),
        },
      });
      return rep.code(201).send({ check });
    }
  );

  app.put(`${P}/bg-checks/:id`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const check = await prisma.hrBackgroundCheck.update({
        where: { id, schoolId },
        data: {
          status: b.status as any,
          result: b.result,
          reportUrl: b.reportUrl,
          remarks: b.remarks,
          completedDate: b.completedDate ? new Date(b.completedDate) : null,
          nextRenewalDate: b.nextRenewalDate ? new Date(b.nextRenewalDate) : null,
        },
      });
      return rep.send({ check });
    }
  );
}
