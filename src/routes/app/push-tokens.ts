import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { authenticate } from "../../middleware/authenticate.js";
import { sendPushNotifications } from "../../services/push-notification.service.js";

export async function appPushTokenRoutes(app: FastifyInstance) {
  const P = "/app/push-token";

  // ── POST /app/push-token ────────────────────────────────
  // Called once after login (and again whenever Expo issues a new token,
  // e.g. after reinstall) — upserts by token so the same device calling
  // this twice doesn't create duplicate rows, and re-registering under a
  // different user (e.g. shared device, different account login) moves
  // the token to the new owner instead of erroring.
  app.post(P, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = req as any;
      const b = req.body as { token?: string; platform?: string; deviceInfo?: string };

      if (!b.token?.trim()) {
        return reply.status(400).send({ success: false, message: "token is required." });
      }

      await prisma.pushToken.upsert({
        where: { token: b.token },
        create: { userId: Number(userId), token: b.token, platform: b.platform ?? null, deviceInfo: b.deviceInfo ?? null },
        update: { userId: Number(userId), platform: b.platform ?? null, deviceInfo: b.deviceInfo ?? null },
      });

      return reply.send({ success: true, message: "Push token registered." });
    }
  );

  // ── DELETE /app/push-token ──────────────────────────────
  // Called on logout so a shared/reused device stops getting another
  // user's notifications after sign-out.
  app.delete(P, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const b = req.body as { token?: string };
      if (!b.token?.trim()) return reply.status(400).send({ success: false, message: "token is required." });

      await prisma.pushToken.deleteMany({ where: { token: b.token } });
      return reply.send({ success: true });
    }
  );

  // ── ADDED: GET /admin/push-token/status/:userId ──────────
  // Answers "did the notification we sent this person ever have
  // anywhere to go?" without digging through server logs — lists every
  // device registered for push under this user, so "in-app arrived but
  // the phone never buzzed" can be told apart from "no token at all"
  // (permission never granted, or running in Expo Go on Android where
  // push is structurally unsupported since SDK 53) vs "token exists,
  // so the failure is on Expo's/FCM's/APNs's side — check server logs
  // around the time it was sent".
  app.get("/admin/push-token/status/:userId", { preHandler: [authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = req.params as { userId: string };
      const tokens = await prisma.pushToken.findMany({
        where: { userId: parseInt(userId) },
        select: { platform: true, deviceInfo: true, createdAt: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
      });
      return reply.send({
        success: true,
        data: {
          hasAnyToken: tokens.length > 0,
          tokenCount: tokens.length,
          devices: tokens,
        },
      });
    }
  );

  // ── ADDED: POST /admin/push-token/test/:userId ───────────
  // Sends one real test push to every device this user has registered,
  // and returns Expo's actual sent/failed counts — the fastest way to
  // confirm end-to-end delivery is working for a specific account
  // without waiting for a real fee payment or attendance mark to test it.
  app.post("/admin/push-token/test/:userId", { preHandler: [authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = req.params as { userId: string };
      const result = await sendPushNotifications(
        [parseInt(userId)],
        "Test notification",
        "If you can see this, push delivery is working for this device.",
        { category: "TEST" },
      );
      const tokenCount = await prisma.pushToken.count({ where: { userId: parseInt(userId) } });
      return reply.send({
        success: true,
        message: tokenCount === 0
          ? "This user has no registered device — nothing was sent. They need to open the app and grant notification permission at least once."
          : `Sent to ${result.sent} of ${tokenCount} device(s), ${result.failed} failed. Check server logs for [push] entries around this request for the reason on any failures.`,
        data: { tokenCount, ...result },
      });
    }
  );
}