// jobs/subscriptionCron.ts
// Register this once at server startup (e.g. in your Fastify plugin bootstrap).
// Requires: npm install node-cron @types/node-cron

import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { invalidateCapabilityCache } from '../middleware/checkCapability.js';
import { sendEmail } from '../lib/mailer.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function registerSubscriptionCron() {
  // Runs daily at midnight IST — adjust timezone in your process env (TZ=Asia/Kolkata)
  cron.schedule('0 0 * * *', async () => {
    const now = new Date();
    const oneMonthAgo = new Date(now);
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    const fifteenDaysAgo = new Date(now.getTime() - 15 * ONE_DAY_MS);

    // 1. Reset monthly credits for wallets whose cycle rolled over
    //    (unused credits do NOT carry forward — that's intentional)
    const dueForReset = await prisma.creditWallet.findMany({
      where: { lastResetAt: { lt: oneMonthAgo } },
      include: { schoolSubscription: { include: { plan: true } } },
    });

    for (const wallet of dueForReset) {
      const plan = wallet.schoolSubscription.plan;
      await prisma.creditWallet.update({
        where: { id: wallet.id },
        data: {
          smsBalance: plan.smsCredits,
          whatsappBalance: plan.whatsappCredits,
          lastResetAt: now,
        },
      });
      await prisma.creditTransaction.create({
        data: { walletId: wallet.id, type: 'SMS', amount: plan.smsCredits, reason: 'monthly_reset' },
      });
    }

    // 2. ACTIVE -> GRACE: billing cycle ended, start the 15-day soft-lock window
    const rolledIntoGrace = await prisma.schoolSubscription.findMany({
      where: { billingCycleEnd: { lt: now }, status: 'ACTIVE' },
      select: { id: true, schoolId: true },
    });
    await prisma.schoolSubscription.updateMany({
      where: { id: { in: rolledIntoGrace.map((s) => s.id) } },
      data: { status: 'GRACE' },
    });
    rolledIntoGrace.forEach((s) => invalidateCapabilityCache(s.schoolId));

    // 3. GRACE -> EXPIRED: 15-day grace period is over, lock feature access
    const expired = await prisma.schoolSubscription.findMany({
      where: { billingCycleEnd: { lt: fifteenDaysAgo }, status: 'GRACE' },
      select: { id: true, schoolId: true },
    });
    await prisma.schoolSubscription.updateMany({
      where: { id: { in: expired.map((s) => s.id) } },
      data: { status: 'EXPIRED' },
    });
    expired.forEach((s) => invalidateCapabilityCache(s.schoolId));

    // 4. Renewal / trial-ending reminders
    const reminderCounts = await sendRenewalReminders(now);

    console.log(
      `[subscriptionCron] reset=${dueForReset.length} grace=${rolledIntoGrace.length} expired=${expired.length} reminders=${reminderCounts}`
    );
  });
}

// ─── Renewal reminders ──────────────────────────────────────────
// Industry-standard cadence for manually-renewed (non-auto-charge) plans:
//   T-7 days   — "heads up" notice
//   T-1 day    — "urgent" notice
//   Grace Day 1  — "your plan just expired, renew to avoid disruption"
//   Grace Day 10 — "5 days left before your account is paused" (grace is 15 days)
// Each stage is logged as its own SubscriptionHistory event so a stage is
// never sent twice for the same billing cycle (checked against events
// created after the current billingCycleStart).
const REMINDER_STAGES = [
  { event: 'REMINDER_T7', daysFromEnd: 7, statuses: ['ACTIVE'] as const, urgent: false },
  { event: 'REMINDER_T1', daysFromEnd: 1, statuses: ['ACTIVE'] as const, urgent: true },
  { event: 'REMINDER_GRACE1', daysFromEnd: -1, statuses: ['GRACE'] as const, urgent: true },
  { event: 'REMINDER_GRACE10', daysFromEnd: -10, statuses: ['GRACE'] as const, urgent: true },
];

