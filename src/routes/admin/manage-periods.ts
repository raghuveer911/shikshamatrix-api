import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── Period Type Colors ──────────────────────────────────────
const PERIOD_TYPE_COLORS: Record<string, string> = {
  REGULAR:  "#6366f1",
  BREAK:    "#f59e0b",
  LUNCH:    "#10b981",
  ASSEMBLY: "#3b82f6",
  ACTIVITY: "#8b5cf6",
  LAB:      "#06b6d4",
  EXAM:     "#ef4444",
};

// ── Time Helpers ────────────────────────────────────────────
function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function calcDuration(start: string, end: string): number {
  return timeToMinutes(end) - timeToMinutes(start);
}

// ── Conflict Check ──────────────────────────────────────────
function hasConflict(
  newStart: string,
  newEnd: string,
  existing: { startTime: string; endTime: string; id?: number }[],
  excludeId?: number
): { conflict: boolean; conflictWith?: string; message?: string } {
  const ns = timeToMinutes(newStart);
  const ne = timeToMinutes(newEnd);

  if (ns >= ne) {
    return { conflict: true, message: "Start time must be before end time." };
  }

  for (const p of existing) {
    if (excludeId && (p as any).id === excludeId) continue;
    const ps = timeToMinutes(p.startTime);
    const pe = timeToMinutes(p.endTime);

    // Check overlap: new period overlaps if ns < pe AND ne > ps
    if (ns < pe && ne > ps) {
      return {
        conflict: true,
        conflictWith: `${p.startTime}–${p.endTime}`,
        message: `Time conflict with existing period (${p.startTime}–${p.endTime}). Periods cannot overlap.`,
      };
    }
  }
  return { conflict: false };
}

