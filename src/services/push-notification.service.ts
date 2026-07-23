import { prisma } from "../lib/prisma.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  sound?: "default";
  priority?: "default" | "high";
}

// Expo caps batches at 100 messages per request.
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Fans out an actual push notification to every device registered for the
// given users. Best-effort: a push failure never blocks the in-app
// Notification row from having already been created — this runs after
// that, and errors here are logged, not thrown, so a flaky push provider
// can't break the rest of a Notice/Broadcast send.
export async function sendPushNotifications(
  userIds: number[],
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<{ sent: number; failed: number }> {
  if (userIds.length === 0) return { sent: 0, failed: 0 };

  const tokens = await prisma.pushToken.findMany({ where: { userId: { in: userIds } } });
  if (tokens.length === 0) return { sent: 0, failed: 0 };

  const messages: PushMessage[] = tokens.map((t) => ({
    to: t.token, title: title.slice(0, 300), body: body.slice(0, 1000),
    data: { ...data }, sound: "default", priority: "high",
  }));

  let sent = 0;
  let failed = 0;
  const staleTokens: string[] = [];

  for (const batch of chunk(messages, 100)) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "gzip, deflate" },
        body: JSON.stringify(batch),
      });
      const json: any = await res.json();
      const results = json?.data ?? [];
      results.forEach((r: any, i: number) => {
        if (r.status === "ok") sent++;
        else {
          failed++;
          // DeviceNotRegistered means the token is dead (app uninstalled,
          // reinstalled with a new token, etc.) — worth pruning so future
          // sends don't keep paying for a dead device.
          if (r.details?.error === "DeviceNotRegistered") staleTokens.push(batch[i].to);
          console.log("[push] delivery failed:", r.message ?? r.details?.error ?? "unknown error");
        }
      });
    } catch (err: any) {
      failed += batch.length;
      console.log("[push] batch send failed:", err?.message ?? err);
    }
  }

  if (staleTokens.length > 0) {
    await prisma.pushToken.deleteMany({ where: { token: { in: staleTokens } } }).catch(() => {});
  }

  return { sent, failed };
}
