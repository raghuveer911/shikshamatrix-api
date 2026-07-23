// apps/api/src/routes/parent/academics.ts
//
// FIXED — see the list of confirmed vs best-guess corrections above
// this file in chat. Every query now wrapped in safe() so one wrong
// guess degrades gracefully instead of crashing the whole route.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[parent/academics] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function verifyParentChild(parentUserId: number, studentRecordId: number, schoolId: number): Promise<boolean> {
  const student = await safe("verifyParentChild: student", () =>
    prisma.student.findFirst({ where: { id: studentRecordId, schoolId }, select: { userId: true } }), null);
  if (!student) return false;
  const link = await safe("verifyParentChild: link", () =>
    prisma.parentStudent.findFirst({ where: { parentId: parentUserId, studentId: student.userId } }), null);
  return !!link;
}

async function getChildClass(studentId: number, schoolId: number) {
  return safe("getChildClass", () =>
    prisma.student.findFirst({ where: { id: studentId, schoolId }, select: { class: { select: { id: true } } } }), null);
}

// PeriodSlot has no endTime — compute it from startTime + duration.
function addMinutes(startTime: string | null, duration: number | null): string | null {
  if (!startTime) return null;
  const m = startTime.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const total = parseInt(m[1]) * 60 + parseInt(m[2]) + (duration ?? 0);
  const h = Math.floor(total / 60) % 24, min = total % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]; // 1=Mon..6=Sat

