// apps/api/src/routes/dashboard/academics/subjects.ts
//
// UPDATED — "My Subjects" is now a proper hub, not just a flat list.
// Instead of grouping by subject only (hiding per-class stats), each
// subject+class pairing the teacher teaches is its own entry with:
//   - live enrolled student count
//   - pending homework count for that subject+class
//   - today's period (if any) — powers the "Today" highlight in the UI
//
// No new models/enums — reuses PeriodSlot, Student, StudyAssignment
// exactly as already confirmed elsewhere in the Academics module.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[academics/subjects] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function academicsSubjectsRoutes(app: FastifyInstance) {

  // ── GET /academics/subjects — subject+class pairs the teacher teaches ──
  app.get("/academics/subjects",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;

      const slots = await safe("period slots", () =>
        prisma.periodSlot.findMany({
          where: { schoolId, teacherId: staffId, subject: { isNot: null } },
          select: {
            subjectId: true, classId: true, dayOfWeek: true, periodNumber: true, startTime: true,
            subject: { select: { id: true, name: true, code: true } },
            class: { select: { id: true, name: true, section: true, classNumber: true } },
          },
        }), [] as any[]);

      // JS getDay(): 0=Sun..6=Sat — matches this schema's dayOfWeek
      // numbering (1=Mon..6=Sat, confirmed via timetable.ts's DAYS
      // array + its `for i=1 to 6` loop). Sunday (0) simply has no
      // periods, which is already the existing behavior.
      const today = new Date().getDay();

      // Group into unique subject+class pairs (not just subject —
      // the same subject taught to 3 classes needs 3 separate cards
      // so each can show its own student count / homework / period).
      const pairMap = new Map<string, any>();
      for (const slot of slots) {
        if (!slot.subject || !slot.subjectId) continue;
        const key = `${slot.subjectId}-${slot.classId}`;
        if (!pairMap.has(key)) {
          pairMap.set(key, {
            subjectId: slot.subject.id, subjectName: slot.subject.name, subjectCode: slot.subject.code,
            classId: slot.class.id, className: slot.class.name, section: slot.class.section,
            classNumber: slot.class.classNumber,
            periodsThisWeek: 0, todayPeriods: [] as { periodNumber: number; startTime: string | null }[],
          });
        }
        const pair = pairMap.get(key);
        pair.periodsThisWeek += 1;
        if (slot.dayOfWeek === today) {
          pair.todayPeriods.push({ periodNumber: slot.periodNumber, startTime: slot.startTime });
        }
      }

      const pairs = Array.from(pairMap.values()).map((p) => {
        p.todayPeriods.sort((a: any, b: any) => a.periodNumber - b.periodNumber);
        return { ...p, todayPeriod: p.todayPeriods[0] ?? null, todayPeriods: undefined };
      });

      // Enrich each pair with live stats — parallel, defensively wrapped.
      const enriched = await Promise.all(pairs.map(async (p) => {
        const [studentCount, pendingHomework] = await Promise.all([
          safe("student count", () =>
            prisma.student.count({ where: { schoolId, classId: p.classId, isActive: true } }), 0),
          safe("pending homework count", () =>
            prisma.studyAssignment.count({
              where: { schoolId, classId: p.classId, subjectId: p.subjectId, dueDate: { gte: new Date() } },
            }), 0),
        ]);
        return { ...p, studentCount, pendingHomework };
      }));

      // Sort: today's periods first (by period number), then alphabetically by subject
      enriched.sort((a, b) => {
        if (a.todayPeriod && !b.todayPeriod) return -1;
        if (!a.todayPeriod && b.todayPeriod) return 1;
        if (a.todayPeriod && b.todayPeriod) return a.todayPeriod.periodNumber - b.todayPeriod.periodNumber;
        return a.subjectName.localeCompare(b.subjectName);
      });

      return reply.send({
        success: true,
        data: {
          subjects: enriched,
          summary: {
            totalSubjects: new Set(enriched.map((p) => p.subjectId)).size,
            totalClasses: new Set(enriched.map((p) => p.classId)).size,
            periodsToday: enriched.filter((p) => p.todayPeriod).length,
          },
        },
      });
    }
  );
}