// apps/api/src/routes/admin/academics/academic-calendar.ts
// ─────────────────────────────────────────────────────────────
// Academic Calendar — premium pass.
//
// Kept from before: holidays CRUD, events CRUD, /summary,
// /is-working-day (other modules call it — signature unchanged),
// /export, /holidays/bulk.
//
// Added:
//   GET  /overview          → Layer 1 stat rail (today, this week,
//                             upcoming, counts by type)
//   GET  /agenda            → flat, filtered, chronological feed with
//                             recurring events already expanded
//   GET  /day               → everything on one date, for the drawer
//   POST /events/:id/duplicate
//   POST /events/bulk       → delete / publish / retype / shift dates
//   GET  /export.ics        → downloadable iCalendar file
//
// Recurrence is expanded at read time — one stored row, many
// occurrences. Nothing is written per occurrence, so editing the
// series stays a single update.
//
// Needs the Phase 2 fields in prisma/schema-additions.prisma. Every
// new field is read defensively, so this file also runs correctly
// before the migration — those features simply stay inert.
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

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

const iso = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

function nthWeekdayOfMonth(date: Date): number {
  return Math.floor((date.getDate() - 1) / 7) + 1;
}

/** Expand a stored event into every occurrence that lands in [from, to]. */
function expandOccurrences(event: any, from: Date, to: Date) {
  const rule = event.recurrence ?? "NONE";
  const spanMs = event.endDate
    ? new Date(event.endDate).getTime() - new Date(event.startDate).getTime()
    : 0;

  if (rule === "NONE") {
    const start = new Date(event.startDate);
    const end = event.endDate ? new Date(event.endDate) : start;
    if (end < from || start > to) return [];
    return [{ ...event, occurrenceDate: iso(start), occurrenceEndDate: iso(end), isOccurrence: false }];
  }

  const hardStop = event.recurrenceUntil ? new Date(event.recurrenceUntil) : to;
  const limit = hardStop < to ? hardStop : to;
  const out: any[] = [];
  const cursor = new Date(event.startDate);
  let guard = 0;

  while (cursor <= limit && guard++ < 500) {
    const occEnd = new Date(cursor.getTime() + spanMs);
    if (occEnd >= from) {
      out.push({
        ...event,
        occurrenceDate: iso(cursor),
        occurrenceEndDate: iso(occEnd),
        isOccurrence: iso(cursor) !== iso(event.startDate),
      });
    }
    if (rule === "WEEKLY") cursor.setDate(cursor.getDate() + 7);
    else if (rule === "MONTHLY") cursor.setMonth(cursor.getMonth() + 1);
    else if (rule === "YEARLY") cursor.setFullYear(cursor.getFullYear() + 1);
    else break;
  }
  return out;
}

/** Multi-day holidays → one entry per date. */
function expandHoliday(h: any) {
  const start = new Date(h.date);
  const end = h.endDate ? new Date(h.endDate) : start;
  const dates: string[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) dates.push(iso(d));
  return dates;
}

