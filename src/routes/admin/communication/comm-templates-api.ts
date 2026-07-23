// apps/api/src/routes/admin/communication/comm-templates-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

export async function adminCommTemplatesRoutes(app: FastifyInstance) {
  const P = "/admin/comm/templates";

  // ─── LIST TEMPLATES ───────────────────────────────────────
  app.get(P, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const templates = await prisma.commTemplate.findMany({
        where: {
          schoolId,
          isActive: true,
          ...(q.type    ? { type: q.type as any }    : {}),
          ...(q.channel ? { channels: { has: q.channel as any } } : {}),
          ...(q.search  ? { name: { contains: q.search, mode: "insensitive" } } : {}),
        },
        include: {
          _count: { select: { versions: true, broadcasts: true } },
        },
        orderBy: [{ isDefault: "desc" }, { usageCount: "desc" }],
      });

      return rep.send({ templates });
    }
  );

  // ─── GET ONE TEMPLATE ─────────────────────────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);

      const template = await prisma.commTemplate.findFirst({
        where: { id, schoolId },
        include: {
          versions: { orderBy: { version: "desc" }, take: 10 },
          _count: { select: { broadcasts: true } },
        },
      });
      if (!template) return rep.code(404).send({ error: "Not found" });
      return rep.send({ template });
    }
  );

  // ─── CREATE TEMPLATE ──────────────────────────────────────
  app.post(P, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      // If setting as default for this type, unset existing
      if (b.isDefault && b.type) {
        await prisma.commTemplate.updateMany({
          where: { schoolId, type: b.type as any },
          data: { isDefault: false },
        });
      }

      const template = await prisma.commTemplate.create({
        data: {
          schoolId,
          name:        b.name,
          type:        b.type as any ?? "GENERAL",
          subject:     b.subject ?? null,
          body:        b.body,
          variables:   b.variables ?? [],
          channels:    b.channels as any[] ?? [],
          isDefault:   b.isDefault ?? false,
          createdById: Number(userId),
        },
      });

      // Save initial version
      await prisma.commTemplateVersion.create({
        data: {
          templateId:  template.id,
          schoolId,
          version:     1,
          name:        template.name,
          subject:     template.subject,
          body:        template.body,
          variables:   template.variables,
          changelog:   "Initial version",
          createdById: Number(userId),
        },
      });

      return rep.code(201).send({ template });
    }
  );

  // ─── UPDATE TEMPLATE (creates new version) ────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      if (b.isDefault && b.type) {
        await prisma.commTemplate.updateMany({
          where: { schoolId, type: b.type as any },
          data: { isDefault: false },
        });
      }

      const template = await prisma.commTemplate.update({
        where: { id, schoolId },
        data: {
          name:      b.name,
          subject:   b.subject,
          body:      b.body,
          variables: b.variables,
          channels:  b.channels as any[],
          isDefault: b.isDefault,
          isActive:  b.isActive,
        },
      });

      // Create new version if body changed
      if (b.body && b.saveVersion !== false) {
        const vCount = await prisma.commTemplateVersion.count({ where: { templateId: id } });
        await prisma.commTemplateVersion.create({
          data: {
            templateId:  id,
            schoolId,
            version:     vCount + 1,
            name:        b.name ?? template.name,
            subject:     b.subject ?? null,
            body:        b.body,
            variables:   b.variables ?? [],
            changelog:   b.changelog ?? "Updated",
            createdById: Number(userId),
          },
        });
      }

      return rep.send({ template });
    }
  );

  // ─── SOFT DELETE ──────────────────────────────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.commTemplate.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─── CLONE ────────────────────────────────────────────────
  app.post(`${P}/:id/clone`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const src = await prisma.commTemplate.findFirst({ where: { id, schoolId } });
      if (!src) return rep.code(404).send({ error: "Not found" });

      const clone = await prisma.commTemplate.create({
        data: {
          schoolId,
          name:        `${src.name} (Copy)`,
          type:        src.type,
          subject:     src.subject,
          body:        src.body,
          variables:   src.variables,
          channels:    src.channels,
          isDefault:   false,
          createdById: Number(userId),
        },
      });

      await prisma.commTemplateVersion.create({
        data: {
          templateId: clone.id, schoolId, version: 1,
          name: clone.name, subject: clone.subject, body: clone.body,
          variables: clone.variables, changelog: `Cloned from template #${id}`,
          createdById: Number(userId),
        },
      });

      return rep.code(201).send({ template: clone });
    }
  );

  // ─── SET DEFAULT FOR TYPE ─────────────────────────────────
  app.post(`${P}/:id/set-default`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const src = await prisma.commTemplate.findFirst({ where: { id, schoolId } });
      if (!src) return rep.code(404).send({ error: "Not found" });

      await prisma.commTemplate.updateMany({ where: { schoolId, type: src.type }, data: { isDefault: false } });
      const template = await prisma.commTemplate.update({ where: { id }, data: { isDefault: true } });
      return rep.send({ template });
    }
  );

  // ─── VERSION HISTORY ──────────────────────────────────────
  app.get(`${P}/:id/versions`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const versions = await prisma.commTemplateVersion.findMany({
        where: { templateId: id, schoolId },
        orderBy: { version: "desc" },
      });
      return rep.send({ versions });
    }
  );

  // ─── RESTORE VERSION ──────────────────────────────────────
  app.post(`${P}/:id/restore/:versionId`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id        = Number((req.params as any).id);
      const versionId = Number((req.params as any).versionId);

      const version = await prisma.commTemplateVersion.findFirst({ where: { id: versionId, templateId: id, schoolId } });
      if (!version) return rep.code(404).send({ error: "Version not found" });

      const template = await prisma.commTemplate.update({
        where: { id, schoolId },
        data: { name: version.name, subject: version.subject, body: version.body, variables: version.variables },
      });

      // Save restore as new version
      const vCount = await prisma.commTemplateVersion.count({ where: { templateId: id } });
      await prisma.commTemplateVersion.create({
        data: {
          templateId: id, schoolId, version: vCount + 1,
          name: version.name, subject: version.subject, body: version.body,
          variables: version.variables, changelog: `Restored from v${version.version}`,
          createdById: Number(userId),
        },
      });

      return rep.send({ template });
    }
  );

  // ─── PREVIEW TEMPLATE (resolve variables) ─────────────────
  app.post(`${P}/:id/preview`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const template = await prisma.commTemplate.findFirst({ where: { id, schoolId } });
      if (!template) return rep.code(404).send({ error: "Not found" });

      const sampleData: Record<string, string> = {
        "{{studentName}}":   b.studentName    ?? "Rahul Sharma",
        "{{parentName}}":    b.parentName     ?? "Mr. Sharma",
        "{{class}}":         b.class          ?? "10-A",
        "{{admissionNo}}":   b.admissionNo    ?? "ADM-2025-001",
        "{{feeDue}}":        b.feeDue         ?? "₹5,000",
        "{{dueDate}}":       b.dueDate        ?? "31 July 2025",
        "{{examDate}}":      b.examDate       ?? "15 Aug 2025",
        "{{schoolName}}":    b.schoolName     ?? "ShikshaMatrix School",
        "{{principalName}}": b.principalName  ?? "Dr. Anil Sharma",
        "{{date}}":          new Date().toLocaleDateString("en-IN"),
        ...(b.extra ?? {}),
      };

      let resolvedBody    = template.body;
      let resolvedSubject = template.subject ?? "";
      for (const [k, v] of Object.entries(sampleData)) {
        resolvedBody    = resolvedBody.replaceAll(k, v);
        resolvedSubject = resolvedSubject.replaceAll(k, v);
      }

      return rep.send({ resolvedBody, resolvedSubject, sampleData });
    }
  );

  // ─── MULTI-CHANNEL PREVIEW (same body → SMS / Email / Push) ─
  app.post(`${P}/:id/preview-all-channels`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const template = await prisma.commTemplate.findFirst({ where: { id, schoolId } });
      if (!template) return rep.code(404).send({ error: "Not found" });

      const preview: Record<string, { subject?: string; body: string; charCount: number }> = {};
      for (const channel of template.channels) {
        // SMS: max 160 chars, strip HTML
        const stripped = template.body.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        const smsBody  = stripped.slice(0, 160);
        if (channel === "SMS")              preview[channel] = { body: smsBody, charCount: smsBody.length };
        if (channel === "APP_NOTIFICATION") preview[channel] = { subject: template.subject ?? template.name, body: stripped.slice(0, 200), charCount: stripped.length };
        if (channel === "EMAIL")            preview[channel] = { subject: template.subject ?? template.name, body: template.body, charCount: template.body.length };
        if (channel === "WHATSAPP")         preview[channel] = { body: stripped.slice(0, 1024), charCount: Math.min(stripped.length, 1024) };
      }

      return rep.send({ preview, channels: template.channels });
    }
  );

  // ─── TEMPLATE ANALYTICS ───────────────────────────────────
  app.get(`${P}/analytics/usage`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [typeBreakdown, topUsed, channelBreakdown] = await Promise.all([
        prisma.commTemplate.groupBy({
          by: ["type"],
          where: { schoolId, isActive: true },
          _count: { id: true },
          _sum: { usageCount: true },
          orderBy: { _sum: { usageCount: "desc" } },
        }),
        prisma.commTemplate.findMany({
          where: { schoolId, isActive: true },
          orderBy: { usageCount: "desc" },
          take: 5,
          select: { id: true, name: true, type: true, usageCount: true, channels: true },
        }),
        // Channel distribution (flatten channels array)
        prisma.commTemplate.findMany({
          where: { schoolId, isActive: true },
          select: { channels: true },
        }),
      ]);

      // Count channel usage
      const channelCount: Record<string, number> = {};
      channelBreakdown.forEach(t => {
        (t.channels as string[]).forEach(ch => {
          channelCount[ch] = (channelCount[ch] ?? 0) + 1;
        });
      });

      return rep.send({ typeBreakdown, topUsed, channelCount });
    }
  );
}
