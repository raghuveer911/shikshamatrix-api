// apps/api/src/services/whatsapp-templates.service.ts
// ─────────────────────────────────────────────────────────────
// The managed template system: ShikshaMatrix defines the catalogue
// ONCE (below), and this service pushes each entry onto every school's
// own WABA automatically — checking first whether it's already there
// (e.g. a school connected an existing WABA that already has these),
// and submitting it via Meta's Template Management API when it isn't.
// Schools never type a template name or write template copy; they
// only ever see a status + an Enable toggle.
//
// To add a new event in future: add one entry to CATALOGUE below and
// redeploy — syncSchoolTemplates() will pick it up and submit it to
// every school on their next sync, no other code changes needed.
// ─────────────────────────────────────────────────────────────

import { prisma } from "../lib/prisma.js";

const GRAPH_API_VERSION = "v20.0";

export interface CatalogueEntry {
  eventKey: string;
  label: string;
  description: string;
  metaTemplateName: string;
  metaLanguage: string;
  category: "AUTHENTICATION" | "MARKETING" | "UTILITY";
  bodyText: string; // {{1}}, {{2}}... placeholders, Meta's own syntax
  placeholderLabels: string[]; // same order as {{1}},{{2}} — for admin preview only
}

// The starter catalogue — matches the event list already wired
// through fee-collection.ts / student-attendance.ts / comm-broadcast-api.ts
// (category field), plus the ones discussed but not yet triggered
// from code (those just won't have anything calling them until a
// future pass wires that specific event — the template itself will
// already be submitted and ready).
export const CATALOGUE: CatalogueEntry[] = [
  { eventKey: "STUDENT_ABSENT", label: "Student Absent", description: "Sent when a student is marked absent for the day.",
    metaTemplateName: "student_absent_alert_v1", metaLanguage: "en", category: "UTILITY",
    bodyText: "Hi {{1}}, {{2}} was marked absent today ({{3}}).",
    placeholderLabels: ["Parent Name", "Student Name", "Date"] },

  { eventKey: "STUDENT_LATE", label: "Student Late", description: "Sent when a student is marked late for the day.",
    metaTemplateName: "student_late_alert_v1", metaLanguage: "en", category: "UTILITY",
    bodyText: "Hi {{1}}, {{2}} was marked late today ({{3}}).",
    placeholderLabels: ["Parent Name", "Student Name", "Date"] },

  { eventKey: "FEE_DUE", label: "Fee Due Reminder", description: "Sent ahead of a fee installment's due date.",
    metaTemplateName: "fee_due_reminder_v1", metaLanguage: "en", category: "UTILITY",
    bodyText: "Hi {{1}}, ₹{{2}} fee is due for {{3}} by {{4}}.",
    placeholderLabels: ["Parent Name", "Amount", "Student Name", "Due Date"] },

  { eventKey: "FEE_RECEIPT", label: "Fee Payment Receipt", description: "Sent right after a fee payment is collected.",
    metaTemplateName: "fee_payment_confirmation_v1", metaLanguage: "en", category: "UTILITY",
    bodyText: "Hi {{1}}, ₹{{2}} received for {{3}}. Receipt: {{4}}.",
    placeholderLabels: ["Parent Name", "Amount", "Student Name", "Receipt No"] },

  { eventKey: "LEAVE_APPROVED", label: "Leave Approved", description: "Sent when a leave request is approved.",
    metaTemplateName: "leave_approved_v1", metaLanguage: "en", category: "UTILITY",
    bodyText: "Hi {{1}}, your leave request for {{2}} has been approved.",
    placeholderLabels: ["Recipient Name", "Leave Dates"] },

  { eventKey: "LEAVE_REJECTED", label: "Leave Rejected", description: "Sent when a leave request is declined.",
    metaTemplateName: "leave_rejected_v1", metaLanguage: "en", category: "UTILITY",
    bodyText: "Hi {{1}}, your leave request for {{2}} was not approved.",
    placeholderLabels: ["Recipient Name", "Leave Dates"] },

  { eventKey: "EXAM_RESULT", label: "Exam Result Published", description: "Sent when results for an exam are published.",
    metaTemplateName: "exam_result_published_v1", metaLanguage: "en", category: "UTILITY",
    bodyText: "Hi {{1}}, {{2}}'s results for {{3}} are now available.",
    placeholderLabels: ["Parent Name", "Student Name", "Exam Name"] },

  { eventKey: "ONLINE_EXAM_ALERT", label: "Online Exam Alert", description: "Sent ahead of a scheduled online exam.",
    metaTemplateName: "online_exam_alert_v1", metaLanguage: "en", category: "UTILITY",
    bodyText: "Hi {{1}}, {{2}}'s online exam '{{3}}' starts at {{4}}.",
    placeholderLabels: ["Parent Name", "Student Name", "Exam Name", "Start Time"] },

  { eventKey: "OFFLINE_EXAM_ALERT", label: "Offline Exam Alert", description: "Sent ahead of a scheduled offline/in-person exam.",
    metaTemplateName: "offline_exam_alert_v1", metaLanguage: "en", category: "UTILITY",
    bodyText: "Hi {{1}}, {{2}}'s exam '{{3}}' is scheduled on {{4}}.",
    placeholderLabels: ["Parent Name", "Student Name", "Exam Name", "Date"] },

  { eventKey: "NOTICE", label: "School Notice", description: "Sent when a new notice is published.",
    metaTemplateName: "school_notice_v1", metaLanguage: "en", category: "UTILITY",
    bodyText: "Hi {{1}}, new notice: {{2}}.",
    placeholderLabels: ["Recipient Name", "Notice Title"] },

  { eventKey: "BROADCAST", label: "General Broadcast", description: "Used by the Broadcast Center for general announcements.",
    metaTemplateName: "general_broadcast_v1", metaLanguage: "en", category: "UTILITY",
    bodyText: "Hi {{1}}, {{2}}.",
    placeholderLabels: ["Recipient Name", "Message"] },

  { eventKey: "ADMISSION_CONFIRMED", label: "Admission Confirmation", description: "Sent when a new admission is confirmed.",
    metaTemplateName: "admission_confirmed_v1", metaLanguage: "en", category: "UTILITY",
    bodyText: "Hi {{1}}, {{2}}'s admission to {{3}} is confirmed.",
    placeholderLabels: ["Parent Name", "Student Name", "Class"] },

  { eventKey: "TRANSPORT_ALERT", label: "Transport Alert", description: "Sent for bus/route updates for a student.",
    metaTemplateName: "transport_alert_v1", metaLanguage: "en", category: "UTILITY",
    bodyText: "Hi {{1}}, {{2}}'s bus ({{3}}) update: {{4}}.",
    placeholderLabels: ["Parent Name", "Student Name", "Route/Bus", "Update"] },
];

