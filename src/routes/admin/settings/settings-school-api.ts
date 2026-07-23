// apps/api/src/routes/admin/settings/settings-school-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { hashPassword, verifyPassword } from "../../../utils/auth.js";
import { getStorageUsageGB } from "../../../services/storage.service.js";

// Sensitive/identity fields get a rolling-window change limit — different
// cadence per field, matching how most SaaS platforms throttle profile
// edits to slow down account-takeover or accidental churn.
const RATE_LIMITS: Record<string, { max: number; windowDays: number; label: string }> = {
  schoolName: { max: 5, windowDays: 90, label: "School Name" },
  adminName: { max: 3, windowDays: 30, label: "Owner Name" },
  adminPhone: { max: 3, windowDays: 30, label: "Owner Phone" },
  adminEmail: { max: 3, windowDays: 30, label: "Owner Email" },
};

async function checkRateLimit(schoolId: number, fieldName: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const limit = RATE_LIMITS[fieldName];
  if (!limit) return { ok: true };

  const windowStart = new Date(Date.now() - limit.windowDays * 24 * 60 * 60 * 1000);
  const count = await prisma.profileFieldChangeLog.count({
    where: { schoolId, fieldName, changedAt: { gte: windowStart } },
  });

  if (count >= limit.max) {
    const oldestInWindow = await prisma.profileFieldChangeLog.findFirst({
      where: { schoolId, fieldName, changedAt: { gte: windowStart } },
      orderBy: { changedAt: "asc" },
    });
    const nextAllowed = oldestInWindow
      ? new Date(oldestInWindow.changedAt.getTime() + limit.windowDays * 24 * 60 * 60 * 1000)
      : null;
    const nextAllowedStr = nextAllowed
      ? nextAllowed.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
      : "later";
    return {
      ok: false,
      message: `You've changed ${limit.label} ${limit.max} times in the last ${limit.windowDays} days. You can change it again after ${nextAllowedStr}.`,
    };
  }
  return { ok: true };
}

async function logFieldChange(schoolId: number, fieldName: string, oldValue: string | null, newValue: string | null) {
  if (!RATE_LIMITS[fieldName]) return;
  await prisma.profileFieldChangeLog.create({
    data: { schoolId, fieldName, oldValue, newValue },
  });
}

