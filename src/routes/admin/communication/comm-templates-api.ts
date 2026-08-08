// apps/api/src/routes/admin/communication/whatsapp-templates-api.ts
// ─────────────────────────────────────────────────────────────
// What the simplified school-admin UI talks to — no template names
// or bodies ever appear here, just event labels + status + an
// Enable toggle. All the Meta-facing work happens in
// whatsapp-templates.service.ts.
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { syncSchoolTemplates, refreshTemplateStatus } from "../../../services/whatsapp-templates.service.js";

export async function adminWhatsAppTemplatesRoutes(app: FastifyInstance) {
  const P = "/admin/comm/whatsapp-templates";

  // ── GET /admin/comm/whatsapp-templates ───────────────────
  // Every catalogue event, joined with this school's status —
  // NOT_SUBMITTED for anything never synced yet, so the list is
  // always complete even before the first sync runs.
  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;

    const [systemTemplates, statuses] = await Promise.all([
      prisma.systemWhatsAppTemplate.findMany({ where: { isActive: true }, orderBy: { label: "asc" } }),
      prisma.schoolWhatsAppTemplateStatus.findMany({ where: { schoolId } }),
    ]);
    const statusMap = new Map(statuses.map((s) => [s.systemTemplateId, s]));

    const items = systemTemplates.map((t) => {
      const s = statusMap.get(t.id);
      return {
        eventKey: t.eventKey, label: t.label, description: t.description,
        placeholderLabels: t.placeholderLabels,
        status: s?.status ?? "NOT_SUBMITTED",
        isEnabled: s?.isEnabled ?? false,
        rejectionReason: s?.rejectionReason ?? null,
        submittedAt: s?.submittedAt ?? null,
        approvedAt: s?.approvedAt ?? null,
        lastCheckedAt: s?.lastCheckedAt ?? null,
        systemTemplateId: t.id,
      };
    });

    const summary = {
      total: items.length,
      approved: items.filter((i) => i.status === "APPROVED").length,
      pending: items.filter((i) => i.status === "PENDING").length,
      rejected: items.filter((i) => i.status === "REJECTED").length,
      notSubmitted: items.filter((i) => i.status === "NOT_SUBMITTED").length,
      enabled: items.filter((i) => i.isEnabled).length,
    };

    return rep.send({ success: true, data: { items, summary } });
  });

  // ── POST /admin/comm/whatsapp-templates/sync ─────────────
  // Checks/submits every catalogue template against this school's
  // WABA. Safe to call repeatedly — already-tracked templates are
  // skipped (only NOT_SUBMITTED ones get checked/created).
  app.post(`${P}/sync`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const result = await syncSchoolTemplates(schoolId);
    return rep.send({
      success: true,
      message: result.checked === 0
        ? "No active WhatsApp channel found — set one up first in the Channels tab."
        : `${result.submitted} submitted, ${result.alreadyThere} already tracked, ${result.failed} failed.`,
      data: result,
    });
  });

  // ── POST /admin/comm/whatsapp-templates/:eventKey/refresh ─
  app.post(`${P}/:eventKey/refresh`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { eventKey } = req.params as { eventKey: string };

    const template = await prisma.systemWhatsAppTemplate.findUnique({ where: { eventKey } });
    if (!template) return rep.status(404).send({ success: false, message: "Unknown event." });

    const result = await refreshTemplateStatus(schoolId, template.id);
    return rep.send({ success: result.ok, message: result.ok ? `Status: ${result.status}` : result.error, data: result });
  });

  // ── PUT /admin/comm/whatsapp-templates/:eventKey/enable ──
  app.put(`${P}/:eventKey/enable`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { eventKey } = req.params as { eventKey: string };
    const b = req.body as { enabled: boolean };

    const template = await prisma.systemWhatsAppTemplate.findUnique({ where: { eventKey } });
    if (!template) return rep.status(404).send({ success: false, message: "Unknown event." });

    const row = await prisma.schoolWhatsAppTemplateStatus.findUnique({ where: { schoolId_systemTemplateId: { schoolId, systemTemplateId: template.id } } });
    if (!row) return rep.status(404).send({ success: false, message: "This template hasn't been submitted yet — run Sync first." });
    if (b.enabled && row.status !== "APPROVED") {
      return rep.status(400).send({ success: false, message: `Can't enable — Meta hasn't approved this yet (currently ${row.status}).` });
    }

    await prisma.schoolWhatsAppTemplateStatus.update({ where: { id: row.id }, data: { isEnabled: b.enabled } });
    return rep.send({ success: true, message: b.enabled ? `${template.label} enabled.` : `${template.label} disabled.` });
  });
}