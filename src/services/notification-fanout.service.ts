import { prisma } from "../lib/prisma.js";
import { resolveAudienceUserIds, AudienceInput } from "./audience.service.js";
import { sendPushNotifications } from "./push-notification.service.js";
import { sendWhatsAppMessage } from "./whatsapp.service.js";
import { getEnabledTemplateForEvent } from "./whatsapp-templates.service.js";

export interface FanOutInput extends AudienceInput {
  schoolId: number;
  sourceType: "NOTICE" | "BROADCAST" | "SYSTEM";
  sourceId: number | null;
  category: string;
  priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  title: string;
  body: string;
  /** ADDED: where tapping the notification should navigate, e.g.
   *  "/parent/fees?studentId=42". Stored on the row so the in-app
   *  notification list/bell can redirect on click, and passed through
   *  to the push payload so the mobile app can deep-link on tap too. */
  actionUrl?: string | null;
  /** CHANGED: was `whatsappTemplate: {name, language, params}` where
   *  the caller had to know Meta's exact template name. Now callers
   *  just say WHICH event this is (must match a
   *  SystemWhatsAppTemplate.eventKey, e.g. "FEE_RECEIPT",
   *  "STUDENT_ABSENT") and supply the positional values in the same
   *  order as that template's placeholderLabels — the actual Meta
   *  template name/language for this school is looked up
   *  automatically via getEnabledTemplateForEvent, and WhatsApp is
   *  cleanly skipped (not faked) if the school hasn't enabled it yet. */
  whatsappEventKey?: string | null;
  whatsappParams?: string[];
}

// Returns the number of recipients notified. Silently notifies zero people
// for audiences that can't be resolved yet (e.g. ALL_PARENTS) rather than
// throwing — a Notice/Broadcast should still successfully publish/send
// even if one target group isn't wired up yet.
export async function fanOutNotification(input: FanOutInput): Promise<number> {
  const userIds = await resolveAudienceUserIds(input.schoolId, {
    audienceType: input.audienceType,
    targetClassIds: input.targetClassIds,
    targetUserIds: input.targetUserIds,
  });

  if (userIds.length === 0) return 0;

  await prisma.notification.createMany({
    data: userIds.map((userId) => ({
      schoolId: input.schoolId,
      userId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      category: input.category,
      priority: input.priority ?? "NORMAL",
      title: input.title,
      body: input.body,
      actionUrl: input.actionUrl ?? null,
    })),
  });

  // ── Push — respects the school's master on/off switch, default on ──
  const commSettings = await prisma.commSettings.findUnique({ where: { schoolId: input.schoolId } }).catch(() => null);
  const pushOn = commSettings?.pushNotificationsEnabled ?? true;
  if (pushOn) {
    sendPushNotifications(userIds, input.title, input.body, {
      sourceType: input.sourceType, sourceId: input.sourceId, category: input.category,
      actionUrl: input.actionUrl ?? null,
    }).catch((err) => console.log("[fanOutNotification] push send failed:", err?.message ?? err));
  }

  // ── WhatsApp — only when the school has this specific event
  // enabled AND Meta has approved the managed template for it. Runs
  // in the background; never blocks or fails the rest of the
  // notification. ──
  if (input.whatsappEventKey && commSettings?.whatsappNotificationsEnabled) {
    (async () => {
      const tmpl = await getEnabledTemplateForEvent(input.schoolId, input.whatsappEventKey!);
      if (!tmpl) return; // not approved / not enabled — skip cleanly, don't fake it

      const recipients = await prisma.user.findMany({ where: { id: { in: userIds }, phone: { not: null } }, select: { id: true, phone: true } });
      for (const r of recipients) {
        if (!r.phone) continue;
        await sendWhatsAppMessage({
          schoolId: input.schoolId, to: r.phone, userId: r.id, mode: "TEMPLATE",
          templateName: tmpl.metaTemplateName, templateLanguage: tmpl.metaLanguage,
          templateParams: input.whatsappParams, sourceCategory: input.category,
        }).catch((err) => console.log("[fanOutNotification] whatsapp send failed:", err?.message ?? err));
      }
    })();
  }

  return userIds.length;
}