export async function adminManagePeriodsRoutes(app: FastifyInstance) {

  // ── GET /admin/manage-periods ─────────────────────────────
  // Get all master periods for a school/session
  app.get("/admin/manage-periods",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { sessionName?: string; dayOfWeek?: string };

      // Get current session if not specified
      let sessionName = q.sessionName;
      if (!sessionName) {
        const currentYear = await prisma.academicYear.findFirst({
          where: { schoolId, isCurrent: true },
        });
        sessionName = currentYear?.name ?? "";
      }

      const periods = await prisma.masterPeriod.findMany({
        where: {
          schoolId,
          sessionName,
          ...(q.dayOfWeek ? { dayOfWeek: parseInt(q.dayOfWeek) } : {}),
        },
        orderBy: [{ dayOfWeek: "asc" }, { serialNumber: "asc" }],
      });

      // Stats
      const activePeriods = periods.filter(p => p.isActive);
      const teachingPeriods = activePeriods.filter(p => p.periodType === "REGULAR" || p.periodType === "LAB" || p.periodType === "EXAM");
      const breakPeriods = activePeriods.filter(p => ["BREAK", "LUNCH", "ASSEMBLY"].includes(p.periodType));

      const totalTeachingMins = teachingPeriods.reduce((s, p) => s + p.duration, 0);

      // Gap detection
      const gaps: { after: string; before: string; gapMins: number; dayOfWeek: number }[] = [];
      const dayGroups: Record<number, typeof periods> = {};
      periods.forEach(p => {
        if (!dayGroups[p.dayOfWeek]) dayGroups[p.dayOfWeek] = [];
        dayGroups[p.dayOfWeek].push(p);
      });
      Object.entries(dayGroups).forEach(([day, dayPeriods]) => {
        const sorted = [...dayPeriods].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
        for (let i = 0; i < sorted.length - 1; i++) {
          const curr = sorted[i];
          const next = sorted[i + 1];
          const gapMins = timeToMinutes(next.startTime) - timeToMinutes(curr.endTime);
          if (gapMins > 0) {
            gaps.push({ after: curr.endTime, before: next.startTime, gapMins, dayOfWeek: parseInt(day) });
          }
        }
      });

      return reply.send({
        success: true,
        data: {
          periods,
          sessionName,
          stats: {
            total: periods.length,
            active: activePeriods.length,
            teachingHours: Math.round(totalTeachingMins / 60 * 10) / 10,
            breakCount: breakPeriods.length,
          },
          gaps,
          typeColors: PERIOD_TYPE_COLORS,
        },
      });
    }
  );

  // ── POST /admin/manage-periods ────────────────────────────
  app.post("/admin/manage-periods",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as {
        name: string;
        startTime: string;
        endTime: string;
        periodType: string;
        dayOfWeek: number;
        sessionName: string;
        isActive?: boolean;
        color?: string;
      };

      if (!body.name || !body.startTime || !body.endTime) {
        return reply.status(400).send({ success: false, message: "Name, startTime, endTime required." });
      }

      const duration = calcDuration(body.startTime, body.endTime);
      if (duration <= 0) {
        return reply.status(400).send({ success: false, message: "End time must be after start time." });
      }

      // Get existing periods for same day/session for conflict check
      const existing = await prisma.masterPeriod.findMany({
        where: { schoolId, sessionName: body.sessionName, dayOfWeek: body.dayOfWeek },
        select: { id: true, startTime: true, endTime: true },
      });

      const { conflict, message } = hasConflict(body.startTime, body.endTime, existing);
      if (conflict) {
        return reply.status(409).send({ success: false, error: "TIME_CONFLICT", message });
      }

      // Get next serial number
      const maxSerial = await prisma.masterPeriod.aggregate({
        where: { schoolId, sessionName: body.sessionName, dayOfWeek: body.dayOfWeek },
        _max: { serialNumber: true },
      });
      const serialNumber = (maxSerial._max.serialNumber ?? 0) + 1;

      const period = await prisma.masterPeriod.create({
        data: {
          schoolId,
          sessionName: body.sessionName,
          name: body.name.trim(),
          startTime: body.startTime,
          endTime: body.endTime,
          duration,
          periodType: body.periodType as any,
          dayOfWeek: body.dayOfWeek,
          serialNumber,
          isActive: body.isActive ?? true,
          color: body.color ?? PERIOD_TYPE_COLORS[body.periodType] ?? "#6366f1",
        },
      });

      return reply.status(201).send({
        success: true,
        message: `Period "${period.name}" added.`,
        data: { period },
      });
    }
  );

  // ── PUT /admin/manage-periods/:id ─────────────────────────
  app.put("/admin/manage-periods/:id",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        startTime?: string;
        endTime?: string;
        periodType?: string;
        isActive?: boolean;
        color?: string;
      };

      const existing_period = await prisma.masterPeriod.findFirst({
        where: { id: parseInt(id), schoolId },
      });
      if (!existing_period) return reply.status(404).send({ success: false, message: "Period not found." });

      const newStart = body.startTime ?? existing_period.startTime;
      const newEnd = body.endTime ?? existing_period.endTime;
      const duration = calcDuration(newStart, newEnd);

      if (duration <= 0) {
        return reply.status(400).send({ success: false, message: "End time must be after start time." });
      }

      // Conflict check (exclude self)
      if (body.startTime || body.endTime) {
        const others = await prisma.masterPeriod.findMany({
          where: { schoolId, sessionName: existing_period.sessionName, dayOfWeek: existing_period.dayOfWeek, id: { not: parseInt(id) } },
          select: { id: true, startTime: true, endTime: true },
        });
        const { conflict, message } = hasConflict(newStart, newEnd, others);
        if (conflict) return reply.status(409).send({ success: false, error: "TIME_CONFLICT", message });
      }

      const updated = await prisma.masterPeriod.update({
        where: { id: parseInt(id) },
        data: {
          ...(body.name && { name: body.name.trim() }),
          ...(body.startTime && { startTime: body.startTime }),
          ...(body.endTime && { endTime: body.endTime }),
          duration,
          ...(body.periodType && {
            periodType: body.periodType as any,
            color: body.color ?? PERIOD_TYPE_COLORS[body.periodType] ?? existing_period.color,
          }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
          ...(body.color && { color: body.color }),
        },
      });

      return reply.send({ success: true, message: "Period updated.", data: { period: updated } });
    }
  );

  // ── PATCH /admin/manage-periods/:id/toggle ────────────────
  app.patch("/admin/manage-periods/:id/toggle",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const p = await prisma.masterPeriod.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!p) return reply.status(404).send({ success: false, message: "Period not found." });

      const updated = await prisma.masterPeriod.update({
        where: { id: parseInt(id) },
        data: { isActive: !p.isActive },
      });

      return reply.send({
        success: true,
        message: `Period "${updated.name}" ${updated.isActive ? "activated" : "deactivated"}.`,
        data: { period: updated },
      });
    }
  );

  // ── PATCH /admin/manage-periods/reorder ───────────────────
  app.patch("/admin/manage-periods/reorder",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as {
        periodIds: number[]; // ordered array
        sessionName: string;
        dayOfWeek: number;
      };

      // Update serial numbers in order
      await Promise.all(body.periodIds.map((id, index) =>
        prisma.masterPeriod.updateMany({
          where: { id, schoolId },
          data: { serialNumber: index + 1 },
        })
      ));

      return reply.send({ success: true, message: "Periods reordered." });
    }
  );

  // ── POST /admin/manage-periods/copy-day ───────────────────
  // Copy periods from one day to another
  app.post("/admin/manage-periods/copy-day",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as {
        fromDay: number;
        toDays: number[];
        sessionName: string;
        clearExisting?: boolean;
      };

      const sourcePeriods = await prisma.masterPeriod.findMany({
        where: { schoolId, sessionName: body.sessionName, dayOfWeek: body.fromDay },
        orderBy: { serialNumber: "asc" },
      });

      if (sourcePeriods.length === 0) {
        return reply.status(400).send({ success: false, message: "No periods found in source day." });
      }

      let copiedCount = 0;
      for (const toDay of body.toDays) {
        if (body.clearExisting) {
          await prisma.masterPeriod.deleteMany({
            where: { schoolId, sessionName: body.sessionName, dayOfWeek: toDay },
          });
        }

        for (const p of sourcePeriods) {
          // Check conflict before copying
          const existing = await prisma.masterPeriod.findMany({
            where: { schoolId, sessionName: body.sessionName, dayOfWeek: toDay },
            select: { id: true, startTime: true, endTime: true },
          });
          const { conflict } = hasConflict(p.startTime, p.endTime, existing);
          if (!conflict) {
            await prisma.masterPeriod.create({
              data: {
                schoolId,
                sessionName: body.sessionName,
                name: p.name,
                startTime: p.startTime,
                endTime: p.endTime,
                duration: p.duration,
                periodType: p.periodType,
                dayOfWeek: toDay,
                serialNumber: p.serialNumber,
                isActive: p.isActive,
                color: p.color,
              },
            });
            copiedCount++;
          }
        }
      }

      return reply.send({
        success: true,
        message: `${copiedCount} periods copied to ${body.toDays.length} day(s).`,
      });
    }
  );

  // ── DELETE /admin/manage-periods/:id ─────────────────────
  app.delete("/admin/manage-periods/:id",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const p = await prisma.masterPeriod.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!p) return reply.status(404).send({ success: false, message: "Period not found." });

      await prisma.masterPeriod.delete({ where: { id: parseInt(id) } });

      // Re-order serials for that day
      const remaining = await prisma.masterPeriod.findMany({
        where: { schoolId, sessionName: p.sessionName, dayOfWeek: p.dayOfWeek },
        orderBy: { serialNumber: "asc" },
      });
      await Promise.all(remaining.map((r, i) =>
        prisma.masterPeriod.update({ where: { id: r.id }, data: { serialNumber: i + 1 } })
      ));

      return reply.send({ success: true, message: `Period "${p.name}" deleted.` });
    }
  );

  // ── GET /admin/manage-periods/for-timetable ───────────────
  // Used by timetable page to get predefined periods
  app.get("/admin/manage-periods/for-timetable",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { sessionName?: string; dayOfWeek?: string };

      const currentYear = await prisma.academicYear.findFirst({
        where: { schoolId, isCurrent: true },
      });

      const periods = await prisma.masterPeriod.findMany({
        where: {
          schoolId,
          sessionName: q.sessionName ?? currentYear?.name ?? "",
          isActive: true,
          ...(q.dayOfWeek ? { dayOfWeek: parseInt(q.dayOfWeek) } : {}),
        },
        orderBy: [{ dayOfWeek: "asc" }, { serialNumber: "asc" }],
      });

      return reply.send({ success: true, data: { periods } });
    }
  );

  // ── POST /admin/manage-periods/validate ──────────────────
  // Validate a time range before adding
  app.post("/admin/manage-periods/validate",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as {
        startTime: string;
        endTime: string;
        sessionName: string;
        dayOfWeek: number;
        excludeId?: number;
      };

      const existing = await prisma.masterPeriod.findMany({
        where: { schoolId, sessionName: body.sessionName, dayOfWeek: body.dayOfWeek },
        select: { id: true, startTime: true, endTime: true },
      });

      const result = hasConflict(body.startTime, body.endTime, existing, body.excludeId);
      const duration = calcDuration(body.startTime, body.endTime);

      // Next available start time suggestion
      const sorted = [...existing].sort((a, b) => timeToMinutes(b.endTime) - timeToMinutes(a.endTime));
      const nextSuggested = sorted.length > 0 ? sorted[0].endTime : "09:00";

      return reply.send({
        success: true,
        data: {
          isValid: !result.conflict,
          conflict: result.conflict,
          message: result.message,
          duration: duration > 0 ? duration : 0,
          nextSuggested,
        },
      });
    }
  );
}
