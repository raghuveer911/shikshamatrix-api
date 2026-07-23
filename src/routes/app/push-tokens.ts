import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

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
}
