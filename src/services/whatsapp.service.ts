// apps/api/src/services/whatsapp.service.ts
// ─────────────────────────────────────────────────────────────
// Real Meta WhatsApp Cloud API integration. Previously nothing in
// this codebase actually sent a WhatsApp message — the Broadcast
// composer's WHATSAPP channel option and both "Test" buttons (Settings
// → Notifications, and Communication → Settings → Channels) were all
// simulated (see the removed NotifSettings-based test handler, and
// comm-settings-api.ts's old `Math.random() > 0.1` fake test).
//
// IMPORTANT — read before wiring this into more places:
// Meta's Cloud API only allows freeform text messages inside a 24-hour
// "customer service window" that opens when the *user* messages the
// school first. A message the SCHOOL initiates (a fee reminder, an
// attendance alert — anything not a reply) falls outside that window
// and MUST use a pre-approved message TEMPLATE, not free text. Meta
// rejects business-initiated free text with an error. Both send modes
// are implemented below — template is what production fee/attendance
// notifications should actually use once the school has templates
// approved in Meta Business Manager; sendText is here for the "Test"
// button and for genuine within-window replies (e.g. Communication's
// direct-message/chat features, if channel = WhatsApp there).
// ─────────────────────────────────────────────────────────────

import { prisma } from "../lib/prisma.js";

const GRAPH_API_VERSION = "v20.0";

interface WhatsAppCredentials {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
}

async function getActiveWhatsAppConfig(schoolId: number): Promise<WhatsAppCredentials | null> {
  const config = await prisma.commChannelConfig.findFirst({
    where: { schoolId, type: "WHATSAPP_API", isActive: true },
    orderBy: { isPrimary: "desc" }, // prefer the primary config if more than one is set up
  });
  if (!config) return null;
  const cfg = config.config as any;
  if (!cfg?.accessToken || !cfg?.phoneNumberId) return null;
  return { accessToken: cfg.accessToken, phoneNumberId: cfg.phoneNumberId, businessAccountId: cfg.businessAccountId };
}

function normalizePhone(phone: string): string {
  // Meta expects digits only, with country code, no leading +/00/spaces.
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.length === 10) return `91${digits}`; // bare 10-digit Indian mobile — assume domestic
  return digits;
}

async function callGraphApi(phoneNumberId: string, accessToken: string, body: any): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json: any = await res.json();
    if (!res.ok || json.error) {
      const msg = json.error?.message ?? `HTTP ${res.status}`;
      console.log("[whatsapp] send failed:", msg, JSON.stringify(json.error ?? {}));
      return { ok: false, error: msg };
    }
    return { ok: true, messageId: json.messages?.[0]?.id };
  } catch (err: any) {
    console.log("[whatsapp] request failed:", err?.message ?? err);
    return { ok: false, error: err?.message ?? "Network error" };
  }
}

export interface SendWhatsAppInput {
  schoolId: number;
  to: string; // phone number, any reasonable format
  userId?: number | null; // for CommDelivery.userId when this recipient is a known app user
  /** "TEXT" only works within Meta's 24h customer-service window (the
   *  user messaged first) — use for the Test button or genuine
   *  in-window replies. Business-initiated notifications must use
   *  TEMPLATE. */
  mode: "TEXT" | "TEMPLATE";
  text?: string; // required when mode = TEXT
  templateName?: string; // required when mode = TEMPLATE — must exist & be approved in Meta Business Manager
  templateLanguage?: string; // default "en"
  templateParams?: string[]; // positional {{1}}, {{2}}… body variables
  /** Ties this send to a Broadcast row for the delivery log. Omit for
   *  system-generated sends (fee/attendance) and set sourceCategory
   *  instead. */
  broadcastId?: number | null;
  sourceCategory?: string | null; // e.g. "FEES", "ATTENDANCE" — only meaningful when broadcastId is null
}

/** Sends one WhatsApp message via Meta Cloud API and logs the attempt
 *  into CommDelivery regardless of outcome, so Communication →
 *  Delivery Logs is a genuine single source of truth for WhatsApp
 *  activity — broadcast-sent and system-generated alike. */
export async function sendWhatsAppMessage(input: SendWhatsAppInput): Promise<{ ok: boolean; error?: string }> {
  const creds = await getActiveWhatsAppConfig(input.schoolId);
  const to = normalizePhone(input.to);

  const logBase = {
    broadcastId: input.broadcastId ?? null,
    sourceCategory: input.broadcastId ? null : (input.sourceCategory ?? "SYSTEM"),
    userId: input.userId ?? null,
    phone: to,
    channel: "WHATSAPP" as any,
  };

  if (!creds) {
    await prisma.commDelivery.create({
      data: { ...logBase, status: "FAILED", failedAt: new Date(), failureReason: "No active WhatsApp channel configured for this school." },
    });
    return { ok: false, error: "No active WhatsApp channel configured. Set it up in Communication → Settings → Channels." };
  }

  const body = input.mode === "TEMPLATE"
    ? {
        messaging_product: "whatsapp", to, type: "template",
        template: {
          name: input.templateName,
          language: { code: input.templateLanguage ?? "en" },
          ...(input.templateParams?.length
            ? { components: [{ type: "body", parameters: input.templateParams.map((p) => ({ type: "text", text: p })) }] }
            : {}),
        },
      }
    : { messaging_product: "whatsapp", to, type: "text", text: { body: input.text ?? "" } };

  const result = await callGraphApi(creds.phoneNumberId, creds.accessToken, body);

  await prisma.commDelivery.create({
    data: {
      ...logBase,
      status: result.ok ? "SENT" : "FAILED",
      sentAt: result.ok ? new Date() : undefined,
      failedAt: result.ok ? undefined : new Date(),
      failureReason: result.ok ? null : result.error,
      providerMsgId: result.messageId ?? null,
    },
  });

  // Keep the channel config's running stats honest — same fields the
  // Channels tab already displays (sentToday/sentTotal/failedTotal).
  await prisma.commChannelConfig.updateMany({
    where: { schoolId: input.schoolId, type: "WHATSAPP_API", isActive: true },
    data: result.ok ? { sentToday: { increment: 1 }, sentTotal: { increment: 1 } } : { failedTotal: { increment: 1 } },
  }).catch(() => {}); // best-effort — never let a stats update fail the actual send result

  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Real credential check for the "Test" button — validates the
 *  access token + phone number ID actually work by reading the phone
 *  number's own metadata from Meta, which succeeds or fails purely on
 *  the credentials without sending anything or requiring a template.
 *  Replaces the old `Math.random() > 0.1` simulation. */
export async function testWhatsAppConnection(schoolId: number, configId: number): Promise<{ ok: boolean; error?: string }> {
  const config = await prisma.commChannelConfig.findFirst({ where: { id: configId, schoolId, type: "WHATSAPP_API" } });
  if (!config) return { ok: false, error: "Channel not found." };

  const cfg = config.config as any;
  if (!cfg?.accessToken || !cfg?.phoneNumberId) return { ok: false, error: "Access token and Phone Number ID are both required." };

  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${cfg.phoneNumberId}?fields=verified_name,display_phone_number`, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
    });
    const json: any = await res.json();
    if (!res.ok || json.error) return { ok: false, error: json.error?.message ?? `HTTP ${res.status}` };
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Network error" };
  }
}