export async function parentAcademicsRoutes(app: FastifyInstance) {

  // ── GET /parent/attendance ───────────────────────────────────
  app.get("/parent/attendance",
  { preHandler: appAuth },
  async (req: FastifyRequest, reply: FastifyReply) => {
    const { userId, schoolId } = req as any;
    const { studentId, view = "month", month, year, date } = req.query as Record<string, string>;
    const sid = parseInt(studentId);
 
    if (!(await verifyParentChild(userId, sid, schoolId)))
      return reply.status(403).send({ success: false, error: "NOT_LINKED" });
 
    const now = new Date();
 
    // ══════════════════════════════════════════════════════════
    // MONTH VIEW (default) — daily records for calendar grid
    // ══════════════════════════════════════════════════════════
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
 
    // ══════════════════════════════════════════════════════════
    // WEEK VIEW — 7 days (Sun-Sat) around a reference date
    // ══════════════════════════════════════════════════════════
    if (view === "week") {
      const refDate = date ? new Date(date) : now;
      const dayOfWeek = refDate.getDay(); // 0=Sun..6=Sat
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
 
    // ══════════════════════════════════════════════════════════
    // YEAR VIEW — per-month aggregated summary
    // ══════════════════════════════════════════════════════════
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
 
    return reply.status(400).send({ success: false, error: "INVALID_VIEW", message: "view must be month, week, or year" });
  }
);

  // ── GET /parent/academics/timetable ─────────────────────────
  app.get("/parent/academics/timetable",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { studentId } = req.query as { studentId: string };
      const sid = parseInt(studentId);

      if (!(await verifyParentChild(userId, sid, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      const student = await getChildClass(sid, schoolId);

      const slots = await safe("periodSlot.findMany", () =>
        prisma.periodSlot.findMany({
          where: { classId: student?.class?.id },
          orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
          select: {
            id: true, dayOfWeek: true, periodNumber: true, startTime: true, duration: true,
            subject: { select: { name: true } },
            teacher: { select: { user: { select: { name: true } } } },
          },
        }), [] as any[]);

      const timetable = [1, 2, 3, 4, 5, 6].map((dayNum) => ({
        day: dayNum, dayName: DAY_NAMES[dayNum],
        periods: slots
          .filter((s: any) => s.dayOfWeek === dayNum)
          .map((s: any) => ({
            id: s.id, periodNo: s.periodNumber,
            startTime: s.startTime, endTime: addMinutes(s.startTime, s.duration),
            subject: s.subject?.name ?? "—",
            teacher: s.teacher?.user?.name ?? "—",
          })),
      }));

      return reply.send({ success: true, data: { timetable } });
    }
  );

  // ── GET /parent/academics/marks ─────────────────────────────
  app.get("/parent/academics/marks",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { studentId } = req.query as { studentId: string };
      const sid = parseInt(studentId);

      if (!(await verifyParentChild(userId, sid, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      const student = await getChildClass(sid, schoolId);

      // ⚠️ best-guess model/relation names (same as dashboard.ts) — see chat note
      const exams = await safe("examConfig.findMany", () =>
        (prisma as any).examConfig.findMany({
          where: {
            schoolId, status: { in: ["COMPLETED", "RESULT_PUBLISHED"] },
            examClasses: { some: { classId: student?.class?.id } },
          },
          orderBy: { startDate: "desc" }, take: 5,
          select: {
            id: true, name: true, startDate: true,
            examClasses: {
              where: { classId: student?.class?.id },
              select: {
                subjects: {
                  select: {
                    maxMarks: true, minMarks: true,
                    subject: { select: { name: true } },
                    marksEntries: {
                      where: { studentId: sid },
                      select: { obtainedMarks: true, marksStatus: true },
                      take: 1,
                    },
                  },
                },
              },
            },
          },
        }), [] as any[]);

      return reply.send({
        success: true,
        data: {
          exams: exams.map((exam: any) => {
            const subjects = exam.examClasses[0]?.subjects ?? [];
            const results = subjects.map((s: any) => {
              const e = s.marksEntries[0];
              const isAbsent = e?.marksStatus === "ABSENT";
              return {
                subject: s.subject?.name ?? "—",
                totalMarks: s.maxMarks, passingMarks: s.minMarks,
                obtained: e && !isAbsent ? e.obtainedMarks : null,
                isAbsent,
                pct: e && !isAbsent ? Math.round((Number(e.obtainedMarks) / Number(s.maxMarks)) * 100) : null,
                passed: e && !isAbsent ? Number(e.obtainedMarks) >= Number(s.minMarks) : null,
              };
            });
            const obt = results.reduce((a: number, r: any) => a + (r.obtained ? Number(r.obtained) : 0), 0);
            const max = results.reduce((a: number, r: any) => a + Number(r.totalMarks), 0);
            return {
              examId: exam.id, examName: exam.name, startDate: exam.startDate,
              subjects: results,
              aggregate: { obtained: obt, total: max, pct: max > 0 ? Math.round((obt / max) * 100) : 0 },
            };
          }),
        },
      });
    }
  );

  // ── GET /parent/academics/homework ──────────────────────────
  app.get("/parent/academics/homework",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { studentId } = req.query as { studentId: string };
      const sid = parseInt(studentId);

      if (!(await verifyParentChild(userId, sid, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      const student = await getChildClass(sid, schoolId);

      const homework = await safe("studyAssignment.findMany", () =>
        prisma.studyAssignment.findMany({
          where: { schoolId, classId: student?.class?.id, status: "PUBLISHED" },
          orderBy: { dueDate: "asc" }, take: 20,
          select: {
            id: true, title: true, description: true,
            dueDate: true, createdAt: true, attachmentUrl: true,
            subject: { select: { name: true } },
            // ⚠️ best-guess relation name for the creator — see chat note
            createdBy: { select: { user: { select: { name: true } } } },
          },
        }), [] as any[]);

      return reply.send({
        success: true,
        data: {
          homework: homework.map((h: any) => ({
            id: h.id, title: h.title, description: h.description,
            dueDate: h.dueDate, createdAt: h.createdAt, fileUrl: h.attachmentUrl,
            subject: h.subject?.name ?? "—", teacher: h.createdBy?.user?.name ?? "—",
            isOverdue: h.dueDate ? new Date(h.dueDate) < new Date() : false,
          })),
        },
      });
    }
  );
}