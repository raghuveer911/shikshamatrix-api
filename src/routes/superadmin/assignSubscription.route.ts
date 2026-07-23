// routes/superadmin/assignSubscription.route.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticateSuperAdmin } from "../../middleware/authenticate.js";
import { invalidateCapabilityCache } from "../../middleware/checkCapability.js";
import { SubscriptionTier, SubscriptionSource } from "@prisma/client";
import type { SuperAdminJwtPayload } from "../../types/index.js";

interface AssignSubscriptionBody {
  schoolId: number;
  tier: SubscriptionTier;
  note?: string;              // e.g. "Pilot partnership Q3 2026"
  cycleLengthMonths?: number; // default 12
}

export async function superAdminAssignSubscriptionRoutes(app: FastifyInstance) {
  app.post(
    "/superadmin/subscriptions/assign",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, tier, note, cycleLengthMonths = 12 } = request.body as AssignSubscriptionBody;
      const { superAdminId } = request.user as SuperAdminJwtPayload;

      const plan = await prisma.subscriptionPlan.findUnique({ where: { tier } });
      if (!plan) {
        return reply.code(404).send({ error: "PLAN_NOT_FOUND", message: `No plan found for tier ${tier}.` });
      }

      const now = new Date();
      const cycleEnd = new Date(now);
      cycleEnd.setMonth(cycleEnd.getMonth() + cycleLengthMonths);

      const existing = await prisma.schoolSubscription.findUnique({ where: { schoolId } });

      const subscription = existing
        ? await prisma.schoolSubscription.update({
            where: { schoolId },
            data: {
              planId: plan.id,
              status: "ACTIVE",
              source: SubscriptionSource.ADMIN_ASSIGNED,
              isTrial: false,
              trialEndsAt: null,
              assignedByAdminId: superAdminId,
              assignmentNote: note,
              billingCycleStart: now,
              billingCycleEnd: cycleEnd,
              autoRenew: false, // admin-assigned plans don't silently start charging — renewal is a manual decision
            },
          })
        : await prisma.schoolSubscription.create({
            data: {
              schoolId,
              planId: plan.id,
              status: "ACTIVE",
              source: SubscriptionSource.ADMIN_ASSIGNED,
              assignedByAdminId: superAdminId,
              assignmentNote: note,
              billingCycleStart: now,
              billingCycleEnd: cycleEnd,
              autoRenew: false,
              creditWallet: {
                create: {
                  smsBalance: plan.smsCredits,
                  whatsappBalance: plan.whatsappCredits,
                },
              },
            },
          });

      await prisma.subscriptionAuditLog.create({
        data: {
          schoolSubscriptionId: subscription.id,
          action: "ADMIN_ASSIGNED",
          toValue: tier,
          actorUserId: superAdminId,
        },
      });

      invalidateCapabilityCache(schoolId);

      return reply.send({ success: true, subscription });
    }
  );
}
