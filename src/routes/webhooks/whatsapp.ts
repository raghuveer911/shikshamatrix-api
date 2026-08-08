// apps/api/src/routes/webhooks/whatsapp.ts
// ─────────────────────────────────────────────────────────────
// Meta's WhatsApp webhooks are configured once at the Meta App level
// and fire for every WABA connected through that app — every school's
// events land on this SAME URL. Each event carries the WABA ID, which
// is how a specific school gets identified (matched against
// CommChannelConfig.config.businessAccountId).
//
// Setup needed on Meta's side (one-time, app-level, not per school):
//   1. Meta App dashboard → WhatsApp → Configuration → Webhook
//   2. Callback URL: https://api.shikshamatrix.in/webhooks/whatsapp
//   3. Verify token: must match WHATSAPP_WEBHOOK_VERIFY_TOKEN below
//      (set this env var to any random string you choose)
//   4. Subscribe to the "message_template_status_update" field
//
// Without this webhook, approvals still get picked up — just only
// when the "Refresh" button is clicked or the next sync runs — so
// this isn't a hard blocker to test with, just faster once it's set up.
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";

export async function whatsappWebhookRoutes(app: FastifyInstance) {

  // ── Meta's verification handshake ────────────────────────
  app.get("/webhooks/whatsapp", async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string>;
    const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

    if (!verifyToken) {
      return reply.status(503).send("WHATSAPP_WEBHOOK_VERIFY_TOKEN not configured.");
    }
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === verifyToken) {
      return reply.status(200).send(q["hub.challenge"]);
    }
    return reply.status(403).send("Verification failed.");
  });

  // ── Real events ───────────────────────────────────────────
  app.post("/webhooks/whatsapp", async (request: FastifyRequest, reply: FastifyReply) => {
    // Acknowledge immediately — Meta retries aggressively on non-2xx
    // or slow responses; do the actual work after responding.
    reply.status(200).send({ received: true });

    try {
      const body = request.body as any;
      for (const entry of body?.entry ?? []) {
        const wabaId = entry.id;
        for (const change of entry.changes ?? []) {
          if (change.field !== "message_template_status_update") continue;
          const v = change.value ?? {};
          await handleTemplateStatusUpdate(wabaId, v.message_template_name, v.event, v.reason ?? null);
        }
      }
    } catch (err: any) {
      console.log("[whatsapp-webhook] processing failed:", err?.message ?? err);
    }
  });
}

async function handleTemplateStatusUpdate(wabaId: string, templateName: string, event: string, reason: string | null) {
  if (!wabaId || !templateName) return;

  // Find which school this WABA belongs to — config.businessAccountId
  // isn't an indexed/queryable JSON field, so this scans active
  // WhatsApp channel configs. Fine at the scale this runs at (one
  // lookup per incoming webhook event, not per message).
  const configs = await prisma.commChannelConfig.findMany({ where: { type: "WHATSAPP_API", isActive: true } });
  const match = configs.find((c) => (c.config as any)?.businessAccountId === wabaId);
  if (!match) {
    console.log(`[whatsapp-webhook] no school found for WABA ${wabaId} — ignoring.`);
    return;
  }

  const template = await prisma.systemWhatsAppTemplate.findFirst({ where: { metaTemplateName: templateName } });
  if (!template) return; // not one of ours — a school might have unrelated templates on the same WABA

  const status = event === "APPROVED" ? "APPROVED" : event === "REJECTED" ? "REJECTED" : (event === "PAUSED" || event === "DISABLED") ? "PAUSED" : "PENDING";

  await prisma.schoolWhatsAppTemplateStatus.updateMany({
    where: { schoolId: match.schoolId, systemTemplateId: template.id },
    data: { status: status as any, rejectionReason: reason, approvedAt: status === "APPROVED" ? new Date() : undefined, lastCheckedAt: new Date() },
  });
  console.log(`[whatsapp-webhook] ${template.eventKey} for school ${match.schoolId} → ${status}`);
}