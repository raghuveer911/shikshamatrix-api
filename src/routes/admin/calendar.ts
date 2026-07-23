import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";

export async function adminCalendarRoutes(app: FastifyInstance) {

  // ── GET /admin/calendar/events ────────────────────────────
  app.get(
    "/admin/calendar/events",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const query = request.query as { from?: string; to?: string; type?: string };

      const where: any = { schoolId };
      if (query.type && query.type !== "ALL") where.eventType = query.type;
      if (query.from || query.to) {
        where.OR = [
          {
            startDate: {
              gte: query.from ? new Date(query.from) : undefined,
              lte: query.to ? new Date(query.to) : undefined,
            },
          },
          {
            endDate: {
              gte: query.from ? new Date(query.from) : undefined,
              lte: query.to ? new Date(query.to) : undefined,
            },
          },
        ];
      }

      const [events, holidays] = await Promise.all([
        prisma.schoolEvent.findMany({
          where,
          orderBy: { startDate: "asc" },
          include: {
            createdBy: { select: { id: true, name: true } },
          },
        }),
        prisma.holiday.findMany({
          where: {
            schoolId,
            ...(query.from || query.to ? {
              date: {
                gte: query.from ? new Date(query.from) : undefined,
                lte: query.to ? new Date(query.to) : undefined,
              },
            } : {}),
          },
          orderBy: { date: "asc" },
        }),
      ]);

      // Convert holidays to event format
      const holidayEvents = holidays.map(h => ({
        id: `holiday-${h.id}`,
        title: h.name,
        description: h.description ?? "",
        eventType: "HOLIDAY",
        color: h.type === "NATIONAL" ? "#f97316" : h.type === "EXAM" ? "#ef4444" : "#10b981",
        startDate: h.date,
        endDate: h.date,
        isAllDay: true,
        startTime: null,
        endTime: null,
        forAllClasses: true,
        classIds: [],
        recurrence: "NONE",
        isHoliday: true,
        holidayType: h.type,
      }));

      return reply.send({
        success: true,
        data: {
          events: [...events, ...holidayEvents].sort(
            (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
          ),
        },
      });
    }
  );

  // ── POST /admin/calendar/events ───────────────────────────
  app.post(
    "/admin/calendar/events",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        title: string;
        description?: string;
        eventType: string;
        color?: string;
        startDate: string;
        endDate: string;
        isAllDay?: boolean;
        startTime?: string;
        endTime?: string;
        forAllClasses?: boolean;
        classIds?: number[];
        recurrence?: string;
        recurrenceEnd?: string;
        reminderDays?: number;
      };

      if (!body.title?.trim()) {
        return reply.status(400).send({ success: false, message: "Title is required." });
      }
      if (!body.startDate || !body.endDate) {
        return reply.status(400).send({ success: false, message: "Start and end dates are required." });
      }

      const event = await prisma.schoolEvent.create({
        data: {
          schoolId,
          title: body.title.trim(),
          description: body.description?.trim() ?? null,
          eventType: body.eventType as any ?? "EVENT",
          color: body.color ?? "#6366f1",
          startDate: new Date(body.startDate),
          endDate: new Date(body.endDate),
          isAllDay: body.isAllDay ?? true,
          startTime: body.startTime ?? null,
          endTime: body.endTime ?? null,
          forAllClasses: body.forAllClasses ?? true,
          classIds: body.classIds ?? [],
          recurrence: body.recurrence as any ?? "NONE",
          recurrenceEnd: body.recurrenceEnd ? new Date(body.recurrenceEnd) : null,
          reminderDays: body.reminderDays ?? 0,
          createdById: userId,
        },
        include: { createdBy: { select: { id: true, name: true } } },
      });

      return reply.status(201).send({
        success: true,
        message: "Event created.",
        data: { event },
      });
    }
  );

  // ── PUT /admin/calendar/events/:id ────────────────────────
  app.put(
    "/admin/calendar/events/:id",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as any;

      const event = await prisma.schoolEvent.findFirst({
        where: { id: parseInt(id), schoolId },
      });
      if (!event) return reply.status(404).send({ success: false, message: "Event not found." });

      const updated = await prisma.schoolEvent.update({
        where: { id: parseInt(id) },
        data: {
          ...(body.title && { title: body.title.trim() }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.eventType && { eventType: body.eventType }),
          ...(body.color && { color: body.color }),
          ...(body.startDate && { startDate: new Date(body.startDate) }),
          ...(body.endDate && { endDate: new Date(body.endDate) }),
          ...(body.isAllDay !== undefined && { isAllDay: body.isAllDay }),
          ...(body.startTime !== undefined && { startTime: body.startTime }),
          ...(body.endTime !== undefined && { endTime: body.endTime }),
          ...(body.forAllClasses !== undefined && { forAllClasses: body.forAllClasses }),
          ...(body.classIds !== undefined && { classIds: body.classIds }),
          ...(body.recurrence !== undefined && { recurrence: body.recurrence }),
          ...(body.reminderDays !== undefined && { reminderDays: body.reminderDays }),
        },
      });

      return reply.send({ success: true, message: "Event updated.", data: { event: updated } });
    }
  );

  // ── DELETE /admin/calendar/events/:id ────────────────────
  app.delete(
    "/admin/calendar/events/:id",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const event = await prisma.schoolEvent.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!event) return reply.status(404).send({ success: false, message: "Event not found." });

      await prisma.schoolEvent.delete({ where: { id: parseInt(id) } });
      return reply.send({ success: true, message: "Event deleted." });
    }
  );

  // ── GET /admin/calendar/upcoming ─────────────────────────
  app.get(
    "/admin/calendar/upcoming",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const today = new Date();
      const nextMonth = new Date();
      nextMonth.setDate(nextMonth.getDate() + 30);

      const [events, holidays] = await Promise.all([
        prisma.schoolEvent.findMany({
          where: { schoolId, startDate: { gte: today, lte: nextMonth } },
          orderBy: { startDate: "asc" },
          take: 10,
        }),
        prisma.holiday.findMany({
          where: { schoolId, date: { gte: today, lte: nextMonth } },
          orderBy: { date: "asc" },
          take: 10,
        }),
      ]);

      return reply.send({ success: true, data: { events, holidays } });
    }
  );
}