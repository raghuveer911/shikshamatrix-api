// services/trial.service.ts

import { prisma } from '../lib/prisma.js';
import { SubscriptionTier, SubscriptionSource } from '@prisma/client';

export class TrialError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const TRIAL_DURATION_DAYS = 30;
const TRIAL_TIER = SubscriptionTier.PROFESSIONAL; // full access during trial, always

export async function startTrialIfEligible(schoolId: number) {
  // One-time enforcement: TrialHistory row existing = trial already used, ever.
  // This survives cancellations/re-signups since it's never deleted.
  const existing = await prisma.trialHistory.findUnique({ where: { schoolId } });
  if (existing) {
    throw new TrialError(
      'TRIAL_ALREADY_USED',
      `This school already used its one-time free trial on ${existing.usedAt.toDateString()}.`
    );
  }

  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { tier: TRIAL_TIER } });
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

  const subscription = await prisma.$transaction(async (tx) => {
    const sub = await tx.schoolSubscription.create({
      data: {
        schoolId,
        planId: plan.id,
        status: 'ACTIVE',
        source: SubscriptionSource.TRIAL,
        isTrial: true,
        trialEndsAt,
        billingCycleStart: now,
        billingCycleEnd: trialEndsAt,
        autoRenew: false, // trial never auto-renews into a paid plan silently
        creditWallet: {
          create: {
            smsBalance: plan.smsCredits,
            whatsappBalance: plan.whatsappCredits,
          },
        },
      },
    });

    await tx.trialHistory.create({
      data: { schoolId, trialTier: TRIAL_TIER },
    });

    await tx.subscriptionAuditLog.create({
      data: {
        schoolSubscriptionId: sub.id,
        action: 'TRIAL_STARTED',
        toValue: TRIAL_TIER,
      },
    });

    return sub;
  });

  return subscription;
}

export async function hasUsedTrial(schoolId: number): Promise<boolean> {
  const existing = await prisma.trialHistory.findUnique({ where: { schoolId } });
  return !!existing;
}
