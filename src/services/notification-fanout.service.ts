import { prisma } from "../lib/prisma.js";
import { resolveAudienceUserIds, AudienceInput } from "./audience.service.js";
import { sendPushNotifications } from "./push-notification.service.js";
import { sendWhatsAppMessage } from "./whatsapp.service.js";

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
  /** ADDED: WhatsApp only sends if this is provided. Free text is NOT
   *  an option here — Meta requires a pre-approved message template
   *  for anything the school initiates (this is always
   *  business-initiated, never a reply), so there's no free-text
   *  fallback to silently degrade to. Omit this and WhatsApp is
   *  simply skipped for the call, same as if the school hasn't
   *  turned WhatsApp on at all. */
  whatsappTemplate?: { name: string; language?: string; params?: string[] } | null;
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

  // ── WhatsApp — only when the school has it on AND the caller gave
  // an approved template. Runs in the background; never blocks or
  // fails the rest of the notification. ──
  if (input.whatsappTemplate && commSettings?.whatsappNotificationsEnabled) {
    (async () => {
      const recipients = await prisma.user.findMany({ where: { id: { in: userIds }, phone: { not: null } }, select: { id: true, phone: true } });
      for (const r of recipients) {
        if (!r.phone) continue;
        await sendWhatsAppMessage({
          schoolId: input.schoolId, to: r.phone, userId: r.id, mode: "TEMPLATE",
          templateName: input.whatsappTemplate!.name, templateLanguage: input.whatsappTemplate!.language,
          templateParams: input.whatsappTemplate!.params, sourceCategory: input.category,
        }).catch((err) => console.log("[fanOutNotification] whatsapp send failed:", err?.message ?? err));
      }
    })();
  }

  return userIds.length;
}