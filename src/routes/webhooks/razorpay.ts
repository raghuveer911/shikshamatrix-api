import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { invalidateCapabilityCache } from "../../middleware/checkCapability.js";
import { sendEmail } from "../../lib/mailer.js";
import { commissionPercentForLevel } from "../../utils/agentLevel.js";

// Razorpay signs the RAW request body — if Fastify's default JSON parser
// re-serializes it before we verify, whitespace/key-order differences
// will break the signature check. This scoped parser (only applies to
// routes registered inside this plugin, thanks to Fastify's encapsulation)
// captures the raw bytes instead of parsing them as JSON.
export async function razorpayWebhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body)
  );

  app.post(
    "/webhooks/razorpay",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!env.RAZORPAY_WEBHOOK_SECRET) {
        // Gateway not configured — nothing to verify or process.
        return reply.status(503).send({ success: false, message: "Payment gateway not configured." });
      }

      const rawBody = request.body as Buffer;
      const signature = request.headers["x-razorpay-signature"] as string | undefined;

      if (!signature) {
        return reply.status(400).send({ success: false, message: "Missing signature." });
      }

      const expectedSignature = crypto
        .createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex");

      if (expectedSignature !== signature) {
        request.log.warn("Razorpay webhook signature mismatch");
        return reply.status(400).send({ success: false, message: "Invalid signature." });
      }

      const event = JSON.parse(rawBody.toString("utf-8"));
      // Razorpay doesn't always send a stable top-level event id, so fall
      // back to a composite of event type + payment/order id, which is
      // stable across retries of the SAME delivery.
      const paymentEntity = event.payload?.payment?.entity;
      const eventId: string = event.id ?? `${event.event}_${paymentEntity?.id ?? paymentEntity?.order_id ?? "unknown"}`;

      const already = await prisma.processedWebhookEvent.findUnique({ where: { eventId } });
      if (already) {
        // Already handled this exact delivery — ack without reprocessing.
        return reply.send({ success: true });
      }

      if (event.event === "payment.captured" && paymentEntity) {
        await handlePaymentCaptured(paymentEntity);
      }
      // Other event types (payment.failed, order.paid, etc.) can be added
      // here as separate branches when needed.

      await prisma.processedWebhookEvent.create({
        data: { eventId, eventType: event.event ?? "unknown" },
      });

      return reply.send({ success: true });
    }
  );
}

