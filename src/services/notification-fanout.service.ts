import { prisma } from "../lib/prisma.js";
import { resolveAudienceUserIds, AudienceInput } from "./audience.service.js";
import { sendPushNotifications } from "./push-notification.service.js";

export interface FanOutInput extends AudienceInput {
  schoolId: number;
  sourceType: "NOTICE" | "BROADCAST" | "SYSTEM";
  sourceId: number | null;
  category: string;
  priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  title: string;
  body: string;
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
    })),
  });

  // Real OS-level push — reaches the device even if the app is closed.
  // Runs after the in-app rows are safely created; a push failure never
  // undoes or blocks the notification actually existing in the inbox.
  sendPushNotifications(userIds, input.title, input.body, {
    sourceType: input.sourceType, sourceId: input.sourceId, category: input.category,
  }).catch((err) => console.log("[fanOutNotification] push send failed:", err?.message ?? err));

  return userIds.length;
}
