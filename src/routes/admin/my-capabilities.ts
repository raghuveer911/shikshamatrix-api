import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import { prisma } from "../../lib/prisma.js";

// ── GET /admin/my-subscription/capabilities ────────────────
// Returns the current school's plan tier + capability flags, so a single
// page can mix Economy+ and Professional-only actions and conditionally
// show/hide or disable specific buttons — without a full page lock.
// Not gated behind requireCapability itself: any authenticated user can
// call this (including a school with no active subscription, which just
// gets an empty capabilities object back).
export async function myCapabilitiesRoutes(app: FastifyInstance) {
  app.get(
    "/admin/my-subscription/capabilities",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const sub = await prisma.schoolSubscription.findUnique({
        where: { schoolId },
        include: { plan: true },
      });

      if (!sub || sub.status === "EXPIRED" || sub.status === "CANCELLED") {
        return reply.send({
          success: true,
          data: { tier: null, status: sub?.status ?? "NONE", capabilities: {} },
        });
      }

      return reply.send({
        success: true,
        data: {
          tier: sub.plan.tier,
          status: sub.status,
          capabilities: sub.plan.capabilities as Record<string, boolean>,
        },
      });
    }
  );
}
