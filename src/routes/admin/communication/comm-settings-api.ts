// apps/api/src/routes/admin/communication/comm-settings-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { testWhatsAppConnection } from "../../../services/whatsapp.service.js";

export async function adminCommSettingsRoutes(app: FastifyInstance) {
  const P = "/admin/comm/settings";

  // ─── GET SETTINGS (auto-create defaults) ─────────────────
  app.get(P, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      let settings = await prisma.commSettings.findUnique({ where: { schoolId } });
      if (!settings) {
        settings = await prisma.commSettings.create({ data: { schoolId } });
      }
      return rep.send({ settings });
    }
  );

  // ─── UPDATE GENERAL SETTINGS ──────────────────────────────
  app.put(`${P}/general`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const s = await prisma.commSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          commIdFormat: b.commIdFormat,
          defaultTimezone: b.defaultTimezone,
          academicYearAuto: b.academicYearAuto,
          channelPriority: b.channelPriority,
          // ADDED: the two toggles that replace the old Settings →
          // Notifications page (4 toggles → 2, centralized here).
          pushNotificationsEnabled: b.pushNotificationsEnabled,
          whatsappNotificationsEnabled: b.whatsappNotificationsEnabled,
        },
      });
      return rep.send({ settings: s });
    }
  );

  // ─── UPDATE DELIVERY SETTINGS ─────────────────────────────
  app.put(`${P}/delivery`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const s = await prisma.commSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          retryEnabled: b.retryEnabled,
          maxRetryAttempts: b.maxRetryAttempts ? Number(b.maxRetryAttempts) : undefined,
          retryIntervalMins: b.retryIntervalMins ? Number(b.retryIntervalMins) : undefined,
          messageExpiryHours: b.messageExpiryHours ? Number(b.messageExpiryHours) : undefined,
          smsLimitPerDay: b.smsLimitPerDay ? Number(b.smsLimitPerDay) : undefined,
          emailLimitPerDay: b.emailLimitPerDay ? Number(b.emailLimitPerDay) : undefined,
          whatsappLimitPerDay: b.whatsappLimitPerDay ? Number(b.whatsappLimitPerDay) : undefined,
          pushLimitPerDay: b.pushLimitPerDay ? Number(b.pushLimitPerDay) : undefined,
        },
      });
      return rep.send({ settings: s });
    }
  );

  // ─── UPDATE SCHEDULING SETTINGS ───────────────────────────
  app.put(`${P}/scheduling`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const s = await prisma.commSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          maxScheduleAheadDays: b.maxScheduleAheadDays ? Number(b.maxScheduleAheadDays) : undefined,
          sendWindowFrom: b.sendWindowFrom,
          sendWindowTo: b.sendWindowTo,
          respectSendWindow: b.respectSendWindow,
          quietHoursFrom: b.quietHoursFrom,
          quietHoursTo: b.quietHoursTo,
          respectQuietHours: b.respectQuietHours,
        },
      });
      return rep.send({ settings: s });
    }
  );

  // ─── UPDATE AUTOMATION SETTINGS ───────────────────────────
  app.put(`${P}/automation`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const s = await prisma.commSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          automationEnabled: b.automationEnabled,
          feeReminderEnabled: b.feeReminderEnabled,
          attendanceAlertEnabled: b.attendanceAlertEnabled,
          examNotifEnabled: b.examNotifEnabled,
          birthdayMsgEnabled: b.birthdayMsgEnabled,
        },
      });
      return rep.send({ settings: s });
    }
  );

  // ─── UPDATE TEMPLATE SETTINGS ─────────────────────────────
  app.put(`${P}/templates`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const s = await prisma.commSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          defaultSenderName: b.defaultSenderName,
          defaultEmailFrom: b.defaultEmailFrom,
          allowedVariables: b.allowedVariables,
          requireApproval: b.requireApproval,
          approvalRoles: b.approvalRoles,
        },
      });
      return rep.send({ settings: s });
    }
  );

  // ─── UPDATE PERMISSION SETTINGS ───────────────────────────
  app.put(`${P}/permissions`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { rolePermissions } = req.body as any;
      const s = await prisma.commSettings.upsert({
        where: { schoolId },
        create: { schoolId, rolePermissions },
        update: { rolePermissions },
      });
      return rep.send({ settings: s });
    }
  );

  // ─── UPDATE NOTIFICATION SETTINGS ────────────────────────
  app.put(`${P}/notifications`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const s = await prisma.commSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          notifyOnFailure: b.notifyOnFailure,
          notifyOnLowBalance: b.notifyOnLowBalance,
          notifyOnGatewayDown: b.notifyOnGatewayDown,
          notifyEmailRecipients: b.notifyEmailRecipients,
          lowBalanceThreshold: b.lowBalanceThreshold ? Number(b.lowBalanceThreshold) : undefined,
        },
      });
      return rep.send({ settings: s });
    }
  );

  // ─── UPDATE SECURITY SETTINGS ────────────────────────────
  app.put(`${P}/security`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const s = await prisma.commSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          antiSpamEnabled: b.antiSpamEnabled,
          sameRecipientCooldownMins: b.sameRecipientCooldownMins ? Number(b.sameRecipientCooldownMins) : undefined,
          blacklistedPatterns: b.blacklistedPatterns,
          smsAllowedSenderIds: b.smsAllowedSenderIds,
        },
      });
      return rep.send({ settings: s });
    }
  );

  // ─── UPDATE AUDIT SETTINGS ────────────────────────────────
  app.put(`${P}/audit`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const s = await prisma.commSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          auditEnabled: b.auditEnabled,
          logRetentionDays: b.logRetentionDays ? Number(b.logRetentionDays) : undefined,
          trackReadReceipts: b.trackReadReceipts,
        },
      });
      return rep.send({ settings: s });
    }
  );

  // ─── RESET TO DEFAULTS ────────────────────────────────────
  app.post(`${P}/reset`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      await prisma.commSettings.deleteMany({ where: { schoolId } });
      const settings = await prisma.commSettings.create({ data: { schoolId } });
      return rep.send({ settings, message: "Communication settings reset to defaults" });
    }
  );

  // ─── CHANNEL CONFIGS CRUD ─────────────────────────────────
  app.get(`${P}/channels`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const configs = await prisma.commChannelConfig.findMany({
        where: { schoolId },
        orderBy: [{ type: "asc" }, { isPrimary: "desc" }],
      });
      // Mask sensitive fields
      const masked = configs.map(c => ({
        ...c,
        config: maskConfig(c.config as Record<string, any>),
      }));
      return rep.send({ configs: masked });
    }
  );

  app.post(`${P}/channels`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      // If setting as primary, unset existing primary of same type
      if (b.isPrimary) {
        await prisma.commChannelConfig.updateMany({
          where: { schoolId, type: b.type as any },
          data: { isPrimary: false },
        });
      }

      const config = await prisma.commChannelConfig.create({
        data: {
          schoolId,
          type:        b.type as any,
          name:        b.name,
          config:      b.config ?? {},
          isPrimary:   b.isPrimary ?? false,
          isActive:    b.isActive ?? false,
          createdById: Number(userId),
        },
      });
      return rep.code(201).send({ config: { ...config, config: maskConfig(config.config as Record<string, any>) } });
    }
  );

  app.put(`${P}/channels/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const existing = await prisma.commChannelConfig.findFirst({ where: { id, schoolId } });
      if (!existing) return rep.status(404).send({ error: "Channel not found." });

      if (b.isPrimary) {
        await prisma.commChannelConfig.updateMany({ where: { schoolId, type: existing.type }, data: { isPrimary: false } });
      }

      // FIXED: was `config: b.config` — a blind overwrite of the whole
      // JSON blob. Sensitive fields (API key/token/password) are
      // intentionally sent blank by the frontend when the user isn't
      // changing them ("leave blank to keep existing"), and
      // non-sensitive fields like Phone Number ID only round-trip
      // correctly once the frontend pre-fills them — but even then, a
      // blind overwrite here would drop the API key the moment any
      // other field changed. Merge instead: only keys with a real,
      // non-empty value in the request replace what's already saved.
      const existingConfig = (existing.config as Record<string, any>) ?? {};
      const incomingConfig = (b.config as Record<string, any>) ?? {};
      const mergedConfig = { ...existingConfig };
      for (const [k, v] of Object.entries(incomingConfig)) {
        if (v !== undefined && v !== null && v !== "") mergedConfig[k] = v;
      }

      const config = await prisma.commChannelConfig.update({
        where: { id, schoolId },
        data: { name: b.name, config: mergedConfig, isPrimary: b.isPrimary, isActive: b.isActive },
      });
      return rep.send({ config: { ...config, config: maskConfig(config.config as Record<string, any>) } });
    }
  );

  app.delete(`${P}/channels/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.commChannelConfig.delete({ where: { id, schoolId } });
      return rep.send({ ok: true });
    }
  );

  // ─── TEST CHANNEL CONFIG ──────────────────────────────────
  app.post(`${P}/channels/:id/test`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);

      const config = await prisma.commChannelConfig.findFirst({ where: { id, schoolId } });
      if (!config) return rep.status(404).send({ ok: false, error: "Channel not found." });

      // FIXED: was `Math.random() > 0.1` — a fake 90%-success coin
      // flip that never actually reached a provider. WhatsApp now
      // gets a real credential check against Meta's Graph API; SMS
      // and Email aren't wired to a real gateway yet, so they still
      // report an honest "not implemented" rather than pretending.
      let isOk = false;
      let error: string | null = "Testing isn't wired up for this channel type yet.";
      if (config.type === "WHATSAPP_API") {
        const result = await testWhatsAppConnection(schoolId, id);
        isOk = result.ok;
        error = result.ok ? null : (result.error ?? "Connection failed.");
      }

      await prisma.commChannelConfig.update({
        where: { id, schoolId },
        data: { lastTestedAt: new Date(), lastTestOk: isOk, testError: error },
      });

      return rep.send({ ok: isOk, error, testedAt: new Date() });
    }
  );
}

// Mask sensitive config fields for API responses
function maskConfig(config: Record<string, any>): Record<string, any> {
  const sensitiveKeys = ["apiKey","password","pass","secret","token","fcmKey","apnsKey","apnsCertPath"];
  const masked: Record<string, any> = {};
  for (const [k, v] of Object.entries(config)) {
    masked[k] = sensitiveKeys.some(sk => k.toLowerCase().includes(sk.toLowerCase()))
      ? v ? "••••••••" : null
      : v;
  }
  return masked;
}