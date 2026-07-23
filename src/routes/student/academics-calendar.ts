// apps/api/src/routes/student/academics-calendar.ts
//
// Centralized Calendar — SchoolEvent (EXAM/HOLIDAY/MEETING/EVENT/
// SPORTS/CULTURAL/ACADEMIC/OTHER, all confirmed) + StudyAssignment
// deadlines (dueDate, confirmed). One flexible date-range endpoint
// powers Month/Week/Day views on the frontend.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/calendar] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function getStudentContext(userId: number, schoolId: number) {
  return safe("student lookup", () =>
    prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true, classId: true } }), null);
}

export async function studentCalendarRoutes(app: FastifyInstance) {

  // ── GET /student/academics/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD ──
  app.get("/student/academics/calendar",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { start, end } = req.query as { start?: string; end?: string };

      const student = await getStudentContext(userId, schoolId);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const now = new Date();
      const rangeStart = start ? new Date(start) : new Date(now.getFullYear(), now.getMonth(), 1);
      const rangeEnd = end ? new Date(end) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

      const [events, assignments] = await Promise.all([
        safe("schoolEvent.findMany", () =>
          prisma.schoolEvent.findMany({
            where: {
              schoolId,
              OR: [{ forAllClasses: true }, { classIds: { has: student.classId } }],
              startDate: { lte: rangeEnd }, endDate: { gte: rangeStart },
            },
            orderBy: { startDate: "asc" },
            select: {
              id: true, title: true, description: true, eventType: true, color: true,
              startDate: true, endDate: true, isAllDay: true, startTime: true, endTime: true,
            },
          }), [] as any[]),

        safe("studyAssignment.findMany (deadlines)", () =>
          prisma.studyAssignment.findMany({
            where: {
              schoolId, classId: student.classId, isActive: true,
              dueDate: { gte: rangeStart, lte: rangeEnd },
            },
            select: {
              id: true, title: true, type: true, dueDate: true,
              subject: { select: { name: true } },
            },
          }), [] as any[]),
      ]);

      const mappedEvents = events.map((e: any) => ({
        id: `event-${e.id}`, kind: "EVENT", category: e.eventType, title: e.title, description: e.description,
        color: e.color ?? "#6366F1", date: e.startDate, endDate: e.endDate,
        isAllDay: e.isAllDay, startTime: e.startTime, endTime: e.endTime,
      }));

      const mappedDeadlines = assignments.map((a: any) => ({
        id: `deadline-${a.id}`, kind: "DEADLINE", category: "DEADLINE",
        title: a.title, description: `${a.subject?.name ?? ""} · ${a.type}`,
        color: "#EF4444", date: a.dueDate, endDate: a.dueDate, isAllDay: true, startTime: null, endTime: null,
        linkedAssignmentId: a.id,
      }));

      const combined = [...mappedEvents, ...mappedDeadlines].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      );

      return reply.send({ success: true, data: { items: combined } });
    }
  );
}