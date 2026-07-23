// apps/api/src/routes/admin/communication/comm-scheduled-messages-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

export async function adminCommScheduledMessagesRoutes(app: FastifyInstance) {
  const P = "/admin/comm/schedule";

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();

      const [scheduled, pending, executions, automations] = await Promise.all([
        prisma.commScheduledMessage.count({ where: { schoolId, isActive: true } }),
        prisma.commScheduledMessage.count({ where: { schoolId, isActive: true, scheduledAt: { gt: now } } }),
        prisma.commScheduleExecution.count({ where: { schoolId } }),
        prisma.commAutomationRule.count({ where: { schoolId, status: "ACTIVE" } }),
      ]);

      const failed = await prisma.commScheduleExecution.count({ where: { schoolId, status: "FAILED" } });
      const executed = await prisma.commScheduleExecution.count({ where: { schoolId, status: "EXECUTED" } });

      // Upcoming (next 7 days)
      const upcoming = await prisma.commScheduledMessage.findMany({
        where: { schoolId, isActive: true, scheduledAt: { gte: now, lte: new Date(Date.now() + 7 * 86400000) } },
        orderBy: { scheduledAt: "asc" },
        take: 10,
        select: { id: true, title: true, scheduledAt: true, audienceType: true, channels: true, recurrence: true },
      });

      // Recent executions
      const recentExecs = await prisma.commScheduleExecution.findMany({
        where: { schoolId },
        include: { scheduledMessage: { select: { title: true } } },
        orderBy: { executedAt: "desc" },
        take: 8,
        select: {
          id: true, status: true, executedAt: true, recipientsCount: true, errorMessage: true,
          scheduledMessage: { select: { title: true } },
        },
      });

      // Active automations
      const activeAutomations = await prisma.commAutomationRule.findMany({
        where: { schoolId, status: "ACTIVE" },
        select: { id: true, name: true, trigger: true, runCount: true, lastRunAt: true },
        take: 5,
      });

      return rep.send({
        kpis: { scheduled, pending, executed, failed, automations },
        upcoming, recentExecs, activeAutomations,
      });
    }
  );

  // ─── SCHEDULED MESSAGES CRUD ──────────────────────────────
  app.get(`${P}/list`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const now = new Date();

      const where: any = { schoolId };
      if (q.active === "true")  where.isActive = true;
      if (q.active === "false") where.isActive = false;
      if (q.upcoming === "true") { where.isActive = true; where.scheduledAt = { gte: now }; }
      if (q.recurrence) where.recurrence = q.recurrence;
      if (q.search) where.title = { contains: q.search, mode: "insensitive" };

      const msgs = await prisma.commScheduledMessage.findMany({
        where,
        include: {
          _count: { select: { executions: true } },
        },
        orderBy: [{ isActive: "desc" }, { scheduledAt: "asc" }],
        take: Number(q.limit ?? 50),
      });

      return rep.send({ messages: msgs });
    }
  );

  app.get(`${P}/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const msg = await prisma.commScheduledMessage.findFirst({
        where: { id, schoolId },
        include: {
          executions: { orderBy: { executedAt: "desc" }, take: 10 },
          _count: { select: { executions: true } },
        },
      });
      if (!msg) return rep.code(404).send({ error: "Not found" });
      return rep.send({ message: msg });
    }
  );

  app.post(`${P}/create`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      const msg = await prisma.commScheduledMessage.create({
        data: {
          schoolId,
          title:          b.title,
          templateId:     b.templateId   ? Number(b.templateId)   : null,
          audienceType:   b.audienceType  as any ?? "ALL",
          targetClassIds: b.targetClassIds ?? [],
          channels:       b.channels as any[] ?? [],
          content:        b.content ?? {},
          scheduledAt:    new Date(b.scheduledAt),
          recurrence:     b.recurrence ?? "ONCE",
          nextRunAt:      new Date(b.scheduledAt),
          createdById:    Number(userId),
          sourceModule:   b.sourceModule ?? "MANUAL",
        },
      });

      return rep.code(201).send({ message: msg });
    }
  );

  app.put(`${P}/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const msg = await prisma.commScheduledMessage.update({
        where: { id, schoolId },
        data: {
          title:       b.title,
          audienceType: b.audienceType as any,
          channels:    b.channels as any[],
          content:     b.content,
          scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : undefined,
          recurrence:  b.recurrence,
          isActive:    b.isActive,
          nextRunAt:   b.scheduledAt ? new Date(b.scheduledAt) : undefined,
        },
      });

      return rep.send({ message: msg });
    }
  );

  // Pause / Resume
  app.post(`${P}/:id/toggle`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const current = await prisma.commScheduledMessage.findFirst({ where: { id, schoolId }, select: { isActive: true } });
      if (!current) return rep.code(404).send({ error: "Not found" });
      const msg = await prisma.commScheduledMessage.update({
        where: { id }, data: { isActive: !current.isActive },
      });
      return rep.send({ message: msg, active: msg.isActive });
    }
  );

  // Clone
  app.post(`${P}/:id/clone`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const src = await prisma.commScheduledMessage.findFirst({ where: { id, schoolId } });
      if (!src) return rep.code(404).send({ error: "Not found" });

      const clone = await prisma.commScheduledMessage.create({
        data: {
          schoolId,
          title:          b.title ?? `${src.title} (Copy)`,
          templateId:     src.templateId,
          audienceType:   src.audienceType,
          targetClassIds: src.targetClassIds,
          channels:       src.channels,
          content:        src.content as any,
          scheduledAt:    b.scheduledAt ? new Date(b.scheduledAt) : new Date(src.scheduledAt),
          recurrence:     src.recurrence ?? "ONCE",
          nextRunAt:      b.scheduledAt ? new Date(b.scheduledAt) : new Date(src.scheduledAt),
          createdById:    Number(userId),
        },
      });

      return rep.code(201).send({ message: clone });
    }
  );

  app.delete(`${P}/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.commScheduledMessage.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─── EXECUTION LOGS ───────────────────────────────────────
  app.get(`${P}/executions`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId };
      if (q.status) where.status = q.status;
      if (q.scheduledMsgId) where.scheduledMsgId = Number(q.scheduledMsgId);

      const [executions, total] = await Promise.all([
        prisma.commScheduleExecution.findMany({
          where,
          include: { scheduledMessage: { select: { title: true, audienceType: true, recurrence: true } } },
          orderBy: { executedAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.commScheduleExecution.count({ where }),
      ]);

      return rep.send({ executions, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── CALENDAR VIEW ────────────────────────────────────────
  app.get(`${P}/calendar`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const month  = Number(q.month  ?? new Date().getMonth() + 1);
      const year   = Number(q.year   ?? new Date().getFullYear());
      const from   = new Date(year, month - 1, 1);
      const to     = new Date(year, month, 0, 23, 59, 59);

      const msgs = await prisma.commScheduledMessage.findMany({
        where: { schoolId, scheduledAt: { gte: from, lte: to } },
        orderBy: { scheduledAt: "asc" },
        select: { id: true, title: true, scheduledAt: true, audienceType: true, channels: true, isActive: true, recurrence: true },
      });

      // Group by date
      const byDate: Record<string, any[]> = {};
      msgs.forEach(m => {
        const key = m.scheduledAt.toISOString().split("T")[0];
        if (!byDate[key]) byDate[key] = [];
        byDate[key].push(m);
      });

      return rep.send({ byDate, total: msgs.length, month, year });
    }
  );

  // ─── UPCOMING (next N days) ───────────────────────────────
  app.get(`${P}/upcoming`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const days = Number((req.query as any).days ?? 7);
      const now  = new Date();
      const to   = new Date(Date.now() + days * 86400000);

      const msgs = await prisma.commScheduledMessage.findMany({
        where: { schoolId, isActive: true, scheduledAt: { gte: now, lte: to } },
        orderBy: { scheduledAt: "asc" },
        select: { id: true, title: true, scheduledAt: true, audienceType: true, channels: true, recurrence: true },
      });

      return rep.send({ messages: msgs, count: msgs.length });
    }
  );

  // ─── AUTOMATION RULES CRUD ────────────────────────────────
  app.get(`${P}/automations`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const rules = await prisma.commAutomationRule.findMany({
        where: { schoolId, ...(q.status ? { status: q.status as any } : {}) },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      });
      return rep.send({ rules });
    }
  );

  app.post(`${P}/automations`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const rule = await prisma.commAutomationRule.create({
        data: {
          schoolId,
          name:          b.name,
          description:   b.description ?? null,
          trigger:       b.trigger as any,
          status:        "ACTIVE",
          conditions:    b.conditions ?? {},
          templateId:    b.templateId ? Number(b.templateId) : null,
          audienceType:  b.audienceType as any ?? "ALL_PARENTS",
          channels:      b.channels as any[] ?? [],
          delayMins:     Number(b.delayMins ?? 0),
          cooldownHours: Number(b.cooldownHours ?? 24),
          createdById:   Number(userId),
        },
      });
      return rep.code(201).send({ rule });
    }
  );

  app.put(`${P}/automations/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const rule = await prisma.commAutomationRule.update({
        where: { id, schoolId },
        data: {
          name: b.name, description: b.description,
          status: b.status as any, conditions: b.conditions,
          templateId: b.templateId ? Number(b.templateId) : undefined,
          audienceType: b.audienceType as any,
          channels: b.channels as any[],
          delayMins: b.delayMins ? Number(b.delayMins) : undefined,
          cooldownHours: b.cooldownHours ? Number(b.cooldownHours) : undefined,
        },
      });
      return rep.send({ rule });
    }
  );

  app.post(`${P}/automations/:id/toggle`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const current = await prisma.commAutomationRule.findFirst({ where: { id, schoolId }, select: { status: true } });
      if (!current) return rep.code(404).send({ error: "Not found" });
      const newStatus = current.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
      const rule = await prisma.commAutomationRule.update({ where: { id }, data: { status: newStatus as any } });
      return rep.send({ rule });
    }
  );

  app.delete(`${P}/automations/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.commAutomationRule.update({ where: { id, schoolId }, data: { status: "INACTIVE" } });
      return rep.send({ ok: true });
    }
  );
}