/** Idempotent — inserts any catalogue entries that don't exist yet as
 *  SystemWhatsAppTemplate rows, updates the reference copy (label/
 *  description/placeholderLabels) on existing ones, but never touches
 *  a row's metaTemplateName once created (renaming would silently
 *  orphan whatever was already submitted to schools' WABAs under the
 *  old name). Safe to call on every sync — cheap, no-op after the
 *  first run per entry. */
async function ensureCatalogueSeeded() {
  for (const entry of CATALOGUE) {
    await prisma.systemWhatsAppTemplate.upsert({
      where: { eventKey: entry.eventKey },
      create: {
        eventKey: entry.eventKey, label: entry.label, description: entry.description,
        metaTemplateName: entry.metaTemplateName, metaLanguage: entry.metaLanguage,
        category: entry.category as any, bodyText: entry.bodyText, placeholderLabels: entry.placeholderLabels,
      },
      update: { label: entry.label, description: entry.description, placeholderLabels: entry.placeholderLabels },
    });
  }
}

async function getWhatsAppCreds(schoolId: number) {
  const config = await prisma.commChannelConfig.findFirst({ where: { schoolId, type: "WHATSAPP_API", isActive: true }, orderBy: { isPrimary: "desc" } });
  if (!config) return null;
  const cfg = config.config as any;
  if (!cfg?.apiKey || !cfg?.businessAccountId) return null;
  return { accessToken: cfg.apiKey as string, wabaId: cfg.businessAccountId as string };
}

function metaComponents(bodyText: string) {
  return [{ type: "BODY", text: bodyText }];
}

/** For one school: makes sure every active catalogue template either
 *  already exists (found + status pulled) or gets submitted fresh.
 *  Call this after a school saves/tests their WhatsApp channel, and
 *  optionally on a schedule to catch anything that failed earlier
 *  (e.g. Meta was briefly down). Never throws — failures on one
 *  template don't stop the rest from being checked/submitted. */
