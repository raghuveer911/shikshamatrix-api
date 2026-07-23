// apps/api/src/routes/admin/hr/hr-idcards-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminHrIdCardsRoutes(app: FastifyInstance) {
  const P = "/admin/hr/idcards";

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [
        activeCards, totalCerts, pendingRequests,
        expiringCards, templates, certTemplates,
      ] = await Promise.all([
        prisma.hrStaffIdCard.count({ where: { schoolId, status: "ACTIVE" } }),
        prisma.hrCertificateIssued.count({ where: { schoolId } }),
        prisma.hrStaffIdCard.count({ where: { schoolId, status: "INACTIVE" } }),
        prisma.hrStaffIdCard.count({
          where: {
            schoolId, status: "ACTIVE",
            validUntil: { lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
          },
        }),
        prisma.hrIdCardTemplate.count({ where: { schoolId, isActive: true } }),
        prisma.hrCertificateTemplate.count({ where: { schoolId, isActive: true } }),
      ]);

      const certBreakdown = await prisma.hrCertificateIssued.groupBy({
        by: ["certType"],
        where: { schoolId },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      });

      const recentCerts = await prisma.hrCertificateIssued.findMany({
        where: { schoolId },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { staff: { include: { user: { select: { name: true } } } } },
      });

      return rep.send({
        activeCards, totalCerts, pendingRequests, expiringCards,
        templates, certTemplates, certBreakdown, recentCerts,
      });
    }
  );

  // ─── ID CARD TEMPLATES ────────────────────────────────────
  app.get(`${P}/templates`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const templates = await prisma.hrIdCardTemplate.findMany({
        where: { schoolId, isActive: true },
        orderBy: { isDefault: "desc" },
      });
      return rep.send({ templates });
    }
  );

  app.post(`${P}/templates`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;

      // If setting as default, unset others
      if (b.isDefault) {
        await prisma.hrIdCardTemplate.updateMany({
          where: { schoolId }, data: { isDefault: false },
        });
      }

      const template = await prisma.hrIdCardTemplate.create({
        data: {
          schoolId,
          name: b.name,
          description: b.description ?? null,
          layoutJson: b.layoutJson ?? {},
          primaryColor: b.primaryColor ?? "#6366f1",
          accentColor: b.accentColor ?? "#4f46e5",
          paperSize: b.paperSize ?? "CR80",
          orientation: b.orientation ?? "LANDSCAPE",
          isDefault: b.isDefault ?? false,
        },
      });
      return rep.code(201).send({ template });
    }
  );

  app.put(`${P}/templates/:id`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      if (b.isDefault) {
        await prisma.hrIdCardTemplate.updateMany({ where: { schoolId }, data: { isDefault: false } });
      }

      const template = await prisma.hrIdCardTemplate.update({
        where: { id, schoolId },
        data: {
          name: b.name, description: b.description,
          layoutJson: b.layoutJson,
          primaryColor: b.primaryColor, accentColor: b.accentColor,
          isDefault: b.isDefault, isActive: b.isActive,
          previewUrl: b.previewUrl,
        },
      });
      return rep.send({ template });
    }
  );

  // ─── STAFF ID CARDS ───────────────────────────────────────
  app.get(`${P}/id-cards`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const cards = await prisma.hrStaffIdCard.findMany({
        where: {
          schoolId,
          ...(q.staffId ? { staffId: Number(q.staffId) } : {}),
          ...(q.status ? { status: q.status as any } : {}),
        },
        include: {
          staff: {
            include: {
              user: { select: { name: true, avatarUrl: true, email: true } },
              departmentRef: { select: { name: true } },
              designationRef: { select: { name: true } },
            },
          },
          template: { select: { name: true, primaryColor: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ cards });
    }
  );

  // Generate single ID card
  app.post(`${P}/id-cards`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      // Auto-generate card number
      const count = await prisma.hrStaffIdCard.count({ where: { schoolId } });
      const cardNumber = `${schoolId}-${new Date().getFullYear()}-${String(count + 1).padStart(4, "0")}`;

      // Expire any active card for this staff
      await prisma.hrStaffIdCard.updateMany({
        where: { staffId: Number(b.staffId), schoolId, status: "ACTIVE" },
        data: { status: "INACTIVE" },
      });

      const card = await prisma.hrStaffIdCard.create({
        data: {
          schoolId,
          staffId: Number(b.staffId),
          templateId: b.templateId ? Number(b.templateId) : null,
          cardNumber,
          issueDate: new Date(),
          validUntil: b.validUntil ? new Date(b.validUntil) : null,
          status: "ACTIVE",
          qrCode: b.qrCode ?? null,
          frontImageUrl: b.frontImageUrl ?? null,
          backImageUrl: b.backImageUrl ?? null,
          pdfUrl: b.pdfUrl ?? null,
          issuedById: Number(userId),
        },
      });
      return rep.code(201).send({ card, cardNumber });
    }
  );

  // Bulk generate ID cards
  app.post(`${P}/id-cards/bulk`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { staffIds, templateId, validUntil } = req.body as any;

      const results: any[] = [];
      let count = await prisma.hrStaffIdCard.count({ where: { schoolId } });

      for (const staffId of staffIds) {
        count++;
        const cardNumber = `${schoolId}-${new Date().getFullYear()}-${String(count).padStart(4, "0")}`;

        // Deactivate existing
        await prisma.hrStaffIdCard.updateMany({
          where: { staffId: Number(staffId), schoolId, status: "ACTIVE" },
          data: { status: "INACTIVE" },
        });

        const card = await prisma.hrStaffIdCard.create({
          data: {
            schoolId,
            staffId: Number(staffId),
            templateId: templateId ? Number(templateId) : null,
            cardNumber,
            issueDate: new Date(),
            validUntil: validUntil ? new Date(validUntil) : null,
            status: "ACTIVE",
            issuedById: Number(userId),
          },
        });
        results.push({ staffId, cardNumber, id: card.id });
      }

      return rep.send({ results, count: results.length });
    }
  );

  app.patch(`${P}/id-cards/:id/status`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const { status } = req.body as any;
      const data: any = { status };
      if (status === "LOST") data.lostReportedAt = new Date();
      const card = await prisma.hrStaffIdCard.update({ where: { id, schoolId }, data });
      return rep.send({ card });
    }
  );

  // Track print
  app.patch(`${P}/id-cards/:id/printed`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const card = await prisma.hrStaffIdCard.update({
        where: { id, schoolId },
        data: { printCount: { increment: 1 }, lastPrintedAt: new Date() },
      });
      return rep.send({ card });
    }
  );

  // ─── CERTIFICATE TEMPLATES ────────────────────────────────
  app.get(`${P}/cert-templates`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const templates = await prisma.hrCertificateTemplate.findMany({
        where: {
          schoolId, isActive: true,
          ...(q.certType ? { certType: q.certType as any } : {}),
        },
        orderBy: [{ certType: "asc" }, { isDefault: "desc" }],
      });
      return rep.send({ templates });
    }
  );

  app.post(`${P}/cert-templates`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;

      if (b.isDefault) {
        await prisma.hrCertificateTemplate.updateMany({
          where: { schoolId, certType: b.certType as any }, data: { isDefault: false },
        });
      }

      const template = await prisma.hrCertificateTemplate.create({
        data: {
          schoolId,
          name: b.name,
          certType: b.certType as any,
          description: b.description ?? null,
          htmlContent: b.htmlContent ?? "",
          headerLogoUrl: b.headerLogoUrl ?? null,
          signatureLabel: b.signatureLabel ?? null,
          isDefault: b.isDefault ?? false,
        },
      });
      return rep.code(201).send({ template });
    }
  );

  app.put(`${P}/cert-templates/:id`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      if (b.isDefault && b.certType) {
        await prisma.hrCertificateTemplate.updateMany({
          where: { schoolId, certType: b.certType as any }, data: { isDefault: false },
        });
      }

      const template = await prisma.hrCertificateTemplate.update({
        where: { id, schoolId },
        data: {
          name: b.name, description: b.description,
          htmlContent: b.htmlContent, headerLogoUrl: b.headerLogoUrl,
          signatureLabel: b.signatureLabel, isDefault: b.isDefault, isActive: b.isActive,
        },
      });
      return rep.send({ template });
    }
  );

  // ─── CERTIFICATES ISSUED ──────────────────────────────────
  app.get(`${P}/certificates`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const certs = await prisma.hrCertificateIssued.findMany({
        where: {
          schoolId,
          ...(q.staffId ? { staffId: Number(q.staffId) } : {}),
          ...(q.certType ? { certType: q.certType as any } : {}),
        },
        include: {
          staff: {
            include: {
              user: { select: { name: true, avatarUrl: true } },
              departmentRef: { select: { name: true } },
              designationRef: { select: { name: true } },
            },
          },
          template: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ certs });
    }
  );

  // Issue a certificate (single)
  app.post(`${P}/certificates`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      // Auto-generate cert number
      const count = await prisma.hrCertificateIssued.count({ where: { schoolId } });
      const year = new Date().getFullYear();
      const certNumber = `CERT-${year}-${String(count + 1).padStart(4, "0")}`;

      // Fetch staff data for the certificate content
      const staff = await prisma.staff.findFirst({
        where: { id: Number(b.staffId), schoolId },
        include: {
          user: { select: { name: true, email: true } },
          departmentRef: { select: { name: true } },
          designationRef: { select: { name: true } },
        },
      });

      const generatedData = {
        employeeName: staff?.user?.name,
        employeeId: staff?.employeeId,
        designation: staff?.designationRef?.name,
        department: staff?.departmentRef?.name,
        joinDate: staff?.joinDate,
        issuedDate: new Date().toISOString(),
        certNumber,
      };

      const cert = await prisma.hrCertificateIssued.create({
        data: {
          schoolId,
          staffId: Number(b.staffId),
          templateId: b.templateId ? Number(b.templateId) : null,
          certType: b.certType as any,
          certNumber,
          title: b.title,
          issuedDate: new Date(),
          validUntil: b.validUntil ? new Date(b.validUntil) : null,
          purposeNote: b.purposeNote ?? null,
          generatedData,
          htmlContent: b.htmlContent ?? null,
          pdfUrl: b.pdfUrl ?? null,
          issuedById: Number(userId),
        },
      });
      return rep.code(201).send({ cert, certNumber });
    }
  );

  // Bulk issue certificates
  app.post(`${P}/certificates/bulk`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { staffIds, certType, title, templateId } = req.body as any;

      const results: any[] = [];
      let count = await prisma.hrCertificateIssued.count({ where: { schoolId } });
      const year = new Date().getFullYear();

      for (const staffId of staffIds) {
        count++;
        const certNumber = `CERT-${year}-${String(count).padStart(4, "0")}`;
        const staff = await prisma.staff.findFirst({
          where: { id: Number(staffId), schoolId },
          include: { user: { select: { name: true } }, designationRef: { select: { name: true } } },
        });

        const cert = await prisma.hrCertificateIssued.create({
          data: {
            schoolId,
            staffId: Number(staffId),
            templateId: templateId ? Number(templateId) : null,
            certType: certType as any,
            certNumber,
            title: title ?? `${certType} Certificate`,
            issuedDate: new Date(),
            generatedData: { employeeName: staff?.user?.name, employeeId: staff?.employeeId, certNumber },
            issuedById: Number(userId),
          },
        });
        results.push({ staffId, certNumber, id: cert.id });
      }
      return rep.send({ results, count: results.length });
    }
  );

  // Verify certificate by certNumber (public endpoint)
  app.get(`${P}/verify/:certNumber`, async (req: FastifyRequest, rep: FastifyReply) => {
    const { certNumber } = req.params as any;
    const cert = await prisma.hrCertificateIssued.findFirst({
      where: { certNumber },
      include: {
        staff: {
          include: {
            user: { select: { name: true } },
            designationRef: { select: { name: true } },
            departmentRef: { select: { name: true } },
          },
        },
      },
    });
    if (!cert) return rep.code(404).send({ valid: false, message: "Certificate not found" });
    if (cert.revokedAt) return rep.send({ valid: false, message: "Certificate has been revoked" });
    return rep.send({
      valid: true,
      certNumber: cert.certNumber,
      certType: cert.certType,
      title: cert.title,
      issuedDate: cert.issuedDate,
      staffName: cert.staff?.user?.name,
      designation: cert.staff?.designationRef?.name,
      department: cert.staff?.departmentRef?.name,
    });
  });

  app.patch(`${P}/certificates/:id/revoke`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const { reason } = req.body as any;
      const cert = await prisma.hrCertificateIssued.update({
        where: { id, schoolId },
        data: { revokedAt: new Date(), revokeReason: reason, isVerified: false },
      });
      return rep.send({ cert });
    }
  );

  // Track print
  app.patch(`${P}/certificates/:id/printed`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.hrCertificateIssued.update({
        where: { id, schoolId },
        data: { printCount: { increment: 1 } },
      });
      return rep.send({ ok: true });
    }
  );
}
