// apps/api/src/routes/student/attendance.ts
//
// v2 — added "Attendance Reports" (streak tracking, monthly trend,
// yearly breakdown) — all from the confirmed Attendance model, no
// new schema. "Subject-wise Attendance" skipped — no period/subject-
// level attendance-tracking model exists in the schema (PeriodSlot/
// MasterPeriod only define the timetable structure, not per-period
// presence records).
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { z } from "zod";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/attendance] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function getStudentId(userId: number, schoolId: number): Promise<number | null> {
  const student = await safe("student lookup", () =>
    prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true } }), null);
  return student?.id ?? null;
}

const leaveSchema = z.object({
  fromDate: z.string(), toDate: z.string(), reason: z.string().min(5),
  attachmentUrl: z.string().optional(),
});

export async function studentAttendanceRoutes(app: FastifyInstance) {

  // ── GET /student/attendance?view=month|week|year&... — unchanged from v1 ──
  app.get("/student/attendance",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { view = "month", month, year, date } = req.query as Record<string, string>;

      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const now = new Date();

      if (view === "month") {
        const m = month ? parseInt(month) - 1 : now.getMonth();
        const y = year ? parseInt(year) : now.getFullYear();

        const records = await safe("attendance.findMany (month)", () =>
          prisma.attendance.findMany({
            where: { studentId: sid, date: { gte: new Date(y, m, 1), lte: new Date(y, m + 1, 0, 23, 59, 59) } },
            orderBy: { date: "asc" },
            select: { date: true, status: true, remarks: true },
          }), [] as any[]);

        const cnt = (s: string) => records.filter((r: any) => r.status === s).length;
        const summary = {
          present: cnt("PRESENT"), absent: cnt("ABSENT"), late: cnt("LATE"),
          halfDay: cnt("HALF_DAY"), onLeave: cnt("LEAVE"), total: records.length,
        };

        return reply.send({
          success: true,
          data: {
            view: "month", month: m + 1, year: y, records,
            summary: { ...summary, pct: summary.total > 0 ? Math.round((summary.present / summary.total) * 100) : 0 },
          },
        });
      }

      if (view === "week") {
        const refDate = date ? new Date(date) : now;
        const dayOfWeek = refDate.getDay();
        const weekStart = new Date(refDate); weekStart.setDate(refDate.getDate() - dayOfWeek); weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6); weekEnd.setHours(23, 59, 59, 999);

        const records = await safe("attendance.findMany (week)", () =>
          prisma.attendance.findMany({
            where: { studentId: sid, date: { gte: weekStart, lte: weekEnd } },
            select: { date: true, status: true, remarks: true },
          }), [] as any[]);

        const recordMap = new Map(records.map((r: any) => [new Date(r.date).toDateString(), r]));
        const days = Array.from({ length: 7 }, (_, i) => {
          const d = new Date(weekStart); d.setDate(weekStart.getDate() + i);
          const rec = recordMap.get(d.toDateString()) as any;
          return { date: d.toISOString(), status: rec?.status ?? null, remarks: rec?.remarks ?? null };
        });

        const presentCount = days.filter((d) => d.status === "PRESENT").length;
        const markedCount = days.filter((d) => d.status !== null).length;

        return reply.send({
          success: true,
          data: {
            view: "week", weekStart: weekStart.toISOString(), weekEnd: weekEnd.toISOString(), days,
            summary: { present: presentCount, total: markedCount, pct: markedCount > 0 ? Math.round((presentCount / markedCount) * 100) : 0 },
          },
        });
      }

      if (view === "year") {
        const y = year ? parseInt(year) : now.getFullYear();

        const records = await safe("attendance.findMany (year)", () =>
          prisma.attendance.findMany({
            where: { studentId: sid, date: { gte: new Date(y, 0, 1), lte: new Date(y, 11, 31, 23, 59, 59) } },
            select: { date: true, status: true },
          }), [] as any[]);

        const months = Array.from({ length: 12 }, (_, i) => {
          const monthRecords = records.filter((r: any) => new Date(r.date).getMonth() === i);
          const present = monthRecords.filter((r: any) => r.status === "PRESENT").length;
          const total = monthRecords.length;
          return { month: i + 1, present, total, pct: total > 0 ? Math.round((present / total) * 100) : null };
        });

        const yearTotal = records.length;
        const yearPresent = records.filter((r: any) => r.status === "PRESENT").length;

        return reply.send({
          success: true,
          data: {
            view: "year", year: y, months,
            summary: { present: yearPresent, total: yearTotal, pct: yearTotal > 0 ? Math.round((yearPresent / yearTotal) * 100) : 0 },
          },
        });
      }

      return reply.status(400).send({ success: false, error: "INVALID_VIEW" });
    }
  );

  // ══════════════════════════════════════════════════════════
  // NEW: GET /student/attendance/reports — streak, trend, breakdown
  // ══════════════════════════════════════════════════════════
  app.get("/student/attendance/reports",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const now = new Date();
      const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

      const allRecords = await safe("attendance.findMany (12mo)", () =>
        prisma.attendance.findMany({
          where: { studentId: sid, date: { gte: twelveMonthsAgo, lte: now } },
          orderBy: { date: "asc" },
          select: { date: true, status: true },
        }), [] as any[]);

      // ── Monthly trend (last 12 months, oldest to newest) ──
      const trend = Array.from({ length: 12 }, (_, i) => {
        const targetDate = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
        const monthRecords = allRecords.filter((r: any) => {
          const d = new Date(r.date);
          return d.getFullYear() === targetDate.getFullYear() && d.getMonth() === targetDate.getMonth();
        });
        const present = monthRecords.filter((r: any) => r.status === "PRESENT").length;
        const total = monthRecords.length;
        return {
          month: targetDate.getMonth() + 1, year: targetDate.getFullYear(),
          present, total, pct: total > 0 ? Math.round((present / total) * 100) : null,
        };
      });

      const validMonths = trend.filter((t) => t.total > 0);
      const bestMonth = validMonths.length > 0 ? validMonths.reduce((a, b) => (a.pct! > b.pct! ? a : b)) : null;
      const worstMonth = validMonths.length > 0 ? validMonths.reduce((a, b) => (a.pct! < b.pct! ? a : b)) : null;

      // ── Current streak (consecutive PRESENT days, most recent marked backward) ──
      const sortedDesc = [...allRecords].sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
      let currentStreak = 0;
      for (const r of sortedDesc) {
        if (r.status === "PRESENT") currentStreak++;
        else break;
      }

      // ── Best-ever streak (within the fetched 12-month window) ──
      const sortedAsc = [...allRecords].sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
      let bestStreak = 0, runningStreak = 0;
      for (const r of sortedAsc) {
        if (r.status === "PRESENT") { runningStreak++; bestStreak = Math.max(bestStreak, runningStreak); }
        else runningStreak = 0;
      }

      // ── Yearly (12mo window) breakdown ──
      const cnt = (s: string) => allRecords.filter((r: any) => r.status === s).length;
      const breakdown = {
        present: cnt("PRESENT"), absent: cnt("ABSENT"), late: cnt("LATE"),
        halfDay: cnt("HALF_DAY"), onLeave: cnt("LEAVE"), total: allRecords.length,
      };
      const overallPct = breakdown.total > 0 ? Math.round((breakdown.present / breakdown.total) * 100) : 0;

      return reply.send({
        success: true,
        data: {
          overallPct, breakdown, currentStreak, bestStreak,
          trend,
          bestMonth: bestMonth ? { month: bestMonth.month, year: bestMonth.year, pct: bestMonth.pct } : null,
          worstMonth: worstMonth ? { month: worstMonth.month, year: worstMonth.year, pct: worstMonth.pct } : null,
        },
      });
    }
  );

  // ── GET /student/leaves — unchanged from v1 ─────────────────
  app.get("/student/leaves",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const leaves = await safe("leaveRequest.findMany", () =>
        prisma.leaveRequest.findMany({
          where: { schoolId, applicantType: "STUDENT", studentUserId: userId },
          orderBy: { createdAt: "desc" }, take: 20,
          select: {
            id: true, fromDate: true, toDate: true, totalDays: true, reason: true,
            attachmentUrl: true, status: true, rejectionNote: true, createdAt: true, approvedAt: true,
          },
        }), [] as any[]);

      return reply.send({ success: true, data: { leaves } });
    }
  );

  // ── POST /student/leaves/apply — unchanged from v1 ──────────
  app.post("/student/leaves/apply",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const parsed = leaveSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });
      const { fromDate, toDate, reason, attachmentUrl } = parsed.data;

      const from = new Date(fromDate), to = new Date(toDate);
      const totalDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000) + 1);

      await prisma.leaveRequest.create({
        data: {
          schoolId, applicantType: "STUDENT", studentUserId: userId,
          fromDate: from, toDate: to, totalDays, reason,
          attachmentUrl: attachmentUrl ?? null, status: "PENDING",
        },
      });

      return reply.status(201).send({ success: true, message: "Leave application submitted for review" });
    }
  );
}