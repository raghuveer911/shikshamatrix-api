import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import { prisma } from "../../lib/prisma.js";
import { startTrialIfEligible, hasUsedTrial, TrialError } from "../../services/trial.service.js";
import { invalidateCapabilityCache } from "../../middleware/checkCapability.js";
import { getRazorpayClient } from "../../lib/razorpay.js";
import { env } from "../../config/env.js";
import { generateInvoicePdf } from "../../lib/invoice.js";
import { getStorageUsageGB } from "../../services/storage.service.js";

// All routes here are intentionally NOT gated behind requireCapability —
// a school with no plan, an expired plan, or any plan at all must always
// be able to reach these to see plans, start a trial, or (later) pay.
export async function subscriptionSelfServiceRoutes(app: FastifyInstance) {

  // ── GET /admin/settings/subscription ────────────────────
  // Current plan + status + billing cycle + credits, whether the
  // one-time trial has already been used, and the full plan list for
  // the comparison table — all in one call for the Subscription page.
  app.get(
    "/admin/settings/subscription",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const [sub, usedTrial, plans, activeStudentCount, activeStaffCount, storageUsedGB] = await Promise.all([
        prisma.schoolSubscription.findUnique({
          where: { schoolId },
          include: { plan: true, creditWallet: true },
        }),
        hasUsedTrial(schoolId),
        prisma.subscriptionPlan.findMany({
          where: { tier: { in: ["ECONOMY", "ESSENTIAL", "PROFESSIONAL"] } },
          orderBy: { monthlyPrice: "asc" },
          select: {
            id: true, tier: true, name: true,
            monthlyPrice: true, perStudentPrice: true,
            maxStudents: true, minStudents: true, maxStaff: true, storageGB: true,
            smsCredits: true, whatsappCredits: true,
          },
        }),
        // Ground truth — actual active students, not the (often stale)
        // School.totalStudents counter field.
        prisma.student.count({ where: { schoolId, isActive: true } }),
        prisma.staff.count({ where: { schoolId, isActive: true } }),
        getStorageUsageGB(schoolId),
      ]);

      const subscription = sub && {
        id: sub.id,
        status: sub.status,
        isTrial: sub.isTrial,
        trialEndsAt: sub.trialEndsAt,
        billingCycleEnd: sub.billingCycleEnd,
        billingCycleType: sub.billingCycleType,
        plan: { tier: sub.plan.tier, name: sub.plan.name, storageGB: sub.plan.storageGB, smsCredits: sub.plan.smsCredits, whatsappCredits: sub.plan.whatsappCredits },
        creditWallet: sub.creditWallet
          ? { smsBalance: sub.creditWallet.smsBalance, whatsappBalance: sub.creditWallet.whatsappBalance }
          : null,
      };

      return reply.send({
        success: true,
        data: {
          subscription: subscription ?? null,
          hasUsedTrial: usedTrial,
          plans,
          activeStudentCount,
          activeStaffCount,
          storageUsedGB,
        },
      });
    }
  );

  // ── POST /admin/settings/subscription/start-trial ───────
  // One-time free trial (Professional tier, 30 days).
  app.post(
    "/admin/settings/subscription/start-trial",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const existing = await prisma.schoolSubscription.findUnique({ where: { schoolId } });
      if (existing) {
        return reply.status(409).send({
          success: false,
          message: "Your school already has a subscription — trial isn't available.",
        });
      }

      try {
        const sub = await startTrialIfEligible(schoolId);
        invalidateCapabilityCache(schoolId);

        await prisma.subscriptionHistory.create({
          data: {
            subscriptionId: sub.id,
            schoolId,
            event: "CREATED",
            description: "Free 30-day Professional trial started",
          },
        });

        return reply.send({
          success: true,
          message: "Your 30-day Professional trial has started!",
          data: { subscription: sub },
        });
      } catch (err) {
        if (err instanceof TrialError) {
          return reply.status(409).send({ success: false, message: err.message });
        }
        throw err;
      }
    }
  );

  // ── GET /admin/settings/subscription/history ────────────
  // Timeline of subscription events (created, renewed, upgraded, payments)
  // for the Subscription History page.
  app.get(
    "/admin/settings/subscription/history",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const history = await prisma.subscriptionHistory.findMany({
        where: { schoolId },
        orderBy: { createdAt: "desc" },
      });

      return reply.send({ success: true, data: { history } });
    }
  );

  // ── POST /admin/settings/subscription/validate-discount ─
  // Checks a discount code without redeeming it — used to preview the
  // discount on the checkout screen before the school commits to paying.
  app.post(
    "/admin/settings/subscription/validate-discount",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { code, tier } = request.body as { code: string; tier: "ECONOMY" | "ESSENTIAL" | "PROFESSIONAL" };

      const result = await validateDiscountCode(code, schoolId, tier);
      if (!result.valid) {
        return reply.status(400).send({ success: false, message: result.reason });
      }

      return reply.send({
        success: true,
        data: {
          code: result.discount!.code,
          type: result.discount!.type,
          value: result.discount!.value,
        },
      });
    }
  );

  // ── POST /admin/settings/subscription/checkout ──────────
  // Creates a real Razorpay order when the gateway is configured
  // (RAZORPAY_KEY_ID/SECRET set); otherwise falls back to the stub
  // response so the frontend flow still works end-to-end in dev.
  // Discount codes are VALIDATED here but NOT redeemed yet — redemption
  // happens in the webhook, only once payment.captured actually fires,
  // so an abandoned checkout never burns a one-time code.

  // ── GET /admin/settings/subscription/cycle-pricing ──────
  // Preview the amount + discount % for a given tier/billing-cycle
  // combination WITHOUT creating a Razorpay order — used to show the
  // dynamic "X% off" badge live as the school picks a cycle in the UI.
  app.get(
    "/admin/settings/subscription/cycle-pricing",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { tier, billingCycleType } = request.query as {
        tier: "ECONOMY" | "ESSENTIAL" | "PROFESSIONAL";
        billingCycleType?: "MONTHLY" | "ANNUAL" | "ACADEMIC_SESSION";
      };
      const cycleType = billingCycleType ?? "MONTHLY";

      const [plan, activeStudentCount, currentAcademicYear] = await Promise.all([
        prisma.subscriptionPlan.findUnique({ where: { tier } }),
        prisma.student.count({ where: { schoolId, isActive: true } }),
        prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } }),
      ]);
      if (!plan) return reply.status(404).send({ success: false, message: `No plan found for tier ${tier}.` });

      const billedStudentCount = Math.max(activeStudentCount, plan.minStudents);
      const monthlyAmount = plan.perStudentPrice ? Number(plan.perStudentPrice) * billedStudentCount : Number(plan.monthlyPrice);

      const monthsRemainingInSession = currentAcademicYear
        ? Math.max(0, (currentAcademicYear.endDate.getTime() - Date.now()) / (30 * 24 * 60 * 60 * 1000))
        : 0;
      const discountPercent = getTieredDiscountPercent(monthsRemainingInSession);

      let cycleMonths: number;
      if (cycleType === "ANNUAL") cycleMonths = 12;
      else if (cycleType === "ACADEMIC_SESSION") cycleMonths = Math.max(1, Math.ceil(monthsRemainingInSession));
      else cycleMonths = 1;

      const preDiscountAmount = monthlyAmount * cycleMonths;
      const amount = cycleType === "MONTHLY" ? preDiscountAmount : Math.round(preDiscountAmount * (1 - discountPercent / 100));

      return reply.send({
        success: true,
        data: {
          amount,
          discountPercent: cycleType === "MONTHLY" ? 0 : discountPercent,
          hasAcademicYear: !!currentAcademicYear,
          cycleAvailable: cycleType !== "ACADEMIC_SESSION" || !!currentAcademicYear,
        },
      });
    }
  );

  app.post(
    "/admin/settings/subscription/checkout",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { tier, billingCycleType, discountCode } = request.body as {
        tier: "ECONOMY" | "ESSENTIAL" | "PROFESSIONAL";
        billingCycleType?: "MONTHLY" | "ANNUAL" | "ACADEMIC_SESSION";
        discountCode?: string;
      };
      const cycleType = billingCycleType ?? "MONTHLY";

      const [plan, activeStudentCount, currentAcademicYear] = await Promise.all([
        prisma.subscriptionPlan.findUnique({ where: { tier } }),
        prisma.student.count({ where: { schoolId, isActive: true } }),
        prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } }),
      ]);
      if (!plan) {
        return reply.status(404).send({ success: false, message: `No plan found for tier ${tier}.` });
      }
      if (cycleType === "ACADEMIC_SESSION" && !currentAcademicYear) {
        return reply.status(400).send({
          success: false,
          message: "No current academic session found — set one up under Academic Sessions first, or choose Monthly/Annual billing.",
        });
      }

      let appliedDiscount: { code: string; type: string; value: number } | null = null;
      let discountCodeId: number | null = null;
      if (discountCode?.trim()) {
        const result = await validateDiscountCode(discountCode, schoolId, tier);
        if (!result.valid) {
          return reply.status(400).send({ success: false, message: result.reason });
        }
        appliedDiscount = {
          code: result.discount!.code,
          type: result.discount!.type,
          value: Number(result.discount!.value),
        };
        discountCodeId = result.discount!.id;
      }

      if (plan.maxStudents > 0 && activeStudentCount > plan.maxStudents) {
        return reply.status(400).send({
          success: false,
          message: `Your school has ${activeStudentCount} students, which is above the ${plan.name} plan's limit of ${plan.maxStudents}. Please choose a higher plan.`,
        });
      }

      // Billed count respects the plan's billing floor (e.g. Economy bills
      // for a minimum of 100 students even if the school has fewer) —
      // this must match exactly what the pricing preview showed the school.
      const billedStudentCount = Math.max(activeStudentCount, plan.minStudents);

      const monthlyAmount = plan.perStudentPrice
        ? Number(plan.perStudentPrice) * billedStudentCount
        : Number(plan.monthlyPrice);

      // Both Annual and Academic Session discounts scale with how much of
      // the school's CURRENT academic year is still ahead of them — the
      // earlier in their session they commit, the bigger the incentive.
      // Annual always bills for 12 months of access; Academic Session
      // bills only for the months actually remaining till session end.
      const monthsRemainingInSession = currentAcademicYear
        ? Math.max(0, (currentAcademicYear.endDate.getTime() - Date.now()) / (30 * 24 * 60 * 60 * 1000))
        : 0;
      const discountPercent = getTieredDiscountPercent(monthsRemainingInSession);

      let cycleMonths: number;
      let cycleLabel: string;
      if (cycleType === "ANNUAL") {
        cycleMonths = 12;
        cycleLabel = "Annual";
      } else if (cycleType === "ACADEMIC_SESSION") {
        cycleMonths = Math.max(1, Math.ceil(monthsRemainingInSession));
        cycleLabel = `Academic Session (${currentAcademicYear!.name})`;
      } else {
        cycleMonths = 1;
        cycleLabel = "Monthly";
      }

      const preDiscountAmount = monthlyAmount * cycleMonths;
      const baseAmount = cycleType === "MONTHLY" ? preDiscountAmount : Math.round(preDiscountAmount * (1 - discountPercent / 100));

      const finalAmount = appliedDiscount
        ? appliedDiscount.type === "PERCENTAGE"
          ? Math.round(baseAmount * (1 - appliedDiscount.value / 100))
          : Math.max(0, baseAmount - appliedDiscount.value)
        : baseAmount;

      const razorpay = getRazorpayClient();

      if (!razorpay) {
        // Gateway not configured yet — stub response so the frontend can
        // still be built/tested end-to-end.
        return reply.send({
          success: true,
          message: "Checkout not yet live — payment gateway integration pending.",
          data: {
            orderId: `stub_order_${schoolId}_${Date.now()}`,
            amount: finalAmount,
            currency: "INR",
            tier,
            billingCycleType: cycleType,
            cycleLabel,
            cycleDiscountPercent: discountPercent,
            appliedDiscount,
            gatewayReady: false,
          },
        });
      }

      // Real flow — create the Razorpay order and stash a PendingCheckout
      // row so the webhook can find its way back to this school/tier/code.
      const order = await razorpay.orders.create({
        amount: Math.round(finalAmount * 100), // paise
        currency: "INR",
        notes: { schoolId: String(schoolId), tier, billingCycleType: cycleType, discountCode: appliedDiscount?.code ?? "" },
      });

      await prisma.pendingCheckout.create({
        data: {
          schoolId,
          razorpayOrderId: order.id,
          tier,
          billingCycleType: cycleType,
          amount: finalAmount,
          discountCodeId,
          status: "PENDING",
        },
      });

      return reply.send({
        success: true,
        data: {
          orderId: order.id,
          amount: finalAmount,
          currency: "INR",
          keyId: env.RAZORPAY_KEY_ID,
          tier,
          billingCycleType: cycleType,
          cycleLabel,
          cycleDiscountPercent: discountPercent,
          appliedDiscount,
          gatewayReady: true,
        },
      });
    }
  );

  // ── GET /admin/settings/subscription/checkout-status ────
  // Polled by the frontend after Razorpay's client-side success callback
  // fires — the webhook is the source of truth for activation, and it
  // usually lands within a few seconds, so the UI polls this briefly
  // instead of trusting the client-side callback alone.
  app.get(
    "/admin/settings/subscription/checkout-status",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { orderId } = request.query as { orderId: string };

      if (!orderId) {
        return reply.status(400).send({ success: false, message: "orderId is required." });
      }

      const pending = await prisma.pendingCheckout.findUnique({ where: { razorpayOrderId: orderId } });
      if (!pending || pending.schoolId !== schoolId) {
        return reply.status(404).send({ success: false, message: "Checkout not found." });
      }

      return reply.send({ success: true, data: { status: pending.status } });
    }
  );

  // ── GET /admin/settings/subscription/history ────────────
  // (Already exists elsewhere in this file — see below.)

  // ── GET /admin/settings/subscription/invoice/:historyId ─
  // Regenerates the invoice PDF live from the stored payment record —
  // no file storage needed, and it can never go stale relative to the
  // underlying SubscriptionHistory row.
  app.get(
    "/admin/settings/subscription/invoice/:historyId",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { historyId } = request.params as { historyId: string };

      const history = await prisma.subscriptionHistory.findUnique({
        where: { id: parseInt(historyId) },
        include: { subscription: { include: { plan: true } } },
      });

      if (!history || history.schoolId !== schoolId || history.event !== "PAYMENT") {
        return reply.status(404).send({ success: false, message: "Invoice not found." });
      }

      const school = await prisma.school.findUnique({
        where: { id: schoolId },
        select: { name: true, address: true, city: true, state: true, email: true },
      });

      const pdfBuffer = await generateInvoicePdf({
        invoiceNumber: `INV-${history.id.toString().padStart(6, "0")}`,
        issuedAt: history.createdAt,
        schoolName: school?.name ?? "School",
        schoolAddress: school ? `${school.address}, ${school.city}, ${school.state}` : null,
        schoolEmail: school?.email,
        planName: history.subscription.plan.name,
        billingPeriodStart: history.subscription.billingCycleStart,
        billingPeriodEnd: history.subscription.billingCycleEnd,
        amountPaid: Number(history.amount ?? 0),
        paymentId: history.paymentId,
      });

      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename=invoice-${history.id}.pdf`)
        .send(pdfBuffer);
    }
  );

  // ── GET /admin/settings/subscription/downgrade-preview ──
  // Compares the school's CURRENT active plan against a target tier and
  // returns which named features would be lost — used to show a
  // confirmation warning before a downgrade checkout, not after.
  app.get(
    "/admin/settings/subscription/downgrade-preview",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { targetTier } = request.query as { targetTier: string };

      const [sub, targetPlan] = await Promise.all([
        prisma.schoolSubscription.findUnique({ where: { schoolId }, include: { plan: true } }),
        prisma.subscriptionPlan.findUnique({ where: { tier: targetTier as any } }),
      ]);

      if (!sub || !targetPlan) {
        return reply.send({ success: true, data: { isDowngrade: false, lostFeatures: [] } });
      }

      const isDowngrade = TIER_RANK[targetTier] < TIER_RANK[sub.plan.tier];
      if (!isDowngrade) {
        return reply.send({ success: true, data: { isDowngrade: false, lostFeatures: [] } });
      }

      const currentCaps = sub.plan.capabilities as Record<string, boolean>;
      const targetCaps = targetPlan.capabilities as Record<string, boolean>;

      const lostKeys = Object.keys(currentCaps).filter((k) => currentCaps[k] && !targetCaps[k]);
      const lostFeatures = [...new Set(lostKeys.map((k) => FEATURE_LABELS[k] ?? k))].sort();

      // Also flag if the school's current student/staff/storage usage would
      // exceed the target plan's caps — a downgrade that outright breaks
      // capacity, not just loses premium features.
      const [studentCount, staffCount, storageUsedGB] = await Promise.all([
        prisma.student.count({ where: { schoolId, isActive: true } }),
        prisma.staff.count({ where: { schoolId, isActive: true } }),
        getStorageUsageGB(schoolId),
      ]);
      const capacityWarnings: string[] = [];
      if (targetPlan.maxStudents > 0 && studentCount > targetPlan.maxStudents) {
        capacityWarnings.push(`You have ${studentCount} students — above the ${targetPlan.name} limit of ${targetPlan.maxStudents}.`);
      }
      if (targetPlan.maxStaff > 0 && staffCount > targetPlan.maxStaff) {
        capacityWarnings.push(`You have ${staffCount} staff — above the ${targetPlan.name} limit of ${targetPlan.maxStaff}.`);
      }
      if (storageUsedGB > targetPlan.storageGB) {
        capacityWarnings.push(
          `You're using ${storageUsedGB}GB of storage — above the ${targetPlan.name} limit of ${targetPlan.storageGB}GB. New uploads will be blocked until you're back under the limit; existing files stay safe but locked from editing.`
        );
      }

      return reply.send({
        success: true,
        data: { isDowngrade: true, lostFeatures, capacityWarnings },
      });
    }
  );
}

// Human-readable labels for capability keys that matter most in a
// downgrade warning — grouped loosely by module. Keys not listed here
// fall back to showing the raw key, which is acceptable since those are
// minor/rarely-hit cases.
const FEATURE_LABELS: Record<string, string> = {
  "hr.core": "HR: Attendance, Leave & Payroll",
  "hr.recruitment": "HR: Recruitment",
  "hr.performanceManagement": "HR: Performance Management",
  "hr.reportsAnalytics": "HR: Advanced Reports",
  "finance.onlinePayment": "Online Fee Payment",
  "finance.dueManagement": "Fee Due Management",
  "finance.advancedReports": "Advanced Finance Reports",
  "accounts.basic": "Accounts Module",
  "accounts.advanced": "Accounts: Audit & Compliance",
  "onlineExams.core": "Online Exams",
  "onlineExams.questionBank": "Online Exams: Question Bank",
  "onlineExams.liveMonitoring": "Online Exams: Live Monitoring",
  "onlineExams.securityCenter": "Online Exams: Security Center",
  "onlineExams.advancedReports": "Online Exams: Advanced Reports",
  "library.digital": "Digital Library",
  "library.reservations": "Library Reservations",
  "library.inventoryTracking": "Library Inventory Tracking",
  "library.analytics": "Library Analytics",
  "frontOffice.pipeline": "Front Office: Enquiry Pipeline",
  "frontOffice.complaintManagement": "Front Office: Complaint Management",
  "communication.whatsapp": "WhatsApp Communication",
  "communication.email": "Email Communication",
  "communication.automatedTriggers": "Automated Communication Triggers",
  "students.bulkTools": "Bulk Student Tools",
  "academics.lessonPlans": "Lesson Plans",
  "academics.curriculumAnalytics": "Curriculum Analytics",
  "studyCenter.advanced": "Study Center: Reports & Analytics",
  "certificates.customTemplates": "Custom Certificate Templates",
  "certificates.bulkGeneration": "Bulk Certificate Generation",
  "inventory.core": "Inventory Management",
  "transport.core": "Transport Management",
  "transport.liveTracking": "Live Vehicle Tracking",
  "hostel.core": "Hostel Management",
};

// ─── Discount validation (shared by validate + checkout) ──────
const TIER_RANK: Record<string, number> = { ECONOMY: 0, ESSENTIAL: 1, PROFESSIONAL: 2, ENTERPRISE: 3 };

// Annual/Academic Session discount scales with how far the school is from
// their academic year ending — committing early in the session earns a
// bigger discount. Not exposed to the frontend as a rule table, only the
// resulting percentage for whatever the school's actual timing is.
function getTieredDiscountPercent(monthsRemaining: number): number {
  if (monthsRemaining >= 11) return 20;
  if (monthsRemaining >= 6) return 10;
  if (monthsRemaining >= 3) return 5;
  return 0;
}

async function validateDiscountCode(
  rawCode: string,
  schoolId: number,
  tier?: string
): Promise<{ valid: true; discount: any } | { valid: false; reason: string }> {
  const code = rawCode?.trim().toUpperCase();
  if (!code) return { valid: false, reason: "Please enter a discount code." };

  const discount = await prisma.discountCode.findUnique({ where: { code } });
  if (!discount) return { valid: false, reason: "Invalid discount code." };
  if (!discount.isActive) return { valid: false, reason: "This code is no longer active." };

  const now = new Date();
  if (discount.validFrom > now) return { valid: false, reason: "This code isn't active yet." };
  if (discount.validTo && discount.validTo < now) return { valid: false, reason: "This code has expired." };

  if (discount.scope === "SCHOOL_SPECIFIC" && discount.targetSchoolId !== schoolId) {
    return { valid: false, reason: "This code isn't valid for your school." };
  }

  if (discount.maxRedemptions !== null && discount.redemptionCount >= discount.maxRedemptions) {
    return { valid: false, reason: "This code has reached its maximum number of uses." };
  }

  const schoolUseCount = await prisma.discountRedemption.count({
    where: { discountCodeId: discount.id, schoolId },
  });
  if (schoolUseCount >= discount.maxRedemptionsPerSchool) {
    return { valid: false, reason: "Your school has already used this code." };
  }

  if (discount.minTier && tier && TIER_RANK[tier] < TIER_RANK[discount.minTier]) {
    return { valid: false, reason: `This code requires the ${discount.minTier} plan or above.` };
  }

  return { valid: true, discount };
}
