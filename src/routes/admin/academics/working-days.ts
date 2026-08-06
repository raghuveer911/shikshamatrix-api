// apps/api/src/routes/admin/academics/working-days.ts
// ─────────────────────────────────────────────────────────────
// Working Days — premium pass.
//
// The old version answered one question: which weekdays does the
// school run. That isn't enough to drive a calendar, so this version
// resolves an actual date to an actual day type by layering:
//
//   weekly pattern  →  Saturday rule  →  holidays  →  per-date override
//
// The last layer wins. Everything that reads "is the school open on
// this date" (attendance, timetable, transport) should call
// GET /admin/working-days/calendar rather than reimplement the rules.
//
// Requires the WorkingDayOverride model + DayType enum from
// prisma/schema-additions.prisma.
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

const ALL_WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
const DEFAULT_WORKING = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

type DayType = "FULL_DAY" | "HALF_DAY" | "HOLIDAY" | "EXAM_ONLY" | "ACTIVITY" | "CUSTOM";

/** JS getDay() → our WeekDay enum */
const weekdayOf = (d: Date) => ALL_WEEKDAYS[(d.getDay() + 6) % 7];

/** Which occurrence of that weekday in the month is this? 1st Sat, 2nd Sat… */
const nthOfMonth = (d: Date) => Math.floor((d.getDate() - 1) / 7) + 1;