export async function syncSchoolTemplates(schoolId: number): Promise<{ checked: number; submitted: number; alreadyThere: number; failed: number }> {
  await ensureCatalogueSeeded();
  const creds = await getWhatsAppCreds(schoolId);
  if (!creds) return { checked: 0, submitted: 0, alreadyThere: 0, failed: 0 };

  const systemTemplates = await prisma.systemWhatsAppTemplate.findMany({ where: { isActive: true } });
  let submitted = 0, alreadyThere = 0, failed = 0;

  for (const t of systemTemplates) {
    try {
      const existing = await prisma.schoolWhatsAppTemplateStatus.findUnique({
        where: { schoolId_systemTemplateId: { schoolId, systemTemplateId: t.id } },
      });
      // Already tracked and not in a state that needs re-submitting.
      if (existing && existing.status !== "NOT_SUBMITTED") { alreadyThere++; continue; }

      // Check Meta first — the school might have connected a WABA
      // that already has this template (e.g. migrating from another
      // system, or a previous ShikshaMatrix submission).
      const lookup = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.wabaId}/message_templates?name=${t.metaTemplateName}`,
        { headers: { Authorization: `Bearer ${creds.accessToken}` } },
      );
      const lookupJson: any = await lookup.json();
      const found = lookupJson?.data?.[0];

      if (found) {
        await prisma.schoolWhatsAppTemplateStatus.upsert({
          where: { schoolId_systemTemplateId: { schoolId, systemTemplateId: t.id } },
          create: { schoolId, systemTemplateId: t.id, metaTemplateId: found.id, status: mapMetaStatus(found.status), submittedAt: new Date(), approvedAt: found.status === "APPROVED" ? new Date() : null, lastCheckedAt: new Date() },
          update: { metaTemplateId: found.id, status: mapMetaStatus(found.status), approvedAt: found.status === "APPROVED" ? new Date() : null, lastCheckedAt: new Date() },
        });
        alreadyThere++;
        continue;
      }

      // Not found — submit it fresh via Meta's Template Management API.
      const createRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.wabaId}/message_templates`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: t.metaTemplateName, language: t.metaLanguage, category: t.category, components: metaComponents(t.bodyText) }),
      });
      const createJson: any = await createRes.json();

      if (!createRes.ok || createJson.error) {
        await prisma.schoolWhatsAppTemplateStatus.upsert({
          where: { schoolId_systemTemplateId: { schoolId, systemTemplateId: t.id } },
          create: { schoolId, systemTemplateId: t.id, status: "REJECTED", rejectionReason: createJson.error?.message ?? "Submission failed", lastCheckedAt: new Date() },
          update: { status: "REJECTED", rejectionReason: createJson.error?.message ?? "Submission failed", lastCheckedAt: new Date() },
        });
        failed++;
        continue;
      }

      await prisma.schoolWhatsAppTemplateStatus.upsert({
        where: { schoolId_systemTemplateId: { schoolId, systemTemplateId: t.id } },
        create: { schoolId, systemTemplateId: t.id, metaTemplateId: createJson.id, status: "PENDING", submittedAt: new Date(), lastCheckedAt: new Date() },
        update: { metaTemplateId: createJson.id, status: "PENDING", submittedAt: new Date(), lastCheckedAt: new Date() },
      });
      submitted++;
    } catch (err: any) {
      console.log(`[whatsapp-templates] sync failed for ${t.eventKey}:`, err?.message ?? err);
      failed++;
    }
  }

  return { checked: systemTemplates.length, submitted, alreadyThere, failed };
}

function mapMetaStatus(metaStatus: string): "PENDING" | "APPROVED" | "REJECTED" | "PAUSED" {
  if (metaStatus === "APPROVED") return "APPROVED";
  if (metaStatus === "REJECTED") return "REJECTED";
  if (metaStatus === "PAUSED" || metaStatus === "DISABLED") return "PAUSED";
  return "PENDING";
}

/** Re-checks one school's one template against Meta right now —
 *  what the frontend's "Refresh" button calls, for when the school
 *  doesn't want to wait for the webhook or a scheduled resync. */
export async function refreshTemplateStatus(schoolId: number, systemTemplateId: number): Promise<{ ok: boolean; status?: string; error?: string }> {
  const creds = await getWhatsAppCreds(schoolId);
  if (!creds) return { ok: false, error: "No active WhatsApp channel configured for this school." };

  const row = await prisma.schoolWhatsAppTemplateStatus.findUnique({
    where: { schoolId_systemTemplateId: { schoolId, systemTemplateId } },
    include: { systemTemplate: true },
  });
  if (!row) return { ok: false, error: "This template hasn't been submitted yet — run Sync first." };

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.wabaId}/message_templates?name=${row.systemTemplate.metaTemplateName}`,
      { headers: { Authorization: `Bearer ${creds.accessToken}` } },
    );
    const json: any = await res.json();
    const found = json?.data?.[0];
    if (!found) return { ok: false, error: "Meta doesn't show this template anymore — it may have been deleted on their side." };

    const status = mapMetaStatus(found.status);
    await prisma.schoolWhatsAppTemplateStatus.update({
      where: { id: row.id },
      data: { status, rejectionReason: found.rejected_reason ?? null, approvedAt: status === "APPROVED" ? (row.approvedAt ?? new Date()) : row.approvedAt, lastCheckedAt: new Date() },
    });
    return { ok: true, status };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Network error" };
  }
}

/** What notification-fanout.service.ts calls to find out whether (and
 *  how) to send a given event over WhatsApp for a school — returns
 *  null when there's nothing to send with (not approved, or the
 *  school hasn't enabled it), so callers can skip cleanly instead of
 *  guessing or sending free text. */
export async function getEnabledTemplateForEvent(schoolId: number, eventKey: string): Promise<{ metaTemplateName: string; metaLanguage: string } | null> {
  const row = await prisma.schoolWhatsAppTemplateStatus.findFirst({
    where: { schoolId, isEnabled: true, status: "APPROVED", systemTemplate: { eventKey, isActive: true } },
    include: { systemTemplate: true },
  });
  if (!row) return null;
  return { metaTemplateName: row.systemTemplate.metaTemplateName, metaLanguage: row.systemTemplate.metaLanguage };
}