// apps/api/src/routes/staff/tasks.ts
//
// v2 — adds:
//   GET   /tasks/:id            → task detail + full TaskLog activity timeline
//   PATCH /tasks/:id/snooze     → quick snooze (used by swipe-left gesture)
// Everything else unchanged from your working version.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { z } from "zod";

const createTaskSchema = z.object({
  title:       z.string().min(2),
  description: z.string().optional(),
  type:        z.string().default("CUSTOM"),
  priority:    z.enum(["LOW","MEDIUM","HIGH","CRITICAL"]).default("MEDIUM"),
  module:      z.string().default("system"),
  route:       z.string().optional(),
  assignedToId: z.number().optional(),
  dueDate:     z.string().optional(),
});

const updateStatusSchema = z.object({
  status:  z.enum(["PENDING","IN_PROGRESS","COMPLETED","CANCELLED","SNOOZED"]),
  remarks: z.string().optional(),
  snoozedUntil: z.string().optional(),
});

const snoozeSchema = z.object({
  // "1h" | "3h" | "tomorrow" | custom ISO string
  preset: z.enum(["1h","3h","tomorrow"]).optional(),
  until:  z.string().optional(),
});

export async function tasksRoutes(app: FastifyInstance) {

  // ── GET /tasks/summary ──────────────────────────────────────
  app.get("/tasks/summary",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const today    = new Date(); today.setHours(0,0,0,0);
      const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);

      const [pending, inProgress, overdue, todayTasks, completed] = await Promise.all([
        prisma.task.count({ where: { schoolId, assignedToId: userId, status: "PENDING" } }),
        prisma.task.count({ where: { schoolId, assignedToId: userId, status: "IN_PROGRESS" } }),
        prisma.task.count({
          where: { schoolId, assignedToId: userId, status: { in: ["PENDING","IN_PROGRESS"] }, dueDate: { lt: today } },
        }),
        prisma.task.count({
          where: { schoolId, assignedToId: userId, status: { in: ["PENDING","IN_PROGRESS"] }, dueDate: { gte: today, lte: todayEnd } },
        }),
        prisma.task.count({ where: { schoolId, assignedToId: userId, status: "COMPLETED" } }),
      ]);

      return reply.send({ success: true, data: { pending, inProgress, overdue, todayTasks, completed } });
    }
  );

  // ── GET /tasks ───────────────────────────────────────────────
  app.get("/tasks",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { filter = "pending", module: mod, priority, page = "1" } = req.query as Record<string,string>;
      const skip = (parseInt(page) - 1) * 20;

      const today    = new Date(); today.setHours(0,0,0,0);
      const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);

      let where: any = { schoolId, assignedToId: userId };

      switch (filter) {
        case "today":
          where.status = { in: ["PENDING","IN_PROGRESS"] };
          where.dueDate = { gte: today, lte: todayEnd };
          break;
        case "pending":
          where.status = { in: ["PENDING","IN_PROGRESS"] };
          break;
        case "overdue":
          where.status  = { in: ["PENDING","IN_PROGRESS"] };
          where.dueDate = { lt: today };
          break;
        case "approvals":
          where.type    = { in: ["LEAVE_APPROVAL","FEE_COLLECTION_DUE","DOCUMENT_VERIFICATION","EXAM_SCHEDULE_PENDING"] };
          where.status  = { in: ["PENDING","IN_PROGRESS"] };
          break;
        case "reminders":
          where.type    = { in: ["REMINDER_MEETING","REMINDER_EVENT","REMINDER_DEADLINE"] };
          where.status  = { in: ["PENDING","IN_PROGRESS"] };
          break;
        case "completed":
          where.status = "COMPLETED";
          break;
        default:
          where.status = { in: ["PENDING","IN_PROGRESS","SNOOZED"] };
      }

      if (mod)      where.module   = mod;
      if (priority) where.priority = priority;

      const [tasks, total] = await Promise.all([
        prisma.task.findMany({
          where, skip, take: 20,
          orderBy: [{ priority: "desc" }, { dueDate: "asc" }, { createdAt: "desc" }],
          select: {
            id: true, title: true, description: true, type: true,
            priority: true, status: true, module: true, route: true,
            referenceId: true, isSystemGenerated: true,
            dueDate: true, completedAt: true, snoozedUntil: true,
            createdAt: true,
            assignedBy: { select: { name: true } },
          },
        }),
        prisma.task.count({ where }),
      ]);

      const now = new Date();
      return reply.send({
        success: true,
        data: {
          tasks: tasks.map((t) => ({
            ...t,
            isOverdue:  t.dueDate ? new Date(t.dueDate) < now && t.status !== "COMPLETED" : false,
            isDueToday: t.dueDate ? new Date(t.dueDate) >= today && new Date(t.dueDate) <= todayEnd : false,
          })),
          pagination: { total, page: parseInt(page), totalPages: Math.ceil(total / 20) },
        },
      });
    }
  );

  // ── GET /tasks/:id — Detail + full activity timeline ─────────
  app.get("/tasks/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { id } = req.params as { id: string };

      const task = await prisma.task.findFirst({
        where: { id: parseInt(id), schoolId, assignedToId: userId },
        select: {
          id: true, title: true, description: true, type: true,
          priority: true, status: true, module: true, route: true,
          isSystemGenerated: true, dueDate: true, completedAt: true,
          snoozedUntil: true, remarks: true, createdAt: true,
          assignedBy: { select: { name: true } },
          logs: {
            orderBy: { createdAt: "desc" },
            select: { id: true, action: true, note: true, byUserId: true, createdAt: true },
          },
        },
      });

      if (!task) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      return reply.send({ success: true, data: { task } });
    }
  );

  // ── POST /tasks ──────────────────────────────────────────────
  app.post("/tasks",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const parsed = createTaskSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });

      const { title, description, type, priority, module: mod, route, assignedToId, dueDate } = parsed.data;

      const task = await prisma.task.create({
        data: {
          schoolId, title, description: description ?? null,
          type: type as any, priority: priority as any,
          module: mod, route: route ?? null,
          assignedToId: assignedToId ?? userId,
          assignedById: userId,
          isSystemGenerated: false,
          dueDate: dueDate ? new Date(dueDate) : null,
          status: "PENDING",
        },
      });

      await prisma.taskLog.create({ data: { taskId: task.id, action: "created", byUserId: userId } });

      return reply.status(201).send({ success: true, data: { task } });
    }
  );

  // ── PATCH /tasks/:id/status ───────────────────────────────────
  app.patch("/tasks/:id/status",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { id } = req.params as { id: string };

      const parsed = updateStatusSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });

      const { status, remarks, snoozedUntil } = parsed.data;

      const task = await prisma.task.findFirst({ where: { id: parseInt(id), schoolId, assignedToId: userId } });
      if (!task) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      await prisma.task.update({
        where: { id: parseInt(id) },
        data: {
          status: status as any,
          remarks: remarks ?? null,
          completedAt:  status === "COMPLETED" ? new Date() : null,
          snoozedUntil: status === "SNOOZED" && snoozedUntil ? new Date(snoozedUntil) : null,
        },
      });

      await prisma.taskLog.create({
        data: { taskId: parseInt(id), action: status.toLowerCase(), note: remarks ?? null, byUserId: userId },
      });

      return reply.send({ success: true, message: `Task marked as ${status.toLowerCase()}` });
    }
  );

  // ── PATCH /tasks/:id/complete — Quick complete (swipe-right) ──
  app.patch("/tasks/:id/complete",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { id } = req.params as { id: string };

      const task = await prisma.task.findFirst({ where: { id: parseInt(id), schoolId, assignedToId: userId } });
      if (!task) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      await prisma.task.update({
        where: { id: parseInt(id) },
        data: { status: "COMPLETED", completedAt: new Date() },
      });

      await prisma.taskLog.create({ data: { taskId: parseInt(id), action: "completed", byUserId: userId } });

      return reply.send({ success: true, message: "Task completed" });
    }
  );

  // ── PATCH /tasks/:id/snooze — Quick snooze (swipe-left) ───────
  app.patch("/tasks/:id/snooze",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { id } = req.params as { id: string };

      const parsed = snoozeSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });

      const task = await prisma.task.findFirst({ where: { id: parseInt(id), schoolId, assignedToId: userId } });
      if (!task) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      let until: Date;
      if (parsed.data.until) {
        until = new Date(parsed.data.until);
      } else {
        const now = new Date();
        switch (parsed.data.preset) {
          case "1h": until = new Date(now.getTime() + 3600000); break;
          case "3h": until = new Date(now.getTime() + 3 * 3600000); break;
          case "tomorrow":
          default:
            until = new Date(now);
            until.setDate(until.getDate() + 1);
            until.setHours(9, 0, 0, 0);
        }
      }

      await prisma.task.update({
        where: { id: parseInt(id) },
        data: { status: "SNOOZED", snoozedUntil: until },
      });

      await prisma.taskLog.create({
        data: { taskId: parseInt(id), action: "snoozed", note: `Until ${until.toISOString()}`, byUserId: userId },
      });

      return reply.send({ success: true, message: "Task snoozed", data: { snoozedUntil: until } });
    }
  );
}