export async function adminAcademicCalendarRoutes(app: FastifyInstance) {
  const P = "/admin/academic-calendar";
  const guard = { preHandler: [authenticate, requireCapability("academics.core")] };

  async function resolveSession(schoolId: number, academicYearId?: string | number) {
    return academicYearId
      ? prisma.academicYear.findFirst({ where: { id: Number(academicYearId), schoolId } })
      : prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
  }

  /** Events with the owner joined when the relation exists, plain otherwise. */
  async function findEvents(where: any) {
    try {
      return await prisma.calendarEvent.findMany({
        where,
        orderBy: { startDate: "asc" },
        include: { responsibleStaff: { include: { user: { select: { name: true } } } } } as any,
      });
    } catch {
      return prisma.calendarEvent.findMany({ where, orderBy: { startDate: "asc" } });
    }
  }

  // ── GET /admin/academic-calendar ─────────────────────────
  app.get(P, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string; from?: string; to?: string; type?: string };

    const session = await resolveSession(schoolId, q.academicYearId);
    if (!session) return rep.status(400).send({ success: false, message: "No active session — create or activate one first." });

    const dateFilter: any = {};
    if (q.from) dateFilter.gte = new Date(q.from);
    if (q.to) dateFilter.lte = new Date(q.to);
    const hasDateFilter = Object.keys(dateFilter).length > 0;

    const [holidays, events, workingConfig] = await Promise.all([
      prisma.holiday.findMany({
        where: { schoolId, academicYearId: session.id, ...(hasDateFilter ? { date: dateFilter } : {}) },
        orderBy: { date: "asc" },
      }),
      findEvents({
        schoolId,
        academicYearId: session.id,
        ...(q.type ? { type: q.type as any } : {}),
        // Recurring rows can start before the window and still land in it,
        // so date filtering happens after expansion, not in the query.
      }),
      prisma.workingDayConfig.findUnique({ where: { academicYearId: session.id } }),
    ]);

    const from = q.from ? new Date(q.from) : new Date(session.startDate);
    const to = q.to ? new Date(q.to) : new Date(session.endDate);
    const expanded = events.flatMap((e: any) => expandOccurrences(e, from, to));

    return rep.send({
      success: true,
      data: { academicYearId: session.id, sessionName: session.name, holidays, events: expanded, workingConfig },
    });
  });

  // ── GET /admin/academic-calendar/overview ────────────────
  app.get(`${P}/overview`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string };

    const session = await resolveSession(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

    const [holidays, events] = await Promise.all([
      prisma.holiday.findMany({ where: { schoolId, academicYearId: session.id } }),
      findEvents({ schoolId, academicYearId: session.id }),
    ]);

    const seasonStart = new Date(session.startDate);
    const seasonEnd = new Date(session.endDate);
    const all = events.flatMap((e: any) => expandOccurrences(e, seasonStart, seasonEnd));

    const today = iso(new Date());
    const weekEnd = new Date();
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekEndIso = iso(weekEnd);

    const holidayDates = new Set(holidays.flatMap(expandHoliday));

    const onDate = (d: string) =>
      all.filter((e: any) => d >= e.occurrenceDate && d <= (e.occurrenceEndDate ?? e.occurrenceDate));

    const byType: Record<string, number> = {};
    for (const e of all) byType[e.type] = (byType[e.type] ?? 0) + 1;

    const upcoming = all
      .filter((e: any) => e.occurrenceDate >= today)
      .sort((a: any, b: any) => a.occurrenceDate.localeCompare(b.occurrenceDate));

    // Anything that has a reminder configured and is inside its window
    const dueReminders = upcoming.filter((e: any) => {
      if (!e.reminderDaysBefore) return false;
      const fireOn = new Date(e.occurrenceDate);
      fireOn.setDate(fireOn.getDate() - e.reminderDaysBefore);
      return iso(fireOn) <= today;
    });

    return rep.send({
      success: true,
      data: {
        session: { id: session.id, name: session.name, startDate: session.startDate, endDate: session.endDate },
        todayCount: onDate(today).length,
        todayIsHoliday: holidayDates.has(today),
        weekCount: all.filter((e: any) => e.occurrenceDate >= today && e.occurrenceDate <= weekEndIso).length,
        upcomingCount: upcoming.length,
        totalEvents: all.length,
        totalHolidayDates: holidayDates.size,
        byType,
        dueReminders: dueReminders.slice(0, 10).map((e: any) => ({
          id: e.id, title: e.title, date: e.occurrenceDate, type: e.type,
        })),
        nextUp: upcoming.slice(0, 5).map((e: any) => ({
          id: e.id, title: e.title, date: e.occurrenceDate, type: e.type, colorHex: e.colorHex,
        })),
      },
    });
  });

  // ── GET /admin/academic-calendar/agenda ──────────────────
  app.get(`${P}/agenda`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as {
      academicYearId?: string; from?: string; to?: string;
      type?: string; audience?: string; classId?: string; search?: string;
      includeHolidays?: string;
    };

    const session = await resolveSession(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

    const from = q.from ? new Date(q.from) : new Date();
    const to = q.to ? new Date(q.to) : new Date(session.endDate);

    const [events, holidays] = await Promise.all([
      findEvents({
        schoolId, academicYearId: session.id,
        ...(q.type && q.type !== "ALL" ? { type: q.type as any } : {}),
      }),
      q.includeHolidays === "false"
        ? Promise.resolve([])
        : prisma.holiday.findMany({
            where: { schoolId, academicYearId: session.id, date: { lte: to } },
            orderBy: { date: "asc" },
          }),
    ]);

    let rows = events
      .flatMap((e: any) => expandOccurrences(e, from, to))
      .map((e: any) => ({
        kind: "EVENT" as const,
        id: e.id,
        title: e.title,
        type: e.type,
        date: e.occurrenceDate,
        endDate: e.occurrenceEndDate,
        startTime: e.startTime,
        endTime: e.endTime,
        location: e.location,
        colorHex: e.colorHex,
        description: e.description,
        isAllDay: e.isAllDay,
        audience: e.audience ?? "EVERYONE",
        classIds: e.classIds ?? [],
        responsibleStaffName: e.responsibleStaff?.user?.name ?? null,
        responsibleStaffId: e.responsibleStaffId ?? null,
        reminderDaysBefore: e.reminderDaysBefore ?? null,
        notifyInApp: e.notifyInApp ?? false,
        notifySms: e.notifySms ?? false,
        recurrence: e.recurrence ?? "NONE",
        attachments: e.attachments ?? [],
        isPublished: e.isPublished ?? true,
        isOccurrence: e.isOccurrence,
      }));

    if (q.audience && q.audience !== "ALL") {
      rows = rows.filter((r) => r.audience === q.audience);
    }
    if (q.classId) {
      const cid = Number(q.classId);
      rows = rows.filter((r) => r.audience !== "SPECIFIC_CLASSES" || (r.classIds ?? []).includes(cid));
    }
    if (q.search) {
      const needle = q.search.toLowerCase();
      rows = rows.filter((r) =>
        `${r.title} ${r.location ?? ""} ${r.description ?? ""}`.toLowerCase().includes(needle),
      );
    }

    const holidayNeedle = q.search?.toLowerCase();
    const holidayRows = (holidays as any[])
      .filter((h) => !holidayNeedle || `${h.name} ${h.description ?? ""}`.toLowerCase().includes(holidayNeedle))
      .flatMap((h) =>
        expandHoliday(h)
          .filter((d) => d >= iso(from) && d <= iso(to))
          .map((d) => ({
            kind: "HOLIDAY" as const,
            id: h.id,
            title: h.name,
            type: h.type,
            date: d,
            endDate: d,
            colorHex: DEFAULT_EVENT_COLORS.HOLIDAY,
            description: h.description,
            isMultiDay: !!h.endDate,
          })),
      );

    const merged = [...rows, ...holidayRows].sort((a, b) => a.date.localeCompare(b.date));

    return rep.send({
      success: true,
      data: { from: iso(from), to: iso(to), rows: merged, eventCount: rows.length, holidayCount: holidayRows.length },
    });
  });

  // ── GET /admin/academic-calendar/day ─────────────────────
  app.get(`${P}/day`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { date: string; academicYearId?: string };
    if (!q.date) return rep.status(400).send({ success: false, message: "A date is required (YYYY-MM-DD)." });

    const session = await resolveSession(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

    const target = new Date(q.date);
    const [events, holidays, config] = await Promise.all([
      findEvents({ schoolId, academicYearId: session.id }),
      prisma.holiday.findMany({
        where: {
          schoolId, academicYearId: session.id,
          OR: [{ date: target }, { AND: [{ date: { lte: target } }, { endDate: { gte: target } }] }],
        },
      }),
      prisma.workingDayConfig.findUnique({ where: { academicYearId: session.id } }),
    ]);

    const dayEvents = events
      .flatMap((e: any) => expandOccurrences(e, target, target))
      .filter((e: any) => q.date >= e.occurrenceDate && q.date <= (e.occurrenceEndDate ?? e.occurrenceDate));

    const weekday = WEEKDAY_BY_JS_DAY[target.getDay()];
    const workingDays = new Set((config?.workingDays as string[]) ?? ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"]);
    let isWorking = workingDays.has(weekday);
    if (isWorking && weekday === "SATURDAY") {
      const pattern = config?.saturdayPattern ?? "ALL_WORKING";
      const nth = nthWeekdayOfMonth(target);
      isWorking =
        pattern === "ALL_OFF" ? false
        : pattern === "ALTERNATE_1_3" ? nth === 1 || nth === 3
        : pattern === "ALTERNATE_2_4" ? nth === 2 || nth === 4
        : pattern === "ALTERNATE_1_3_5" ? nth === 1 || nth === 3 || nth === 5
        : true;
    }
    if (holidays.length > 0) isWorking = false;

    return rep.send({
      success: true,
      data: {
        date: q.date, weekday, isWorkingDay: isWorking,
        holidays, events: dayEvents,
      },
    });
  });

  // ── GET /admin/academic-calendar/summary ─────────────────
  app.get(`${P}/summary`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string };

    const session = await resolveSession(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

    const [holidays, eventsByType, config] = await Promise.all([
      prisma.holiday.findMany({ where: { schoolId, academicYearId: session.id }, select: { date: true, endDate: true } }),
      prisma.calendarEvent.groupBy({ by: ["type"], where: { schoolId, academicYearId: session.id }, _count: { id: true } }),
      prisma.workingDayConfig.findUnique({ where: { academicYearId: session.id } }),
    ]);

    const holidayDates = new Set(holidays.flatMap(expandHoliday));
    const workingDays = new Set((config?.workingDays as string[]) ?? ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"]);
    const saturdayPattern = config?.saturdayPattern ?? "ALL_WORKING";

    let totalWorkingDays = 0;
    const cursor = new Date(session.startDate);
    const end = new Date(session.endDate);
    while (cursor <= end) {
      const key = iso(cursor);
      const weekday = WEEKDAY_BY_JS_DAY[cursor.getDay()];
      let isWorking = workingDays.has(weekday);

      if (isWorking && weekday === "SATURDAY" && saturdayPattern !== "ALL_WORKING") {
        const nth = nthWeekdayOfMonth(cursor);
        isWorking =
          saturdayPattern === "ALL_OFF" ? false
          : saturdayPattern === "ALTERNATE_1_3" ? nth === 1 || nth === 3
          : saturdayPattern === "ALTERNATE_2_4" ? nth === 2 || nth === 4
          : saturdayPattern === "ALTERNATE_1_3_5" ? nth === 1 || nth === 3 || nth === 5
          : true;
      }
      if (isWorking && holidayDates.has(key)) isWorking = false;
      if (isWorking) totalWorkingDays++;
      cursor.setDate(cursor.getDate() + 1);
    }

    return rep.send({
      success: true,
      data: {
        session: { id: session.id, name: session.name, startDate: session.startDate, endDate: session.endDate },
        totalHolidayDates: holidayDates.size,
        totalWorkingDays,
        eventsByType: eventsByType.map((e) => ({ type: e.type, count: e._count.id })),
      },
    });
  });

  // ── GET /admin/academic-calendar/is-working-day ──────────
  // Signature unchanged — Attendance, Timetable and Fees call this.
  app.get(`${P}/is-working-day`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { date, academicYearId } = req.query as { date: string; academicYearId?: string };
    if (!date) return rep.status(400).send({ success: false, message: "date is required (YYYY-MM-DD)." });

    const session = await resolveSession(schoolId, academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

    const target = new Date(date);
    const config = await prisma.workingDayConfig.findUnique({ where: { academicYearId: session.id } });
    const workingDays = new Set((config?.workingDays as string[]) ?? ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"]);
    const weekday = WEEKDAY_BY_JS_DAY[target.getDay()];

    let isWorking = workingDays.has(weekday);
    let reason: string | null = isWorking ? null : `${weekday.charAt(0)}${weekday.slice(1).toLowerCase()} is not a working day`;

    const pattern = config?.saturdayPattern ?? "ALL_WORKING";
    if (isWorking && weekday === "SATURDAY" && pattern !== "ALL_WORKING") {
      const nth = nthWeekdayOfMonth(target);
      const on =
        pattern === "ALL_OFF" ? false
        : pattern === "ALTERNATE_1_3" ? nth === 1 || nth === 3
        : pattern === "ALTERNATE_2_4" ? nth === 2 || nth === 4
        : pattern === "ALTERNATE_1_3_5" ? nth === 1 || nth === 3 || nth === 5
        : true;
      if (!on) {
        isWorking = false;
        reason = `${nth}${nth === 1 ? "st" : nth === 2 ? "nd" : nth === 3 ? "rd" : "th"} Saturday is off`;
      }
    }

    if (isWorking) {
      const holiday = await prisma.holiday.findFirst({
        where: {
          schoolId, academicYearId: session.id,
          OR: [{ date: target }, { AND: [{ date: { lte: target } }, { endDate: { gte: target } }] }],
        },
      });
      if (holiday) { isWorking = false; reason = `Holiday — ${holiday.name}`; }
    }

    return rep.send({ success: true, data: { date, isWorkingDay: isWorking, reason } });
  });

  // ═══ HOLIDAYS ═══════════════════════════════════════════

  app.post(`${P}/holidays`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { academicYearId: number; name: string; date: string; endDate?: string; type?: string; description?: string };

    if (!b.academicYearId || !b.name?.trim() || !b.date) {
      return rep.status(400).send({ success: false, message: "A holiday needs a name and a date." });
    }
    const session = await prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } });
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });
    if (session.status === "LOCKED") return rep.status(400).send({ success: false, message: "This session is locked." });

    const start = new Date(b.date);
    const end = b.endDate ? new Date(b.endDate) : null;
    if (end && end < start) return rep.status(400).send({ success: false, message: "The end date can't come before the start date." });
    if (start < new Date(session.startDate) || start > new Date(session.endDate)) {
      return rep.status(400).send({ success: false, message: `That date falls outside ${session.name}.` });
    }

    const holiday = await prisma.holiday.create({
      data: {
        schoolId, academicYearId: b.academicYearId, name: b.name.trim(),
        date: start, endDate: end, type: (b.type as any) ?? "NATIONAL",
        description: b.description ?? null,
      },
    });
    return rep.status(201).send({ success: true, message: `"${holiday.name}" added.`, data: { holiday } });
  });

  app.put(`${P}/holidays/:id`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
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
  });

  app.delete(`${P}/holidays/:id`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { id } = req.params as { id: string };
    const existing = await prisma.holiday.findFirst({ where: { id: parseInt(id), schoolId } });
    if (!existing) return rep.status(404).send({ success: false, message: "Holiday not found." });

    await prisma.holiday.delete({ where: { id: parseInt(id) } });
    return rep.send({ success: true, message: `"${existing.name}" removed.` });
  });

  app.post(`${P}/holidays/bulk`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { academicYearId: number; holidays: { name: string; date: string; endDate?: string; type?: string }[] };

    if (!b.academicYearId || !b.holidays?.length) {
      return rep.status(400).send({ success: false, message: "Nothing to import." });
    }
    const session = await prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } });
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

    const inRange = (d: string) => new Date(d) >= new Date(session.startDate) && new Date(d) <= new Date(session.endDate);
    const valid = b.holidays.filter((h) => h.name?.trim() && h.date && inRange(h.date));
    if (valid.length === 0) {
      return rep.status(400).send({ success: false, message: `Nothing usable — each row needs a name and a date inside ${session.name}.` });
    }

    const existing = await prisma.holiday.findMany({
      where: { schoolId, academicYearId: b.academicYearId },
      select: { date: true },
    });
    const have = new Set(existing.map((h) => iso(h.date)));
    const fresh = valid.filter((h) => !have.has(iso(h.date)));

    if (fresh.length > 0) {
      await prisma.holiday.createMany({
        data: fresh.map((h) => ({
          schoolId, academicYearId: b.academicYearId, name: h.name.trim(),
          date: new Date(h.date), endDate: h.endDate ? new Date(h.endDate) : null,
          type: (h.type as any) ?? "NATIONAL",
        })),
      });
    }

    const skipped = b.holidays.length - fresh.length;
    return rep.status(201).send({
      success: fresh.length > 0,
      message: `${fresh.length} holiday${fresh.length === 1 ? "" : "s"} added${skipped ? `, ${skipped} skipped as duplicate or out of range` : ""}.`,
      data: { added: fresh.length, skipped },
    });
  });

  // ═══ EVENTS ═════════════════════════════════════════════

  app.post(`${P}/events`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const b = req.body as any;

    if (!b.academicYearId || !b.title?.trim() || !b.startDate) {
      return rep.status(400).send({ success: false, message: "An event needs a title and a start date." });
    }
    const session = await prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } });
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });
    if (session.status === "LOCKED") return rep.status(400).send({ success: false, message: "This session is locked." });

    const start = new Date(b.startDate);
    const end = b.endDate ? new Date(b.endDate) : null;
    if (end && end < start) return rep.status(400).send({ success: false, message: "The end date can't come before the start date." });
    if (b.startTime && b.endTime && b.endTime <= b.startTime) {
      return rep.status(400).send({ success: false, message: "The end time has to be after the start time." });
    }
    if (b.audience === "SPECIFIC_CLASSES" && !(b.classIds?.length > 0)) {
      return rep.status(400).send({ success: false, message: "Pick at least one class, or change the audience." });
    }

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
        ...({
          audience: b.audience ?? "EVERYONE",
          classIds: b.audience === "SPECIFIC_CLASSES" ? b.classIds ?? [] : [],
          responsibleStaffId: b.responsibleStaffId ?? null,
          reminderDaysBefore: b.reminderDaysBefore ?? null,
          notifyInApp: b.notifyInApp ?? false,
          notifySms: b.notifySms ?? false,
          recurrence: b.recurrence ?? "NONE",
          recurrenceUntil: b.recurrenceUntil ? new Date(b.recurrenceUntil) : null,
          attachments: b.attachments ?? undefined,
          isPublished: b.isPublished ?? true,
          createdById: userId,
        } as any),
      } as any,
    });
    return rep.status(201).send({ success: true, message: `"${event.title}" added to the calendar.`, data: { event } });
  });

  app.put(`${P}/events/:id`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
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
        ...({
          ...(b.audience !== undefined ? { audience: b.audience } : {}),
          ...(b.classIds !== undefined ? { classIds: b.classIds } : {}),
          ...(b.responsibleStaffId !== undefined ? { responsibleStaffId: b.responsibleStaffId } : {}),
          ...(b.reminderDaysBefore !== undefined ? { reminderDaysBefore: b.reminderDaysBefore } : {}),
          ...(b.notifyInApp !== undefined ? { notifyInApp: b.notifyInApp } : {}),
          ...(b.notifySms !== undefined ? { notifySms: b.notifySms } : {}),
          ...(b.recurrence !== undefined ? { recurrence: b.recurrence } : {}),
          ...(b.recurrenceUntil !== undefined ? { recurrenceUntil: b.recurrenceUntil ? new Date(b.recurrenceUntil) : null } : {}),
          ...(b.attachments !== undefined ? { attachments: b.attachments } : {}),
          ...(b.isPublished !== undefined ? { isPublished: b.isPublished } : {}),
        } as any),
      } as any,
    });
    return rep.send({ success: true, message: "Event updated.", data: { event } });
  });

  app.delete(`${P}/events/:id`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { id } = req.params as { id: string };
    const existing = await prisma.calendarEvent.findFirst({ where: { id: parseInt(id), schoolId } });
    if (!existing) return rep.status(404).send({ success: false, message: "Event not found." });

    await prisma.calendarEvent.delete({ where: { id: parseInt(id) } });
    return rep.send({ success: true, message: `"${existing.title}" removed.` });
  });

  // ── POST /admin/academic-calendar/events/:id/duplicate ───
  app.post(`${P}/events/:id/duplicate`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { startDate?: string; title?: string };

    const source: any = await prisma.calendarEvent.findFirst({ where: { id: parseInt(id), schoolId } });
    if (!source) return rep.status(404).send({ success: false, message: "Event not found." });

    const start = b.startDate ? new Date(b.startDate) : new Date(source.startDate);
    const span = source.endDate
      ? new Date(source.endDate).getTime() - new Date(source.startDate).getTime()
      : 0;

    const { id: _drop, createdAt: _c, updatedAt: _u, ...rest } = source;
    const copy = await prisma.calendarEvent.create({
      data: {
        ...rest,
        title: b.title?.trim() || `${source.title} (copy)`,
        startDate: start,
        endDate: source.endDate ? new Date(start.getTime() + span) : null,
        ...({ createdById: userId } as any),
      } as any,
    });

    return rep.status(201).send({ success: true, message: `"${copy.title}" created.`, data: { event: copy } });
  });

  // ── POST /admin/academic-calendar/events/bulk ────────────
  app.post(`${P}/events/bulk`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as {
      action: "delete" | "publish" | "unpublish" | "set-type" | "shift-days";
      ids: number[];
      type?: string;
      days?: number;
    };

    if (!Array.isArray(b.ids) || b.ids.length === 0) {
      return rep.status(400).send({ success: false, message: "Select at least one event." });
    }

    const events = await prisma.calendarEvent.findMany({ where: { schoolId, id: { in: b.ids } } });
    const results: { id: number; title: string; ok: boolean; reason?: string }[] = [];

    for (const e of events) {
      try {
        if (b.action === "delete") {
          await prisma.calendarEvent.delete({ where: { id: e.id } });
        } else if (b.action === "publish" || b.action === "unpublish") {
          await prisma.calendarEvent.update({
            where: { id: e.id },
            data: { isPublished: b.action === "publish" } as any,
          });
        } else if (b.action === "set-type") {
          if (!b.type) throw new Error("no type given");
          await prisma.calendarEvent.update({
            where: { id: e.id },
            data: { type: b.type as any, colorHex: DEFAULT_EVENT_COLORS[b.type] ?? e.colorHex },
          });
        } else if (b.action === "shift-days") {
          if (!b.days) throw new Error("no shift amount given");
          const start = new Date(e.startDate);
          start.setDate(start.getDate() + b.days);
          const end = e.endDate ? new Date(e.endDate) : null;
          if (end) end.setDate(end.getDate() + b.days);
          await prisma.calendarEvent.update({ where: { id: e.id }, data: { startDate: start, endDate: end } });
        }
        results.push({ id: e.id, title: e.title, ok: true });
      } catch (err: any) {
        results.push({ id: e.id, title: e.title, ok: false, reason: err.message ?? "Failed" });
      }
    }

    const done = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    return rep.send({
      success: done > 0,
      message:
        failed.length === 0
          ? `${done} event${done === 1 ? "" : "s"} updated.`
          : `${done} updated, ${failed.length} skipped — ${failed.map((f) => `${f.title}: ${f.reason}`).join("; ")}.`,
      data: { results },
    });
  });

  // ── GET /admin/academic-calendar/export ──────────────────
  app.get(`${P}/export`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string };

    const session = await resolveSession(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

    const [holidays, events] = await Promise.all([
      prisma.holiday.findMany({ where: { schoolId, academicYearId: session.id }, orderBy: { date: "asc" } }),
      findEvents({ schoolId, academicYearId: session.id }),
    ]);

    const rows = [
      ...holidays.map((h) => ({
        date: h.date, endDate: h.endDate, title: h.name,
        category: "Holiday", subType: h.type, notes: h.description ?? "",
      })),
      ...events.map((e: any) => ({
        date: e.startDate, endDate: e.endDate, title: e.title,
        category: "Event", subType: e.type,
        owner: e.responsibleStaff?.user?.name ?? "",
        notes: [e.location, e.description].filter(Boolean).join(" — "),
      })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return rep.send({ success: true, data: { session: { id: session.id, name: session.name }, rows } });
  });

  // ── GET /admin/academic-calendar/export.ics ──────────────
  // A real .ics file the admin downloads and imports into Google
  // Calendar, Outlook or Apple Calendar. Deliberately a file rather
  // than a live two-way sync — that needs OAuth per user and would
  // quietly drift out of date.
  app.get(`${P}/export.ics`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string };

    const session = await resolveSession(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { name: true } });

    const [holidays, events] = await Promise.all([
      prisma.holiday.findMany({ where: { schoolId, academicYearId: session.id }, orderBy: { date: "asc" } }),
      findEvents({ schoolId, academicYearId: session.id }),
    ]);

    const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const dateOnly = (d: Date | string) => iso(d).replace(/-/g, "");
    /** DTEND for all-day entries is exclusive, so it lands on the next day. */
    const nextDay = (d: Date | string) => {
      const n = new Date(d);
      n.setDate(n.getDate() + 1);
      return dateOnly(n);
    };
    const esc = (s: string) => (s ?? "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");

    const lines: string[] = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//ShikshaMatrix//Academic Calendar//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${esc(`${school?.name ?? "School"} — ${session.name}`)}`,
    ];

    for (const h of holidays) {
      lines.push(
        "BEGIN:VEVENT",
        `UID:holiday-${h.id}@shikshamatrix`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${dateOnly(h.date)}`,
        `DTEND;VALUE=DATE:${nextDay(h.endDate ?? h.date)}`,
        `SUMMARY:${esc(h.name)}`,
        `CATEGORIES:HOLIDAY,${h.type}`,
        ...(h.description ? [`DESCRIPTION:${esc(h.description)}`] : []),
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
      );
    }

    for (const e of events as any[]) {
      const timed = !e.isAllDay && e.startTime;
      const dt = (d: Date | string, t: string) => `${dateOnly(d)}T${t.replace(":", "")}00`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:event-${e.id}@shikshamatrix`,
        `DTSTAMP:${stamp}`,
        timed
          ? `DTSTART:${dt(e.startDate, e.startTime)}`
          : `DTSTART;VALUE=DATE:${dateOnly(e.startDate)}`,
        timed
          ? `DTEND:${dt(e.endDate ?? e.startDate, e.endTime ?? e.startTime)}`
          : `DTEND;VALUE=DATE:${nextDay(e.endDate ?? e.startDate)}`,
        `SUMMARY:${esc(e.title)}`,
        `CATEGORIES:${e.type}`,
        ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
        ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
        ...(e.recurrence && e.recurrence !== "NONE"
          ? [`RRULE:FREQ=${e.recurrence}${e.recurrenceUntil ? `;UNTIL=${dateOnly(e.recurrenceUntil)}` : ""}`]
          : []),
        ...(e.reminderDaysBefore
          ? ["BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:-P${e.reminderDaysBefore}D`, `DESCRIPTION:${esc(e.title)}`, "END:VALARM"]
          : []),
        "END:VEVENT",
      );
    }

    lines.push("END:VCALENDAR");

    return rep
      .header("Content-Type", "text/calendar; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${session.name.replace(/[^\w-]/g, "")}-calendar.ics"`)
      .send(lines.join("\r\n"));
  });
}