async function handlePaymentCaptured(paymentEntity: any) {
  const orderId: string = paymentEntity.order_id;
  const paymentId: string = paymentEntity.id;
  const amountPaid = paymentEntity.amount / 100; // paise -> rupees

  const pending = await prisma.pendingCheckout.findUnique({ where: { razorpayOrderId: orderId } });
  if (!pending || pending.status !== "PENDING") {
    // Already processed, or we have no record of this order (shouldn't
    // happen in normal flow) — nothing more to do.
    return;
  }

  const plan = await prisma.subscriptionPlan.findUnique({ where: { tier: pending.tier as any } });
  if (!plan) return;

  const now = new Date();
  let cycleEnd: Date;
  if (pending.billingCycleType === "ANNUAL") {
    cycleEnd = new Date(now);
    cycleEnd.setMonth(cycleEnd.getMonth() + 12);
  } else if (pending.billingCycleType === "ACADEMIC_SESSION") {
    const currentYear = await prisma.academicYear.findFirst({ where: { schoolId: pending.schoolId, isCurrent: true } });
    cycleEnd = currentYear?.endDate ?? new Date(now.setMonth(now.getMonth() + 1));
  } else {
    cycleEnd = new Date(now);
    cycleEnd.setMonth(cycleEnd.getMonth() + 1);
  }

  await prisma.$transaction(async (tx) => {
    const existingSub = await tx.schoolSubscription.findUnique({ where: { schoolId: pending.schoolId }, include: { creditWallet: true } });

    const subscription = existingSub
      ? await tx.schoolSubscription.update({
          where: { schoolId: pending.schoolId },
          data: {
            planId: plan.id,
            status: "ACTIVE",
            isTrial: false,
            source: "SELF_PURCHASED",
            billingCycleStart: now,
            billingCycleEnd: cycleEnd,
            billingCycleType: pending.billingCycleType,
            autoRenew: true,
          },
        })
      : await tx.schoolSubscription.create({
          data: {
            schoolId: pending.schoolId,
            planId: plan.id,
            status: "ACTIVE",
            source: "SELF_PURCHASED",
            billingCycleStart: now,
            billingCycleEnd: cycleEnd,
            billingCycleType: pending.billingCycleType,
            autoRenew: true,
            creditWallet: {
              create: { smsBalance: plan.smsCredits, whatsappBalance: plan.whatsappCredits },
            },
          },
        });

    // Credits are scoped to the billing cycle, not a forever-wallet — every
    // successful payment (new subscription OR renewal/upgrade) resets the
    // balance to the new plan's fresh allocation, so unused credits never
    // silently roll over past the cycle they were granted for.
    if (existingSub?.creditWallet) {
      await tx.creditWallet.update({
        where: { id: existingSub.creditWallet.id },
        data: { smsBalance: plan.smsCredits, whatsappBalance: plan.whatsappCredits, lastResetAt: now },
      });
      await tx.creditTransaction.createMany({
        data: [
          { walletId: existingSub.creditWallet.id, type: "SMS", amount: plan.smsCredits, reason: "cycle_reset" },
          { walletId: existingSub.creditWallet.id, type: "WHATSAPP", amount: plan.whatsappCredits, reason: "cycle_reset" },
        ],
      });
    } else if (existingSub && !existingSub.creditWallet) {
      // Existing subscription somehow has no wallet yet (edge case) — create one now.
      await tx.creditWallet.create({
        data: { schoolSubscriptionId: existingSub.id, smsBalance: plan.smsCredits, whatsappBalance: plan.whatsappCredits },
      });
    }

    await tx.pendingCheckout.update({ where: { id: pending.id }, data: { status: "PAID" } });

    const history = await tx.subscriptionHistory.create({
      data: {
        subscriptionId: subscription.id,
        schoolId: pending.schoolId,
        event: "PAYMENT",
        description: `Payment received for ${pending.tier} plan`,
        amount: amountPaid,
        paymentId,
      },
    });

    await tx.subscriptionHistory.update({
      where: { id: history.id },
      data: { invoiceUrl: `/admin/settings/subscription/invoice/${history.id}` },
    });

    // ── Agent commission ──────────────────────────────────
    // If this school is mapped to a revenue-sharing agent, credit the
    // commission for this exact payment — one row per payment event,
    // never spread across the billing cycle.
    const agentMapping = await tx.agentSchoolMapping.findUnique({
      where: { schoolId: pending.schoolId },
    });
    if (agentMapping && agentMapping.status === "ACTIVE") {
      const agent = await tx.agent.findUnique({ where: { id: agentMapping.agentId } });
      if (agent && agent.status === "ACTIVE") {
        const commissionPercent = commissionPercentForLevel(agent.level);
        const commissionAmount = Math.round(amountPaid * (commissionPercent / 100) * 100) / 100;
        await tx.commissionTransaction.create({
          data: {
            agentId: agent.id,
            schoolId: pending.schoolId,
            subscriptionHistoryId: history.id,
            paymentAmount: amountPaid,
            billingCycleType: pending.billingCycleType,
            agentLevelAtTime: agent.level,
            commissionPercent,
            commissionAmount,
          },
        });
      }
    }

    // Redeem the discount code now — only on confirmed payment, never
    // on an abandoned checkout.
    if (pending.discountCodeId) {
      await tx.discountRedemption.create({
        data: {
          discountCodeId: pending.discountCodeId,
          schoolId: pending.schoolId,
          amountDiscounted: Number(pending.amount) - amountPaid >= 0 ? Number(pending.amount) - amountPaid : null,
          razorpayOrderId: orderId,
        },
      });
      await tx.discountCode.update({
        where: { id: pending.discountCodeId },
        data: { redemptionCount: { increment: 1 } },
      });
    }

    return { historyId: history.id, subscriptionId: subscription.id };
  });

  invalidateCapabilityCache(pending.schoolId);

  // Fire-and-forget the receipt email — a failure here should never
  // undo the payment/activation that already succeeded above.
  sendPaymentReceiptEmail(pending.schoolId, pending.tier, amountPaid, paymentId).catch((err) =>
    console.error("[webhook] Failed to send payment receipt email:", err)
  );
}

async function sendPaymentReceiptEmail(schoolId: number, tier: string, amount: number, paymentId: string) {
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: { name: true, adminEmail: true },
  });
  if (!school?.adminEmail) return;

  await sendEmail({
    to: school.adminEmail,
    subject: `Payment received — ShikshaMatrix ${tier} plan`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #6366f1;">Payment Successful</h2>
        <p>Hi ${school.name} team,</p>
        <p>We've received your payment of <strong>₹${amount.toLocaleString("en-IN")}</strong> for the <strong>${tier}</strong> plan.</p>
        <p style="color: #666; font-size: 13px;">Payment ID: ${paymentId}</p>
        <p>You can view and download your invoice anytime from Settings → Subscription → History in your ShikshaMatrix dashboard.</p>
        <p style="color: #999; font-size: 12px; margin-top: 24px;">This is an automated message from ShikshaMatrix.</p>
      </div>
    `,
  });
}