async function sendRenewalReminders(now: Date): Promise<number> {
  let sentCount = 0;

  for (const stage of REMINDER_STAGES) {
    const targetDate = new Date(now.getTime() - stage.daysFromEnd * ONE_DAY_MS);
    // Match subscriptions whose billingCycleEnd falls on the target day
    // (a 24h window around it, so the daily cron catches it exactly once).
    const windowStart = new Date(targetDate);
    windowStart.setHours(0, 0, 0, 0);
    const windowEnd = new Date(windowStart.getTime() + ONE_DAY_MS);

    const candidates = await prisma.schoolSubscription.findMany({
      where: {
        status: { in: stage.statuses as any },
        isTrial: false, // trial endings get their own separate reminders below
        billingCycleEnd: { gte: windowStart, lt: windowEnd },
      },
      include: {
        plan: true,
        school: { select: { id: true, name: true, adminEmail: true } },
      },
    });

    for (const sub of candidates) {
      const alreadySent = await prisma.subscriptionHistory.findFirst({
        where: {
          subscriptionId: sub.id,
          event: stage.event,
          createdAt: { gte: sub.billingCycleStart },
        },
      });
      if (alreadySent) continue;

      if (sub.school.adminEmail) {
        await sendEmail({
          to: sub.school.adminEmail,
          subject: stage.urgent
            ? `Action needed: your ${sub.plan.name} plan ${stage.event.includes('GRACE') ? 'has expired' : 'renews soon'}`
            : `Reminder: your ${sub.plan.name} plan renews in 7 days`,
          html: renewalReminderHtml(sub.school.name, sub.plan.name, sub.billingCycleEnd, stage.event),
        });
      }

      await prisma.subscriptionHistory.create({
        data: {
          subscriptionId: sub.id,
          schoolId: sub.schoolId,
          event: stage.event,
          description: `Renewal reminder (${stage.event}) sent`,
        },
      });
      sentCount++;
    }
  }

  // Trial-ending reminders (T-7, T-1) — separate, friendlier tone since
  // nothing has been paid for yet.
  for (const { event, daysFromEnd } of [
    { event: 'REMINDER_TRIAL_T7', daysFromEnd: 7 },
    { event: 'REMINDER_TRIAL_T1', daysFromEnd: 1 },
  ]) {
    const targetDate = new Date(now.getTime() + daysFromEnd * ONE_DAY_MS);
    const windowStart = new Date(targetDate);
    windowStart.setHours(0, 0, 0, 0);
    const windowEnd = new Date(windowStart.getTime() + ONE_DAY_MS);

    const trialsEnding = await prisma.schoolSubscription.findMany({
      where: {
        status: 'ACTIVE',
        isTrial: true,
        trialEndsAt: { gte: windowStart, lt: windowEnd },
      },
      include: { plan: true, school: { select: { id: true, name: true, adminEmail: true } } },
    });

    for (const sub of trialsEnding) {
      const alreadySent = await prisma.subscriptionHistory.findFirst({
        where: { subscriptionId: sub.id, event },
      });
      if (alreadySent) continue;

      if (sub.school.adminEmail) {
        await sendEmail({
          to: sub.school.adminEmail,
          subject: `Your ShikshaMatrix free trial ends in ${daysFromEnd} day${daysFromEnd > 1 ? 's' : ''}`,
          html: trialReminderHtml(sub.school.name, sub.trialEndsAt!, daysFromEnd),
        });
      }

      await prisma.subscriptionHistory.create({
        data: {
          subscriptionId: sub.id,
          schoolId: sub.schoolId,
          event,
          description: `Trial-ending reminder (${daysFromEnd}-day) sent`,
        },
      });
      sentCount++;
    }
  }

  return sentCount;
}

function renewalReminderHtml(schoolName: string, planName: string, renewsOn: Date, stage: string): string {
  const dateStr = renewsOn.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const isGrace = stage.includes('GRACE');
  const heading = isGrace ? "Your plan has expired" : "Your plan renews soon";
  const body = isGrace
    ? `Your <strong>${planName}</strong> plan expired on ${dateStr}. You have a short grace period before some features are paused — renew now to avoid any disruption.`
    : `Your <strong>${planName}</strong> plan is due for renewal on <strong>${dateStr}</strong>. Renew from your ShikshaMatrix dashboard to keep everything running smoothly.`;
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: ${isGrace ? '#dc2626' : '#6366f1'};">${heading}</h2>
      <p>Hi ${schoolName} team,</p>
      <p>${body}</p>
      <p><a href="https://shikshamatrix.in/dashboard/settings/subscription" style="color: #6366f1;">Renew your plan →</a></p>
      <p style="color: #999; font-size: 12px; margin-top: 24px;">This is an automated reminder from ShikshaMatrix.</p>
    </div>
  `;
}

function trialReminderHtml(schoolName: string, trialEndsAt: Date, daysLeft: number): string {
  const dateStr = trialEndsAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #6366f1;">Your free trial ends in ${daysLeft} day${daysLeft > 1 ? 's' : ''}</h2>
      <p>Hi ${schoolName} team,</p>
      <p>Your 30-day Professional trial ends on <strong>${dateStr}</strong>. Choose a plan before then to keep using ShikshaMatrix without interruption.</p>
      <p><a href="https://shikshamatrix.in/dashboard/settings/subscription" style="color: #6366f1;">Choose a plan →</a></p>
      <p style="color: #999; font-size: 12px; margin-top: 24px;">This is an automated reminder from ShikshaMatrix.</p>
    </div>
  `;
}
