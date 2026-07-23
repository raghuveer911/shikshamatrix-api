// apps/api/src/routes/admin/certificates/cert-templates-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminCertTemplatesRoutes(app: FastifyInstance) {
  const P = "/admin/certificates/templates";

  // ─── LIST TEMPLATES ───────────────────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const templates = await prisma.certTemplate.findMany({
        where: {
          schoolId,
          ...(q.category   ? { category: q.category as any } : {}),
          ...(q.certType   ? { certType: q.certType as any } : {}),
          ...(q.targetType ? { targetType: q.targetType as any } : {}),
          ...(q.active !== "false" ? { isActive: true } : {}),
          ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}),
        },
        orderBy: [{ isDefault: "desc" }, { usageCount: "desc" }],
      });
      return rep.send({ templates });
    }
  );

  // ─── GET ONE TEMPLATE ─────────────────────────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const template = await prisma.certTemplate.findFirst({
        where: { id, schoolId },
        include: {
          _count: { select: { certIssued: true } },
        },
      });
      if (!template) return rep.code(404).send({ error: "Not found" });
      return rep.send({ template });
    }
  );

  // ─── CREATE TEMPLATE ──────────────────────────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('certificates.customTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      // If setting as default for this certType, unset others
      if (b.isDefault) {
        await prisma.certTemplate.updateMany({
          where: { schoolId, certType: b.certType as any },
          data: { isDefault: false },
        });
      }

      const template = await prisma.certTemplate.create({
        data: {
          schoolId,
          category:     b.category as any,
          certType:     b.certType as any,
          name:         b.name,
          description:  b.description ?? null,
          layoutJson:   b.layoutJson ?? {},
          htmlContent:  b.htmlContent ?? null,
          primaryColor: b.primaryColor ?? "#1e3a8a",
          accentColor:  b.accentColor ?? "#f59e0b",
          fontFamily:   b.fontFamily ?? "Inter",
          paperSize:    b.paperSize ?? "A4",
          orientation:  b.orientation ?? "PORTRAIT",
          showQrCode:   b.showQrCode ?? true,
          showLogo:     b.showLogo ?? true,
          showSignature: b.showSignature ?? true,
          showWatermark: b.showWatermark ?? false,
          watermarkText: b.watermarkText ?? null,
          signatureLabel: b.signatureLabel ?? null,
          headerHtml:   b.headerHtml ?? null,
          footerHtml:   b.footerHtml ?? null,
          variables:    b.variables ?? [],
          isDefault:    b.isDefault ?? false,
          targetType:   b.targetType as any ?? "STUDENT",
          needsApproval: b.needsApproval ?? false,
          approvalRoles: b.approvalRoles ?? [],
          expiresAfterDays: b.expiresAfterDays ? Number(b.expiresAfterDays) : null,
          createdById:  Number(userId),
        },
      });
      return rep.code(201).send({ template });
    }
  );

  // ─── UPDATE TEMPLATE ──────────────────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('certificates.customTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      if (b.isDefault && b.certType) {
        await prisma.certTemplate.updateMany({
          where: { schoolId, certType: b.certType as any },
          data: { isDefault: false },
        });
      }

      const template = await prisma.certTemplate.update({
        where: { id, schoolId },
        data: {
          name:          b.name,
          description:   b.description,
          layoutJson:    b.layoutJson,
          htmlContent:   b.htmlContent,
          primaryColor:  b.primaryColor,
          accentColor:   b.accentColor,
          fontFamily:    b.fontFamily,
          paperSize:     b.paperSize,
          orientation:   b.orientation,
          showQrCode:    b.showQrCode,
          showLogo:      b.showLogo,
          showSignature: b.showSignature,
          showWatermark: b.showWatermark,
          watermarkText: b.watermarkText,
          signatureLabel: b.signatureLabel,
          headerHtml:    b.headerHtml,
          footerHtml:    b.footerHtml,
          variables:     b.variables,
          isDefault:     b.isDefault,
          isActive:      b.isActive,
          needsApproval: b.needsApproval,
          approvalRoles: b.approvalRoles,
          expiresAfterDays: b.expiresAfterDays ? Number(b.expiresAfterDays) : null,
        },
      });
      return rep.send({ template });
    }
  );

  // ─── CLONE (new version) ──────────────────────────────────
  app.post(`${P}/:id/clone`, { preHandler: [authenticate, requireCapability('certificates.customTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const source = await prisma.certTemplate.findFirst({ where: { id, schoolId } });
      if (!source) return rep.code(404).send({ error: "Template not found" });

      const clone = await prisma.certTemplate.create({
        data: {
          schoolId,
          category:     source.category,
          certType:     source.certType,
          name:         b.name ?? `${source.name} (Copy)`,
          description:  source.description,
          layoutJson:   source.layoutJson,
          htmlContent:  source.htmlContent,
          primaryColor: source.primaryColor,
          accentColor:  source.accentColor,
          fontFamily:   source.fontFamily,
          paperSize:    source.paperSize,
          orientation:  source.orientation,
          showQrCode:   source.showQrCode,
          showLogo:     source.showLogo,
          showSignature: source.showSignature,
          showWatermark: source.showWatermark,
          watermarkText: source.watermarkText,
          signatureLabel: source.signatureLabel,
          headerHtml:   source.headerHtml,
          footerHtml:   source.footerHtml,
          variables:    source.variables,
          version:      source.version + 1,
          parentId:     source.id,
          targetType:   source.targetType,
          needsApproval: source.needsApproval,
          approvalRoles: source.approvalRoles,
          expiresAfterDays: source.expiresAfterDays,
          isDefault:    false,
          createdById:  Number(userId),
        },
      });
      return rep.code(201).send({ template: clone });
    }
  );

  // ─── SOFT DELETE ──────────────────────────────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate, requireCapability('certificates.customTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.certTemplate.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─── SET DEFAULT ──────────────────────────────────────────
  app.post(`${P}/:id/set-default`, { preHandler: [authenticate, requireCapability('certificates.customTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const tmpl = await prisma.certTemplate.findFirst({ where: { id, schoolId } });
      if (!tmpl) return rep.code(404).send({ error: "Not found" });

      await prisma.certTemplate.updateMany({
        where: { schoolId, certType: tmpl.certType },
        data: { isDefault: false },
      });
      const updated = await prisma.certTemplate.update({
        where: { id },
        data: { isDefault: true },
      });
      return rep.send({ template: updated });
    }
  );

  // ─── VERSION HISTORY ──────────────────────────────────────
  app.get(`${P}/:id/versions`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      // Get all versions chained from parentId
      const root = await prisma.certTemplate.findFirst({ where: { id, schoolId } });
      if (!root) return rep.code(404).send({ error: "Not found" });

      const versions = await prisma.certTemplate.findMany({
        where: {
          schoolId,
          certType: root.certType,
          name: { contains: root.name.replace(/ \(Copy\).*/, "") },
        },
        orderBy: { version: "asc" },
        select: { id: true, name: true, version: true, isDefault: true, isActive: true, usageCount: true, createdAt: true },
      });
      return rep.send({ versions });
    }
  );

  // ─── TEMPLATE PREVIEW DATA (variable resolution test) ────
  app.post(`${P}/:id/preview-data`, { preHandler: [authenticate, requireCapability('certificates.customTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      // Just echo back sample variable map for UI preview
      const sampleData: Record<string, string> = {
        "{{studentName}}":    b.studentName   ?? "Sample Student",
        "{{class}}":          b.class         ?? "10-A",
        "{{admissionNo}}":    b.admissionNo   ?? "ADM-2025-001",
        "{{rollNumber}}":     b.rollNumber    ?? "001",
        "{{issueDate}}":      new Date().toLocaleDateString("en-IN"),
        "{{certificateNo}}":  `CERT-${new Date().getFullYear()}-XXXX`,
        "{{schoolName}}":     b.schoolName    ?? "School Name",
        "{{principalName}}":  b.principalName ?? "Principal",
        "{{employeeName}}":   b.employeeName  ?? "Employee Name",
        "{{designation}}":    b.designation   ?? "Designation",
        "{{department}}":     b.department    ?? "Department",
        "{{joiningDate}}":    b.joiningDate   ?? "01-Apr-2022",
        "{{year}}":           String(new Date().getFullYear()),
        ...(b.extra ?? {}),
      };
      return rep.send({ sampleData });
    }
  );

  // ─── DEFAULT TEMPLATES FOR A CERT TYPE ───────────────────
  app.get(`${P}/default/:certType`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { certType } = req.params as any;
      const template = await prisma.certTemplate.findFirst({
        where: { schoolId, certType: certType as any, isDefault: true, isActive: true },
      });
      return rep.send({ template });
    }
  );
}