export async function adminSchoolSettingsRoutes(app: FastifyInstance) {
  const P = "/admin/settings/school";

  // ── GET /admin/settings/school ──────────────────────────
  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;

    let settings = await prisma.schoolSettings.findUnique({ where: { schoolId } });

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        name: true, slug: true, email: true, phone: true, address: true, city: true, state: true, pincode: true,
        board: true, establishedYear: true, logoUrl: true, websiteUrl: true,
        adminName: true, adminEmail: true, adminPhone: true,
        status: true, registeredAt: true, trialEndsAt: true,
      },
    });

    if (!settings) {
      // First-ever load — seed SchoolSettings from the School record's own
      // address/city/state/pincode instead of leaving the form blank, since
      // that data was already captured at registration.
      settings = await prisma.schoolSettings.create({
        data: {
          schoolId,
          address: school?.address ?? null,
          city: school?.city ?? null,
          state: school?.state ?? null,
          pincode: school?.pincode ?? null,
          contactEmail: school?.email ?? null,
          contactPhone: school?.phone ?? null,
          website: school?.websiteUrl ?? null,
          logoUrl: school?.logoUrl ?? null,
        },
      });
    }

    // Live student/staff counts (never trust School.totalStudents/totalTeachers
    // — those denormalized counters go stale; count the real rows instead).
    const [activeStudents, activeStaff, subscription, storageUsedGB, changeCounts] = await Promise.all([
      prisma.student.count({ where: { schoolId, isActive: true } }),
      prisma.staff.count({ where: { schoolId, isActive: true } }),
      prisma.schoolSubscription.findUnique({
        where: { schoolId },
        include: { plan: true, creditWallet: true },
      }),
      getStorageUsageGB(schoolId),
      Promise.all(
        Object.entries(RATE_LIMITS).map(async ([field, limit]) => {
          const windowStart = new Date(Date.now() - limit.windowDays * 24 * 60 * 60 * 1000);
          const used = await prisma.profileFieldChangeLog.count({
            where: { schoolId, fieldName: field, changedAt: { gte: windowStart } },
          });
          return [field, { used, max: limit.max, windowDays: limit.windowDays }] as const;
        })
      ),
    ]);

    return rep.send({
      settings,
      school,
      usage: {
        students: activeStudents,
        studentsMax: subscription?.plan.maxStudents ?? null,
        staff: activeStaff,
        staffMax: subscription?.plan.maxStaff ?? null,
        storageUsedGB,
        storageMaxGB: subscription?.plan.storageGB ?? null,
        smsCredits: subscription?.creditWallet?.smsBalance ?? null,
        smsCreditsMax: subscription?.plan.smsCredits ?? null,
        whatsappCredits: subscription?.creditWallet?.whatsappBalance ?? null,
        whatsappCreditsMax: subscription?.plan.whatsappCredits ?? null,
        planName: subscription?.plan.name ?? null,
        billingCycleType: subscription?.billingCycleType ?? null,
        billingCycleEnd: subscription?.billingCycleEnd ?? null,
      },
      changeLimits: Object.fromEntries(changeCounts),
    });
  });

  // ── PUT /admin/settings/school ──────────────────────────
  app.put(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;

    const current = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true, adminName: true, adminEmail: true, adminPhone: true },
    });
    if (!current) return rep.status(404).send({ success: false, message: "School not found." });

    // ── Enforce rate limits on any restricted field that's actually changing ──
    const restrictedChanges: { field: string; oldValue: string | null; newValue: string }[] = [];
    if (b.schoolName?.trim() && b.schoolName.trim() !== current.name) {
      restrictedChanges.push({ field: "schoolName", oldValue: current.name, newValue: b.schoolName.trim() });
    }
    if (b.adminName?.trim() && b.adminName.trim() !== current.adminName) {
      restrictedChanges.push({ field: "adminName", oldValue: current.adminName, newValue: b.adminName.trim() });
    }
    if (b.adminPhone?.trim() && b.adminPhone.trim() !== current.adminPhone) {
      restrictedChanges.push({ field: "adminPhone", oldValue: current.adminPhone, newValue: b.adminPhone.trim() });
    }
    if (b.adminEmail?.trim() && b.adminEmail.trim().toLowerCase() !== current.adminEmail?.toLowerCase()) {
      restrictedChanges.push({ field: "adminEmail", oldValue: current.adminEmail, newValue: b.adminEmail.trim().toLowerCase() });
    }

    for (const change of restrictedChanges) {
      const result = await checkRateLimit(schoolId, change.field);
      if (!result.ok) {
        return rep.status(429).send({ success: false, message: result.message });
      }
    }

    const settings = await prisma.schoolSettings.upsert({
      where: { schoolId },
      create: {
        schoolId,
        affiliationNo: b.affiliationNo, udiseCode: b.udiseCode, registrationNo: b.registrationNo,
        logoUrl: b.logoUrl, faviconUrl: b.faviconUrl, watermarkUrl: b.watermarkUrl, themeColor: b.themeColor,
        address: b.address, state: b.state, district: b.district, city: b.city, pincode: b.pincode, country: b.country,
        contactEmail: b.contactEmail, contactPhone: b.contactPhone, website: b.website,
        defaultCurrency: b.defaultCurrency, language: b.language, timezone: b.timezone, dateFormat: b.dateFormat,
      },
      update: {
        affiliationNo: b.affiliationNo, udiseCode: b.udiseCode, registrationNo: b.registrationNo,
        logoUrl: b.logoUrl, faviconUrl: b.faviconUrl, watermarkUrl: b.watermarkUrl, themeColor: b.themeColor,
        address: b.address, state: b.state, district: b.district, city: b.city, pincode: b.pincode, country: b.country,
        contactEmail: b.contactEmail, contactPhone: b.contactPhone, website: b.website,
        defaultCurrency: b.defaultCurrency, language: b.language, timezone: b.timezone, dateFormat: b.dateFormat,
      },
    });

    // School table — identity fields, established year, board.
    await prisma.school.update({
      where: { id: schoolId },
      data: {
        ...(b.schoolName?.trim() ? { name: b.schoolName.trim() } : {}),
        ...(b.adminName?.trim() ? { adminName: b.adminName.trim() } : {}),
        ...(b.adminPhone?.trim() ? { adminPhone: b.adminPhone.trim() } : {}),
        ...(b.adminEmail?.trim() ? { adminEmail: b.adminEmail.trim().toLowerCase() } : {}),
        ...(b.board ? { board: b.board } : {}),
        ...(b.establishedYear ? { establishedYear: parseInt(b.establishedYear) } : {}),
        ...(b.contactEmail ? { email: b.contactEmail } : {}),
        ...(b.contactPhone ? { phone: b.contactPhone } : {}),
        ...(b.website ? { websiteUrl: b.website } : {}),
        ...(b.logoUrl ? { logoUrl: b.logoUrl } : {}),
      },
    });

    // Log every restricted change AFTER the update succeeds.
    for (const change of restrictedChanges) {
      await logFieldChange(schoolId, change.field, change.oldValue, change.newValue);
    }

    return rep.send({ success: true, settings });
  });

  // ── POST /admin/settings/school/change-password ─────────
  // Changes the logged-in admin USER's own login password (separate from
  // the School.adminPhone/adminEmail contact fields above, which are just
  // descriptive info, not login credentials).
  app.post(
    `${P}/change-password`,
    { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };

      if (!currentPassword || !newPassword) {
        return rep.status(400).send({ success: false, message: "Current and new password are required." });
      }
      if (newPassword.length < 6) {
        return rep.status(400).send({ success: false, message: "New password must be at least 6 characters." });
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return rep.status(404).send({ success: false, message: "User not found." });

      const valid = await verifyPassword(currentPassword, user.passwordHash);
      if (!valid) {
        return rep.status(401).send({ success: false, message: "Current password is incorrect." });
      }

      const newHash = await hashPassword(newPassword);
      await prisma.user.update({ where: { id: userId }, data: { passwordHash: newHash } });

      return rep.send({ success: true, message: "Password updated successfully." });
    }
  );
}
