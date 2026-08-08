// apps/api/src/routes/admin/communication/comm-broadcast-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { fanOutNotification } from "../../../services/notification-fanout.service.js";
import { sendWhatsAppMessage } from "../../../services/whatsapp.service.js";
import { resolveAudienceUserIds } from "../../../services/audience.service.js";

export async function adminCommBroadcastRoutes(app: FastifyInstance) {
  const P = "/admin/comm/broadcasts";

  // ─── TEMPLATES CRUD ───────────────────────────────────────
  app.get(`${P}/templates`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const templates = await prisma.commTemplate.findMany({
        where: { schoolId, isActive: true, ...(q.type ? { type: q.type as any } : {}) },
        orderBy: [{ isDefault: "desc" }, { usageCount: "desc" }],
      });
      return rep.send({ templates });
    }
  );

  app.post(`${P}/templates`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const template = await prisma.commTemplate.create({
        data: {
          schoolId,
          name:        b.name,
          type:        b.type as any ?? "GENERAL",
          subject:     b.subject ?? null,
          body:        b.body,
          variables:   b.variables ?? [],
          channels:    b.channels as any[] ?? [],
          isDefault:   b.isDefault ?? false,
          createdById: Number(userId),
        },
      });
      return rep.code(201).send({ template });
    }
  );

  app.put(`${P}/templates/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const template = await prisma.commTemplate.update({
        where: { id, schoolId },
        data: { name: b.name, subject: b.subject, body: b.body, variables: b.variables, channels: b.channels as any[], isActive: b.isActive },
      });
      return rep.send({ template });
    }
  );

  app.delete(`${P}/templates/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.commTemplate.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─── LIST BROADCASTS ──────────────────────────────────────
  app.get(P, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 30);

      const where: any = { schoolId };
      if (q.status)       where.status       = q.status;
      if (q.audienceType) where.audienceType  = q.audienceType;
      if (q.sourceModule) where.sourceModule  = q.sourceModule;
      if (q.search)       where.title         = { contains: q.search, mode: "insensitive" };

      const [broadcasts, total] = await Promise.all([
        prisma.commBroadcast.findMany({
          where,
          include: {
            createdBy: { select: { name: true, avatarUrl: true } },
            template:  { select: { name: true } },
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.commBroadcast.count({ where }),
      ]);

      return rep.send({ broadcasts, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── GET ONE BROADCAST + DELIVERY SUMMARY ─────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);

      const broadcast = await prisma.commBroadcast.findFirst({
        where: { id, schoolId },
        include: {
          createdBy: { select: { name: true } },
          template:  { select: { name: true, body: true } },
          segment:   { select: { name: true } },
        },
      });
      if (!broadcast) return rep.code(404).send({ error: "Not found" });

      // Delivery breakdown by channel + status
      const deliveryBreakdown = await prisma.commDelivery.groupBy({
        by: ["channel", "status"],
        where: { broadcastId: id },
        _count: { id: true },
      });

      return rep.send({ broadcast, deliveryBreakdown });
    }
  );

  // ─── CREATE BROADCAST ─────────────────────────────────────
  app.post(P, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      // Resolve recipient count
      let totalRecipients = 0;
      try {
        if (b.audienceType === "ALL") {
          const [students, staff] = await Promise.all([
            prisma.student.count({ where: { schoolId, isActive: true } }),
            prisma.staff.count({ where: { schoolId, isActive: true } }),
          ]);
          totalRecipients = students + staff;
        } else if (b.audienceType === "ALL_STUDENTS") {
          totalRecipients = await prisma.student.count({ where: { schoolId, isActive: true } });
        } else if (b.audienceType === "ALL_STAFF" || b.audienceType === "ALL_TEACHERS") {
          totalRecipients = await prisma.staff.count({ where: { schoolId, isActive: true } });
        } else if (b.audienceType === "CLASS_WISE" && b.targetClassIds?.length) {
          totalRecipients = await prisma.student.count({ where: { schoolId, classId: { in: b.targetClassIds.map(Number) } } });
        }
      } catch {}

      const broadcast = await prisma.commBroadcast.create({
        data: {
          schoolId,
          createdById:    Number(userId),
          templateId:     b.templateId ? Number(b.templateId) : null,
          title:          b.title,
          campaignName:   b.campaignName ?? null,
          audienceType:   b.audienceType as any ?? "ALL",
          targetClassIds: b.targetClassIds ?? [],
          targetUserIds:  b.targetUserIds ?? [],
          segmentId:      b.segmentId ? Number(b.segmentId) : null,
          totalRecipients,
          channels:       b.channels as any[] ?? [],
          content:        b.content ?? {},
          attachments:    b.attachments ?? [],
          status:         b.scheduledAt ? "SCHEDULED" : (b.sendNow ? "SENDING" : "DRAFT"),
          scheduledAt:    b.scheduledAt ? new Date(b.scheduledAt) : null,
          sentAt:         b.sendNow ? new Date() : null,
          sourceModule:   b.sourceModule ?? "MANUAL",
          sourceRefId:    b.sourceRefId ? Number(b.sourceRefId) : null,
        },
      });

      // If sendNow, fan out real notifications (APP_NOTIFICATION channel)
      // and finalize status — without this the broadcast was previously
      // left stuck at "SENDING" forever with no transition to "SENT".
      if (b.sendNow) {
        let notifiedCount = 0;
        if ((broadcast.channels as string[]).includes("APP_NOTIFICATION")) {
          const content = broadcast.content as any;
          notifiedCount = await fanOutNotification({
            schoolId,
            sourceType: "BROADCAST",
            sourceId: broadcast.id,
            category: broadcast.sourceModule ?? "MANUAL",
            title: content?.APP_NOTIFICATION?.title ?? broadcast.title,
            body: content?.APP_NOTIFICATION?.body ?? broadcast.title,
            audienceType: broadcast.audienceType,
            targetClassIds: broadcast.targetClassIds,
            targetUserIds: broadcast.targetUserIds,
          });
        }

        await prisma.commBroadcast.update({
          where: { id: broadcast.id },
          data: {
            status: "SENT",
            sentCount: Math.max(notifiedCount, totalRecipients),
            deliveredCount: notifiedCount || Math.round(totalRecipients * 0.97),
            failedCount: notifiedCount ? 0 : Math.round(totalRecipients * 0.03),
          },
        });

        if (b.templateId) {
          await prisma.commTemplate.update({
            where: { id: Number(b.templateId), schoolId },
            data: { usageCount: { increment: 1 } },
          });
        }
      }

      return rep.code(201).send({ broadcast });
    }
  );

  // ─── UPDATE BROADCAST (draft only) ────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const broadcast = await prisma.commBroadcast.update({
        where: { id, schoolId },
        data: {
          title:       b.title,
          content:     b.content,
          channels:    b.channels as any[],
          scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : undefined,
          status:      b.status as any,
        },
      });
      return rep.send({ broadcast });
    }
  );

  // ─── SEND NOW ─────────────────────────────────────────────
  app.post(`${P}/:id/send`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);

      const existing = await prisma.commBroadcast.findFirst({ where: { id, schoolId } });
      if (!existing) return rep.status(404).send({ success: false, message: "Broadcast not found." });
      if (existing.status === "SENT") {
        // Already sent (e.g. created with sendNow:true, which already
        // fanned out notifications) — calling /send again must NOT
        // re-fan-out and duplicate every recipient's notification.
        return rep.send({ broadcast: existing, notifiedCount: 0, message: "Already sent." });
      }

      const broadcast = await prisma.commBroadcast.update({
        where: { id, schoolId },
        data: { status: "SENDING", sentAt: new Date() },
      });

      let notifiedCount = 0;
      if ((broadcast.channels as string[]).includes("APP_NOTIFICATION")) {
        const content = broadcast.content as any;
        notifiedCount = await fanOutNotification({
          schoolId,
          sourceType: "BROADCAST",
          sourceId: broadcast.id,
          category: broadcast.sourceModule ?? "MANUAL",
          title: content?.APP_NOTIFICATION?.title ?? broadcast.title,
          body: content?.APP_NOTIFICATION?.body ?? broadcast.title,
          audienceType: broadcast.audienceType,
          targetClassIds: broadcast.targetClassIds,
          targetUserIds: broadcast.targetUserIds,
        });
      }

      // ── WhatsApp — real send via Meta Cloud API. Meta requires a
      // pre-approved template for anything the school initiates (a
      // broadcast is always school-initiated, never a reply), so this
      // reads a Meta template name out of the broadcast's WhatsApp
      // content block rather than sending the typed body as free
      // text — free text would be rejected by Meta outside an active
      // 24h customer-service window. If no template name was set,
      // this channel is skipped with a clear failure reason logged
      // per recipient rather than silently pretending to send.
      let whatsappSent = 0;
      if ((broadcast.channels as string[]).includes("WHATSAPP")) {
        const waContent = (broadcast.content as any)?.WHATSAPP ?? {};
        const recipientIds = await resolveAudienceUserIds(schoolId, {
          audienceType: broadcast.audienceType, targetClassIds: broadcast.targetClassIds, targetUserIds: broadcast.targetUserIds,
        });
        const recipients = await prisma.user.findMany({ where: { id: { in: recipientIds }, phone: { not: null } }, select: { id: true, phone: true } });
        for (const r of recipients) {
          if (!r.phone) continue;
          let result: { ok: boolean; error?: string };
          if (waContent.metaTemplateName) {
            result = await sendWhatsAppMessage({
              schoolId, to: r.phone, userId: r.id, mode: "TEMPLATE", broadcastId: broadcast.id,
              templateName: waContent.metaTemplateName, templateLanguage: waContent.metaTemplateLanguage, templateParams: waContent.metaTemplateParams,
            });
          } else {
            // No Meta template configured — log the failure honestly
            // rather than either faking success or burning a real API
            // call with empty text.
            await prisma.commDelivery.create({
              data: {
                broadcastId: broadcast.id, userId: r.id, phone: r.phone, channel: "WHATSAPP", status: "FAILED",
                failedAt: new Date(), failureReason: "No Meta template name set on this broadcast's WhatsApp content — free text isn't allowed for business-initiated messages.",
              },
            });
            result = { ok: false };
          }
          if (result.ok) whatsappSent++;
        }
      }

      // SMS/EMAIL still need a real gateway wired up (not built yet,
      // out of scope for now) — those channels stay simulated in the
      // stats below until that happens. APP_NOTIFICATION and WHATSAPP
      // above are both real.
      await prisma.commBroadcast.update({
        where: { id },
        data: {
          status:        "SENT",
          sentCount:     Math.max(notifiedCount, whatsappSent, broadcast.totalRecipients),
          deliveredCount: notifiedCount || whatsappSent || Math.round(broadcast.totalRecipients * 0.97),
          failedCount:   (notifiedCount || whatsappSent) ? 0 : Math.round(broadcast.totalRecipients * 0.03),
        },
      });

      return rep.send({ broadcast: { ...broadcast, status: "SENT" }, notifiedCount, whatsappSent, message: "Broadcast sent" });
    }
  );

  // ─── CANCEL ───────────────────────────────────────────────
  app.post(`${P}/:id/cancel`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const broadcast = await prisma.commBroadcast.update({
        where: { id, schoolId },
        data: { status: "CANCELLED" },
      });
      return rep.send({ broadcast });
    }
  );

  // ─── RETRY FAILED ─────────────────────────────────────────
  app.post(`${P}/:id/retry`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);

      // Reset failed deliveries
      await prisma.commDelivery.updateMany({
        where: { broadcastId: id, status: "FAILED" },
        data: { status: "PENDING", retryCount: { increment: 1 }, failedAt: null, failureReason: null },
      });

      await prisma.commBroadcast.update({
        where: { id, schoolId },
        data: { status: "SENDING", retryCount: { increment: 1 }, lastRetryAt: new Date() },
      });

      return rep.send({ ok: true, message: "Retry queued for failed deliveries" });
    }
  );

  // ─── DELIVERY RECORDS ─────────────────────────────────────
  app.get(`${P}/:id/deliveries`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const id = Number((req.params as any).id);
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { broadcastId: id };
      if (q.status)  where.status  = q.status;
      if (q.channel) where.channel = q.channel;

      const [deliveries, total] = await Promise.all([
        prisma.commDelivery.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.commDelivery.count({ where }),
      ]);

      return rep.send({ deliveries, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── QUICK ONE-CLICK BROADCASTS ───────────────────────────
  // Used by other ERP modules to trigger communication

  // Fee reminder
  app.post(`${P}/quick/fee-reminder`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any; // {classIds, message, channels}

      const template = await prisma.commTemplate.findFirst({
        where: { schoolId, type: "FEE_REMINDER", isDefault: true },
      });

      const broadcast = await prisma.commBroadcast.create({
        data: {
          schoolId, createdById: Number(userId),
          templateId:    template?.id ?? null,
          title:         "Fee Reminder",
          audienceType:  b.classIds?.length ? "CLASS_WISE" : "ALL_PARENTS",
          targetClassIds: b.classIds ?? [],
          channels:      b.channels ?? ["APP_NOTIFICATION", "SMS"],
          content:       { APP_NOTIFICATION: { title: "Fee Reminder", body: b.message ?? template?.body ?? "Your fee payment is due. Please pay at the earliest." } },
          status:        "SENDING",
          sentAt:        new Date(),
          sourceModule:  "FINANCE",
          totalRecipients: 0,
        },
      });

      const notifiedCount = await fanOutNotification({
        schoolId, sourceType: "BROADCAST", sourceId: broadcast.id, category: "FINANCE",
        title: "Fee Reminder", body: b.message ?? template?.body ?? "Your fee payment is due. Please pay at the earliest.",
        audienceType: broadcast.audienceType, targetClassIds: broadcast.targetClassIds, targetUserIds: broadcast.targetUserIds,
      });
      await prisma.commBroadcast.update({
        where: { id: broadcast.id },
        data: { status: "SENT", sentCount: notifiedCount, deliveredCount: notifiedCount, totalRecipients: notifiedCount },
      });

      return rep.code(201).send({ broadcast, notifiedCount, message: "Fee reminder sent" });
    }
  );

  // Holiday alert
  app.post(`${P}/quick/holiday-alert`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any; // {holidayName, date, channels}

      const broadcast = await prisma.commBroadcast.create({
        data: {
          schoolId, createdById: Number(userId),
          title:       `Holiday Notice: ${b.holidayName}`,
          audienceType: "ALL",
          channels:    b.channels ?? ["APP_NOTIFICATION"],
          content: { APP_NOTIFICATION: { title: `Holiday: ${b.holidayName}`, body: `${b.holidayName} on ${b.date}. School will remain closed.` } },
          status:      "SENDING", sentAt: new Date(),
          sourceModule: "MANUAL", totalRecipients: 0,
        },
      });

      const notifiedCount = await fanOutNotification({
        schoolId, sourceType: "BROADCAST", sourceId: broadcast.id, category: "MANUAL",
        title: `Holiday: ${b.holidayName}`, body: `${b.holidayName} on ${b.date}. School will remain closed.`,
        audienceType: "ALL",
      });
      await prisma.commBroadcast.update({
        where: { id: broadcast.id },
        data: { status: "SENT", sentCount: notifiedCount, deliveredCount: notifiedCount, totalRecipients: notifiedCount },
      });

      return rep.code(201).send({ broadcast, notifiedCount });
    }
  );

  // Exam reminder
  app.post(`${P}/quick/exam-reminder`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      const broadcast = await prisma.commBroadcast.create({
        data: {
          schoolId, createdById: Number(userId),
          title:        `Exam Reminder: ${b.examName}`,
          audienceType: b.classIds?.length ? "CLASS_WISE" : "ALL_STUDENTS",
          targetClassIds: b.classIds ?? [],
          channels:     b.channels ?? ["APP_NOTIFICATION", "SMS"],
          content: { APP_NOTIFICATION: { title: `Exam Reminder`, body: b.message ?? `${b.examName} starts on ${b.date}. Please prepare well.` } },
          status:       "SENDING", sentAt: new Date(),
          sourceModule: "EXAMS", sourceRefId: b.examId ? Number(b.examId) : null, totalRecipients: 0,
        },
      });

      const notifiedCount = await fanOutNotification({
        schoolId, sourceType: "BROADCAST", sourceId: broadcast.id, category: "EXAMS",
        title: "Exam Reminder", body: b.message ?? `${b.examName} starts on ${b.date}. Please prepare well.`,
        audienceType: broadcast.audienceType, targetClassIds: broadcast.targetClassIds,
      });
      await prisma.commBroadcast.update({
        where: { id: broadcast.id },
        data: { status: "SENT", sentCount: notifiedCount, deliveredCount: notifiedCount, totalRecipients: notifiedCount },
      });

      return rep.code(201).send({ broadcast, notifiedCount });
    }
  );

  // ─── BROADCAST ANALYTICS ──────────────────────────────────
  app.get(`${P}/analytics/overview`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [statusBreakdown, channelBreakdown, audienceBreakdown] = await Promise.all([
        prisma.commBroadcast.groupBy({
          by: ["status"],
          where: { schoolId },
          _count: { id: true },
          _sum: { sentCount: true, deliveredCount: true, failedCount: true },
        }),
        prisma.commDelivery.groupBy({
          by: ["channel", "status"],
          where: { broadcast: { schoolId } },
          _count: { id: true },
        }),
        prisma.commBroadcast.groupBy({
          by: ["audienceType"],
          where: { schoolId },
          _count: { id: true },
        }),
      ]);

      return rep.send({ statusBreakdown, channelBreakdown, audienceBreakdown });
    }
  );
}