// apps/api/src/routes/admin/academic-calendar.ts
//
// Academic Calendar — holidays and school events for a session, plus
// the derived "is this date a working day?" logic that Attendance,
// Timetable and Fee-due calculations all need a single answer for.
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// Default colors per event type, so a school gets a sensible
// color-coded calendar without configuring anything.
const DEFAULT_EVENT_COLORS: Record<string, string> = {
  HOLIDAY: "#ef4444",
  EXAM: "#f59e0b",
  EVENT: "#6366f1",
  PTM: "#0ea5e9",
  SPORTS_DAY: "#10b981",
  ANNUAL_FUNCTION: "#a855f7",
  CUSTOM: "#64748b",
};

const WEEKDAY_BY_JS_DAY = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

/** Which occurrence of that weekday within its month (1st Saturday, 2nd Saturday, …). */
function nthWeekdayOfMonth(date: Date): number {
  return Math.floor((date.getDate() - 1) / 7) + 1;
}

export async function adminAcademicCalendarRoutes(app: FastifyInstance) {
  const P = "/admin/academic-calendar";

  // ── GET /admin/academic-calendar ──────────────────────────
  // Everything the calendar view needs for a session, in one call.
  app.get(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { academicYearId?: string; from?: string; to?: string; type?: string };

      let academicYearId = q.academicYearId ? parseInt(q.academicYearId) : null;
      if (!academicYearId) {
        const current = await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
        if (!current) return rep.status(400).send({ success: false, message: "No active session — create or activate one first." });
        academicYearId = current.id;
      }

      const dateFilter: any = {};
      if (q.from) dateFilter.gte = new Date(q.from);
      if (q.to) dateFilter.lte = new Date(q.to);
      const hasDateFilter = Object.keys(dateFilter).length > 0;

      const [holidays, events, workingConfig] = await Promise.all([
        prisma.holiday.findMany({
          where: { schoolId, academicYearId, ...(hasDateFilter ? { date: dateFilter } : {}) },
          orderBy: { date: "asc" },
        }),
        prisma.calendarEvent.findMany({
          where: {
            schoolId, academicYearId,
            ...(q.type ? { type: q.type as any } : {}),
            ...(hasDateFilter ? { startDate: dateFilter } : {}),
          },
          orderBy: { startDate: "asc" },
        }),
        prisma.workingDayConfig.findUnique({ where: { academicYearId } }),
      ]);

      return rep.send({ success: true, data: { academicYearId, holidays, events, workingConfig } });
    }
  );

  // ── GET /admin/academic-calendar/summary ──────────────────
  // Counts by type + total working days in the session — the numbers
  // an admin actually wants at a glance.
  app.get(`${P}/summary`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { academicYearId?: string };

      const session = q.academicYearId
        ? await prisma.academicYear.findFirst({ where: { id: parseInt(q.academicYearId), schoolId } })
        : await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
      if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

      const [holidays, eventsByType, config] = await Promise.all([
        prisma.holiday.findMany({ where: { schoolId, academicYearId: session.id }, select: { date: true, endDate: true } }),
        prisma.calendarEvent.groupBy({ by: ["type"], where: { schoolId, academicYearId: session.id }, _count: { id: true } }),
        prisma.workingDayConfig.findUnique({ where: { academicYearId: session.id } }),
      ]);

      // Expand multi-day holidays into individual dates so they're not
      // undercounted when working days are calculated.
      const holidayDates = new Set<string>();
      for (const h of holidays) {
        const start = new Date(h.date);
        const end = h.endDate ? new Date(h.endDate) : start;
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          holidayDates.add(d.toISOString().split("T")[0]);
        }
      }

      const workingDays = new Set(config?.workingDays ?? ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"]);
      const saturdayPattern = config?.saturdayPattern ?? "ALL_WORKING";

      let totalWorkingDays = 0;
      const cursor = new Date(session.startDate);
      const end = new Date(session.endDate);
      while (cursor <= end) {
        const iso = cursor.toISOString().split("T")[0];
        const weekday = WEEKDAY_BY_JS_DAY[cursor.getDay()];
        let isWorking = workingDays.has(weekday as any);

        if (isWorking && weekday === "SATURDAY" && saturdayPattern !== "ALL_WORKING") {
          const nth = nthWeekdayOfMonth(cursor);
          if (saturdayPattern === "ALL_OFF") isWorking = false;
          else if (saturdayPattern === "ALTERNATE_1_3") isWorking = nth === 1 || nth === 3;
          else if (saturdayPattern === "ALTERNATE_2_4") isWorking = nth === 2 || nth === 4;
          else if (saturdayPattern === "ALTERNATE_1_3_5") isWorking = nth === 1 || nth === 3 || nth === 5;
        }
        if (isWorking && holidayDates.has(iso)) isWorking = false;
        if (isWorking) totalWorkingDays++;

        cursor.setDate(cursor.getDate() + 1);
      }

      return rep.send({
        success: true,
        data: {
          session: { id: session.id, name: session.name, startDate: session.startDate, endDate: session.endDate },
          totalHolidayDates: holidayDates.size,
          totalWorkingDays,
          eventsByType: eventsByType.map(e => ({ type: e.type, count: e._count.id })),
        },
      });
    }
  );

  // ── GET /admin/academic-calendar/is-working-day ───────────
  // Single source of truth other modules can call for a given date.
  app.get(`${P}/is-working-day`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { date, academicYearId } = req.query as { date: string; academicYearId?: string };
      if (!date) return rep.status(400).send({ success: false, message: "date is required (YYYY-MM-DD)." });

      const session = academicYearId
        ? await prisma.academicYear.findFirst({ where: { id: parseInt(academicYearId), schoolId } })
        : await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
      if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

      const target = new Date(date);
      const config = await prisma.workingDayConfig.findUnique({ where: { academicYearId: session.id } });
      const workingDays = new Set(config?.workingDays ?? ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"]);
      const weekday = WEEKDAY_BY_JS_DAY[target.getDay()];

      let isWorking = workingDays.has(weekday as any);
      let reason: string | null = isWorking ? null : `${weekday.charAt(0)}${weekday.slice(1).toLowerCase()} is not a working day`;

      const pattern = config?.saturdayPattern ?? "ALL_WORKING";
      if (isWorking && weekday === "SATURDAY" && pattern !== "ALL_WORKING") {
        const nth = nthWeekdayOfMonth(target);
        const on = pattern === "ALL_OFF" ? false
          : pattern === "ALTERNATE_1_3" ? (nth === 1 || nth === 3)
          : pattern === "ALTERNATE_2_4" ? (nth === 2 || nth === 4)
          : pattern === "ALTERNATE_1_3_5" ? (nth === 1 || nth === 3 || nth === 5)
          : true;
        if (!on) { isWorking = false; reason = `${nth}${nth === 1 ? "st" : nth === 2 ? "nd" : nth === 3 ? "rd" : "th"} Saturday is off`; }
      }

      if (isWorking) {
        const holiday = await prisma.holiday.findFirst({
          where: {
            schoolId, academicYearId: session.id,
            OR: [
              { date: target },
              { AND: [{ date: { lte: target } }, { endDate: { gte: target } }] },
            ],
          },
        });
        if (holiday) { isWorking = false; reason = `Holiday — ${holiday.name}`; }
      }

      return rep.send({ success: true, data: { date, isWorkingDay: isWorking, reason } });
    }
  );

  // ─────────────────────────────────────────
  // HOLIDAYS
  // ─────────────────────────────────────────

  app.post(`${P}/holidays`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as { academicYearId: number; name: string; date: string; endDate?: string; type?: string; description?: string };

      if (!b.academicYearId || !b.name?.trim() || !b.date) {
        return rep.status(400).send({ success: false, message: "academicYearId, name and date are required." });
      }
      const session = await prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } });
      if (!session) return rep.status(404).send({ success: false, message: "Session not found." });
      if (session.status === "LOCKED") return rep.status(400).send({ success: false, message: "This session is locked." });

      const start = new Date(b.date);
      const end = b.endDate ? new Date(b.endDate) : null;
      if (end && end < start) return rep.status(400).send({ success: false, message: "End date can't be before the start date." });

      const holiday = await prisma.holiday.create({
        data: {
          schoolId, academicYearId: b.academicYearId, name: b.name.trim(),
          date: start, endDate: end, type: (b.type as any) ?? "PUBLIC",
          description: b.description ?? null,
        },
      });
      return rep.status(201).send({ success: true, message: "Holiday added.", data: { holiday } });
    }
  );

  app.put(`${P}/holidays/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const b = req.body as any;

      const existing = await prisma.holiday.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return rep.status(404).send({ success: false, message: "Holiday not found." });

      const holiday = await prisma.holiday.update({
        where: { id: parseInt(id) },
        data: {
          ...(b.name !== undefined ? { name: b.name.trim() } : {}),
          ...(b.date !== undefined ? { date: new Date(b.date) } : {}),
          ...(b.endDate !== undefined ? { endDate: b.endDate ? new Date(b.endDate) : null } : {}),
          ...(b.type !== undefined ? { type: b.type } : {}),
          ...(b.description !== undefined ? { description: b.description } : {}),
        },
      });
      return rep.send({ success: true, message: "Holiday updated.", data: { holiday } });
    }
  );

  app.delete(`${P}/holidays/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const existing = await prisma.holiday.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return rep.status(404).send({ success: false, message: "Holiday not found." });

      await prisma.holiday.delete({ where: { id: parseInt(id) } });
      return rep.send({ success: true, message: "Holiday removed." });
    }
  );

  // ── POST /admin/academic-calendar/holidays/bulk ───────────
  // Add several holidays at once (e.g. pasting in a published list).
  app.post(`${P}/holidays/bulk`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as { academicYearId: number; holidays: { name: string; date: string; endDate?: string; type?: string }[] };

      if (!b.academicYearId || !b.holidays?.length) {
        return rep.status(400).send({ success: false, message: "academicYearId and a non-empty holidays list are required." });
      }
      const session = await prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } });
      if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

      const valid = b.holidays.filter(h => h.name?.trim() && h.date);
      if (valid.length === 0) return rep.status(400).send({ success: false, message: "No valid holidays in the list — each needs a name and a date." });

      await prisma.holiday.createMany({
        data: valid.map(h => ({
          schoolId, academicYearId: b.academicYearId, name: h.name.trim(),
          date: new Date(h.date), endDate: h.endDate ? new Date(h.endDate) : null,
          type: (h.type as any) ?? "PUBLIC",
        })),
      });

      return rep.status(201).send({
        success: true,
        message: `${valid.length} holiday(s) added${valid.length < b.holidays.length ? ` — ${b.holidays.length - valid.length} skipped (missing name or date)` : ""}.`,
        data: { added: valid.length, skipped: b.holidays.length - valid.length },
      });
    }
  );

  // ─────────────────────────────────────────
  // CALENDAR EVENTS
  // ─────────────────────────────────────────

  app.post(`${P}/events`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as {
        academicYearId: number; title: string; type?: string;
        startDate: string; endDate?: string; startTime?: string; endTime?: string;
        location?: string; colorHex?: string; description?: string; isAllDay?: boolean;
      };

      if (!b.academicYearId || !b.title?.trim() || !b.startDate) {
        return rep.status(400).send({ success: false, message: "academicYearId, title and startDate are required." });
      }
      const session = await prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } });
      if (!session) return rep.status(404).send({ success: false, message: "Session not found." });
      if (session.status === "LOCKED") return rep.status(400).send({ success: false, message: "This session is locked." });

      const start = new Date(b.startDate);
      const end = b.endDate ? new Date(b.endDate) : null;
      if (end && end < start) return rep.status(400).send({ success: false, message: "End date can't be before the start date." });

      const type = (b.type as any) ?? "CUSTOM";
      const event = await prisma.calendarEvent.create({
        data: {
          schoolId, academicYearId: b.academicYearId, title: b.title.trim(), type,
          startDate: start, endDate: end,
          startTime: b.startTime ?? null, endTime: b.endTime ?? null,
          location: b.location ?? null,
          colorHex: b.colorHex ?? DEFAULT_EVENT_COLORS[type] ?? DEFAULT_EVENT_COLORS.CUSTOM,
          description: b.description ?? null,
          isAllDay: b.isAllDay ?? !b.startTime,
        },
      });
      return rep.status(201).send({ success: true, message: "Event added.", data: { event } });
    }
  );

  app.put(`${P}/events/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const b = req.body as any;

      const existing = await prisma.calendarEvent.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return rep.status(404).send({ success: false, message: "Event not found." });

      const event = await prisma.calendarEvent.update({
        where: { id: parseInt(id) },
        data: {
          ...(b.title !== undefined ? { title: b.title.trim() } : {}),
          ...(b.type !== undefined ? { type: b.type } : {}),
          ...(b.startDate !== undefined ? { startDate: new Date(b.startDate) } : {}),
          ...(b.endDate !== undefined ? { endDate: b.endDate ? new Date(b.endDate) : null } : {}),
          ...(b.startTime !== undefined ? { startTime: b.startTime } : {}),
          ...(b.endTime !== undefined ? { endTime: b.endTime } : {}),
          ...(b.location !== undefined ? { location: b.location } : {}),
          ...(b.colorHex !== undefined ? { colorHex: b.colorHex } : {}),
          ...(b.description !== undefined ? { description: b.description } : {}),
          ...(b.isAllDay !== undefined ? { isAllDay: b.isAllDay } : {}),
        },
      });
      return rep.send({ success: true, message: "Event updated.", data: { event } });
    }
  );

  app.delete(`${P}/events/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const existing = await prisma.calendarEvent.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return rep.status(404).send({ success: false, message: "Event not found." });

      await prisma.calendarEvent.delete({ where: { id: parseInt(id) } });
      return rep.send({ success: true, message: "Event removed." });
    }
  );

  // ── GET /admin/academic-calendar/export ───────────────────
  // Flat, chronological list of every calendar entry — what a CSV/PDF
  // export (or a printable year planner) renders from.
  app.get(`${P}/export`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { academicYearId?: string };

      const session = q.academicYearId
        ? await prisma.academicYear.findFirst({ where: { id: parseInt(q.academicYearId), schoolId } })
        : await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
      if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

      const [holidays, events] = await Promise.all([
        prisma.holiday.findMany({ where: { schoolId, academicYearId: session.id }, orderBy: { date: "asc" } }),
        prisma.calendarEvent.findMany({ where: { schoolId, academicYearId: session.id }, orderBy: { startDate: "asc" } }),
      ]);

      const rows = [
        ...holidays.map(h => ({
          date: h.date, endDate: h.endDate, title: h.name,
          category: "Holiday", subType: h.type, notes: h.description ?? "",
        })),
        ...events.map(e => ({
          date: e.startDate, endDate: e.endDate, title: e.title,
          category: "Event", subType: e.type,
          notes: [e.location, e.description].filter(Boolean).join(" — "),
        })),
      ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      return rep.send({ success: true, data: { session: { id: session.id, name: session.name }, rows } });
    }
  );
}