function saturdayWorks(pattern: string, nth: number) {
  switch (pattern) {
    case "ALL_WORKING": return true;
    case "ALL_OFF": return false;
    case "ALTERNATE_1_3": return nth === 1 || nth === 3;
    case "ALTERNATE_2_4": return nth === 2 || nth === 4;
    case "ALTERNATE_1_3_5": return nth === 1 || nth === 3 || nth === 5;
    default: return true;
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Fixed-date Indian public holidays. Festival dates follow the lunar
 *  calendar and move every year, so they're deliberately left out —
 *  the UI asks the admin to add those rather than guessing wrong. */
function fixedIndianHolidays(year: number) {
  return [
    { date: `${year}-01-26`, name: "Republic Day", type: "NATIONAL" },
    { date: `${year}-05-01`, name: "Labour Day", type: "NATIONAL" },
    { date: `${year}-08-15`, name: "Independence Day", type: "NATIONAL" },
    { date: `${year}-10-02`, name: "Gandhi Jayanti", type: "NATIONAL" },
    { date: `${year}-12-25`, name: "Christmas", type: "NATIONAL" },
  ];
}

export async function adminWorkingDayRoutes(app: FastifyInstance) {
  const P = "/admin/working-days";
  const guard = { preHandler: [authenticate, requireCapability("academics.core")] };

  async function resolveSession(schoolId: number, academicYearId?: string | number) {
    return academicYearId
      ? prisma.academicYear.findFirst({ where: { id: Number(academicYearId), schoolId } })
      : prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
  }

  /** The one place that turns a date into a day type. */
  function buildResolver(
    config: { workingDays: string[]; saturdayPattern: string; sundayOff: boolean; halfDayWeekdays?: string[] },
    holidays: Map<string, { name: string; type: string }>,
    overrides: Map<string, { dayType: DayType; reason: string | null; endsAt: string | null }>,
  ) {
    return (d: Date) => {
      const key = iso(d);
      const wd = weekdayOf(d);

      // 1. weekly pattern
      let dayType: DayType = config.workingDays.includes(wd) ? "FULL_DAY" : "HOLIDAY";
      let reason: string | null = dayType === "HOLIDAY" ? "Weekly off" : null;

      // 2. Saturday rule
      if (wd === "SATURDAY" && config.workingDays.includes("SATURDAY")) {
        const nth = nthOfMonth(d);
        if (!saturdayWorks(config.saturdayPattern, nth)) {
          dayType = "HOLIDAY";
          reason = `${nth}${["st", "nd", "rd"][nth - 1] ?? "th"} Saturday off`;
        }
      }
      if (wd === "SUNDAY" && config.sundayOff) { dayType = "HOLIDAY"; reason = "Sunday"; }

      // 2b. recurring half days (e.g. every Saturday is a half day)
      if (dayType === "FULL_DAY" && (config.halfDayWeekdays ?? []).includes(wd)) {
        dayType = "HALF_DAY";
        reason = "Half day";
      }

      // 3. declared holidays
      const h = holidays.get(key);
      if (h) { dayType = "HOLIDAY"; reason = h.name; }

      // 4. explicit override — always wins
      const o = overrides.get(key);
      if (o) { dayType = o.dayType; reason = o.reason ?? reason; }

      return { date: key, weekday: wd, dayType, reason, endsAt: overrides.get(key)?.endsAt ?? null, isOverridden: !!o };
    };
  }

  async function loadContext(schoolId: number, sessionId: number) {
    const [config, holidayRows, overrideRows] = await Promise.all([
      prisma.workingDayConfig.findUnique({ where: { academicYearId: sessionId } }),
      prisma.holiday.findMany({ where: { schoolId, academicYearId: sessionId } }),
      (prisma as any).workingDayOverride
        ? (prisma as any).workingDayOverride.findMany({ where: { schoolId, academicYearId: sessionId } })
        : Promise.resolve([]),
    ]);

    const holidays = new Map<string, { name: string; type: string }>();
    for (const h of holidayRows) {
      // multi-day holidays expand across their whole range
      const start = new Date(h.date);
      const end = h.endDate ? new Date(h.endDate) : start;
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        holidays.set(iso(d), { name: h.name, type: h.type });
      }
    }

    const overrides = new Map<string, any>();
    for (const o of overrideRows as any[]) {
      overrides.set(iso(new Date(o.date)), { dayType: o.dayType, reason: o.reason, endsAt: o.endsAt, id: o.id });
    }

    const resolved = {
      workingDays: (config?.workingDays as string[]) ?? DEFAULT_WORKING,
      saturdayPattern: (config?.saturdayPattern as string) ?? "ALL_WORKING",
      sundayOff: config?.sundayOff ?? true,
      halfDayWeekdays: ((config as any)?.halfDayWeekdays as string[]) ?? [],
      defaultStartTime: (config as any)?.defaultStartTime ?? null,
      defaultEndTime: (config as any)?.defaultEndTime ?? null,
      halfDayEndTime: (config as any)?.halfDayEndTime ?? null,
      isConfigured: !!config,
    };

    return { config: resolved, holidays, overrides, overrideRows };
  }

  // ── GET /admin/working-days ──────────────────────────────
  app.get(P, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string };

    const session = await resolveSession(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "No academic session found. Create one first." });

    const { config, overrideRows } = await loadContext(schoolId, session.id);

    return rep.send({
      success: true,
      data: {
        academicYearId: session.id,
        sessionName: session.name,
        sessionLocked: session.status === "LOCKED",
        ...config,
        overrides: (overrideRows as any[]).map((o) => ({
          id: o.id, date: iso(new Date(o.date)), dayType: o.dayType, reason: o.reason, endsAt: o.endsAt,
        })),
      },
    });
  });

  // ── GET /admin/working-days/summary ──────────────────────
  // The Layer-1 stat rail: how many days of each kind the year holds.
  app.get(`${P}/summary`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string };

    const session = await resolveSession(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "No academic session found." });

    const { config, holidays, overrides } = await loadContext(schoolId, session.id);
    const resolve = buildResolver(config, holidays, overrides);

    const counts: Record<DayType, number> = {
      FULL_DAY: 0, HALF_DAY: 0, HOLIDAY: 0, EXAM_ONLY: 0, ACTIVITY: 0, CUSTOM: 0,
    };
    const byMonth: Record<string, { working: number; holiday: number; half: number }> = {};
    let totalDays = 0;
    let elapsedWorking = 0;
    const today = iso(new Date());

    for (let d = new Date(session.startDate); d <= new Date(session.endDate); d.setDate(d.getDate() + 1)) {
      const r = resolve(new Date(d));
      counts[r.dayType]++;
      totalDays++;
      const mk = r.date.slice(0, 7);
      byMonth[mk] ??= { working: 0, holiday: 0, half: 0 };
      if (r.dayType === "HOLIDAY") byMonth[mk].holiday++;
      else if (r.dayType === "HALF_DAY") { byMonth[mk].half++; byMonth[mk].working++; }
      else byMonth[mk].working++;
      if (r.dayType !== "HOLIDAY" && r.date <= today) elapsedWorking++;
    }

    // Half days still count as academic days — they're taught, just shorter.
    const academicDays = totalDays - counts.HOLIDAY;

    // How many Saturdays the pattern actually keeps
    let workingSaturdays = 0;
    let totalSaturdays = 0;
    for (let d = new Date(session.startDate); d <= new Date(session.endDate); d.setDate(d.getDate() + 1)) {
      if (weekdayOf(new Date(d)) !== "SATURDAY") continue;
      totalSaturdays++;
      if (resolve(new Date(d)).dayType !== "HOLIDAY") workingSaturdays++;
    }

    return rep.send({
      success: true,
      data: {
        sessionName: session.name,
        weekLength: config.workingDays.length,
        totalDays,
        academicDays,
        elapsedWorking,
        remainingWorking: Math.max(0, academicDays - elapsedWorking),
        counts,
        workingSaturdays,
        totalSaturdays,
        byMonth,
        /* RTE guidance is 200 instructional days for classes I–V and 220
           for VI–VIII — surfaced so admins can see a shortfall early. */
        rteTarget: 220,
        meetsRteTarget: academicDays >= 220,
      },
    });
  });

  // ── GET /admin/working-days/calendar ─────────────────────
  // Every date in the session (or one month) with its resolved type.
  app.get(`${P}/calendar`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string; month?: string; from?: string; to?: string };

    const session = await resolveSession(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "No academic session found." });

    const { config, holidays, overrides } = await loadContext(schoolId, session.id);
    const resolve = buildResolver(config, holidays, overrides);

    let from = new Date(session.startDate);
    let to = new Date(session.endDate);
    if (q.month) {
      const [y, m] = q.month.split("-").map(Number);
      from = new Date(y, m - 1, 1);
      to = new Date(y, m, 0);
    } else if (q.from && q.to) {
      from = new Date(q.from);
      to = new Date(q.to);
    }

    const days = [];
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) days.push(resolve(new Date(d)));

    return rep.send({ success: true, data: { sessionName: session.name, from: iso(from), to: iso(to), days } });
  });

  // ── PUT /admin/working-days ──────────────────────────────
  app.put(P, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as {
      academicYearId: number;
      workingDays: string[];
      saturdayPattern?: string;
      sundayOff?: boolean;
      halfDayWeekdays?: string[];
      defaultStartTime?: string;
      defaultEndTime?: string;
      halfDayEndTime?: string;
    };

    if (!b.academicYearId) return rep.status(400).send({ success: false, message: "Pick a session first." });
    if (!Array.isArray(b.workingDays) || b.workingDays.length === 0) {
      return rep.status(400).send({ success: false, message: "The school has to run on at least one day of the week." });
    }
    const invalid = b.workingDays.filter((d) => !ALL_WEEKDAYS.includes(d as any));
    if (invalid.length > 0) {
      return rep.status(400).send({ success: false, message: `Not a weekday: ${invalid.join(", ")}` });
    }

    const session = await prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } });
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });
    if (session.status === "LOCKED") {
      return rep.status(400).send({ success: false, message: "This session is locked. Unlock it to change the week." });
    }

    let workingDays = b.workingDays;
    if (b.sundayOff === true) workingDays = workingDays.filter((d) => d !== "SUNDAY");
    const sundayOff = b.sundayOff ?? !workingDays.includes("SUNDAY");
    const halfDayWeekdays = (b.halfDayWeekdays ?? []).filter((d) => workingDays.includes(d));

    const payload: any = {
      workingDays: workingDays as any,
      sundayOff,
      halfDayWeekdays: halfDayWeekdays as any,
      ...(b.saturdayPattern !== undefined ? { saturdayPattern: b.saturdayPattern as any } : {}),
      ...(b.defaultStartTime !== undefined ? { defaultStartTime: b.defaultStartTime } : {}),
      ...(b.defaultEndTime !== undefined ? { defaultEndTime: b.defaultEndTime } : {}),
      ...(b.halfDayEndTime !== undefined ? { halfDayEndTime: b.halfDayEndTime } : {}),
    };

    const config = await prisma.workingDayConfig.upsert({
      where: { academicYearId: b.academicYearId },
      create: { schoolId, academicYearId: b.academicYearId, saturdayPattern: "ALL_WORKING", ...payload },
      update: payload,
    });

    return rep.send({ success: true, message: "Week saved.", data: { config } });
  });

  // ── POST /admin/working-days/overrides ───────────────────
  // Accepts one date or many — the UI drag-selects a range and posts
  // the whole thing at once.
  app.post(`${P}/overrides`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const b = req.body as {
      academicYearId: number;
      dates: string[];
      dayType: DayType;
      reason?: string;
      endsAt?: string;
    };

    if (!b.academicYearId || !Array.isArray(b.dates) || b.dates.length === 0) {
      return rep.status(400).send({ success: false, message: "Pick at least one date." });
    }

    const session = await prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } });
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });
    if (session.status === "LOCKED") {
      return rep.status(400).send({ success: false, message: "This session is locked." });
    }

    const start = new Date(session.startDate);
    const end = new Date(session.endDate);
    const outside = b.dates.filter((d) => new Date(d) < start || new Date(d) > end);
    if (outside.length > 0) {
      return rep.status(400).send({
        success: false,
        message: `${outside.length} date(s) fall outside ${session.name}. Pick dates inside the session.`,
      });
    }

    let saved = 0;
    for (const dateStr of b.dates) {
      await (prisma as any).workingDayOverride.upsert({
        where: { academicYearId_date: { academicYearId: b.academicYearId, date: new Date(dateStr) } },
        create: {
          schoolId, academicYearId: b.academicYearId, date: new Date(dateStr),
          dayType: b.dayType, reason: b.reason ?? null, endsAt: b.endsAt ?? null, createdById: userId,
        },
        update: { dayType: b.dayType, reason: b.reason ?? null, endsAt: b.endsAt ?? null },
      });
      saved++;
    }

    return rep.send({ success: true, message: `${saved} day${saved === 1 ? "" : "s"} updated.`, data: { saved } });
  });

  // ── DELETE /admin/working-days/overrides ─────────────────
  app.delete(`${P}/overrides`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { academicYearId: number; dates: string[] };

    if (!b.academicYearId || !Array.isArray(b.dates) || b.dates.length === 0) {
      return rep.status(400).send({ success: false, message: "Pick at least one date." });
    }

    const { count } = await (prisma as any).workingDayOverride.deleteMany({
      where: { schoolId, academicYearId: b.academicYearId, date: { in: b.dates.map((d) => new Date(d)) } },
    });

    return rep.send({ success: true, message: `${count} day${count === 1 ? "" : "s"} reset to the normal pattern.` });
  });

  // ── POST /admin/working-days/copy ────────────────────────
  app.post(`${P}/copy`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { fromAcademicYearId: number; toAcademicYearId: number; includeOverrides?: boolean };

    const [from, to] = await Promise.all([
      prisma.academicYear.findFirst({ where: { id: b.fromAcademicYearId, schoolId } }),
      prisma.academicYear.findFirst({ where: { id: b.toAcademicYearId, schoolId } }),
    ]);
    if (!from || !to) return rep.status(404).send({ success: false, message: "Both sessions must exist." });
    if (to.status === "LOCKED") return rep.status(400).send({ success: false, message: "The target session is locked." });

    const source = await prisma.workingDayConfig.findUnique({ where: { academicYearId: from.id } });
    if (!source) return rep.status(404).send({ success: false, message: `${from.name} has no working-day setup to copy.` });

    const payload: any = {
      workingDays: source.workingDays as any,
      saturdayPattern: source.saturdayPattern,
      sundayOff: source.sundayOff,
      halfDayWeekdays: ((source as any).halfDayWeekdays ?? []) as any,
      defaultStartTime: (source as any).defaultStartTime ?? null,
      defaultEndTime: (source as any).defaultEndTime ?? null,
      halfDayEndTime: (source as any).halfDayEndTime ?? null,
    };

    await prisma.workingDayConfig.upsert({
      where: { academicYearId: to.id },
      create: { schoolId, academicYearId: to.id, ...payload },
      update: payload,
    });

    // Per-date overrides are dated, so they can't be copied across years
    // — shifting them by a year would land on the wrong weekdays.
    return rep.send({
      success: true,
      message: `Week pattern copied from ${from.name} to ${to.name}. Date-specific overrides weren't copied — they belong to their own year.`,
    });
  });

  // ── GET /admin/working-days/suggested-holidays ───────────
  app.get(`${P}/suggested-holidays`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string };

    const session = await resolveSession(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "No academic session found." });

    const startYear = new Date(session.startDate).getFullYear();
    const endYear = new Date(session.endDate).getFullYear();
    const candidates = [
      ...fixedIndianHolidays(startYear),
      ...(endYear !== startYear ? fixedIndianHolidays(endYear) : []),
    ].filter((h) => new Date(h.date) >= new Date(session.startDate) && new Date(h.date) <= new Date(session.endDate));

    const existing = await prisma.holiday.findMany({
      where: { schoolId, academicYearId: session.id },
      select: { date: true },
    });
    const have = new Set(existing.map((h) => iso(new Date(h.date))));

    return rep.send({
      success: true,
      data: {
        suggestions: candidates.map((c) => ({ ...c, alreadyAdded: have.has(c.date) })),
        note: "Fixed-date national holidays only. Festival dates move with the lunar calendar, so add those yourself.",
      },
    });
  });

  // ── POST /admin/working-days/import-holidays ─────────────
  app.post(`${P}/import-holidays`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as {
      academicYearId: number;
      holidays: { date: string; name: string; type?: string; endDate?: string }[];
    };

    if (!b.academicYearId || !Array.isArray(b.holidays) || b.holidays.length === 0) {
      return rep.status(400).send({ success: false, message: "Nothing to import." });
    }

    const session = await prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } });
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });
    if (session.status === "LOCKED") return rep.status(400).send({ success: false, message: "This session is locked." });

    let added = 0;
    let skipped = 0;
    for (const h of b.holidays) {
      const date = new Date(h.date);
      if (date < new Date(session.startDate) || date > new Date(session.endDate)) { skipped++; continue; }
      const dupe = await prisma.holiday.findFirst({ where: { schoolId, academicYearId: b.academicYearId, date } });
      if (dupe) { skipped++; continue; }
      await prisma.holiday.create({
        data: {
          schoolId, academicYearId: b.academicYearId, name: h.name, date,
          endDate: h.endDate ? new Date(h.endDate) : null,
          type: (h.type as any) ?? "NATIONAL",
        },
      });
      added++;
    }

    return rep.send({
      success: added > 0,
      message: `${added} holiday${added === 1 ? "" : "s"} added${skipped ? `, ${skipped} skipped as duplicate or out of range` : ""}.`,
      data: { added, skipped },
    });
  });
}
