// apps/api/src/routes/parent/dashboard.ts
//
// FIXED v3 — 3 confirmed bugs from actual Prisma errors:
//   1. ExamStatus enum has NO "UPCOMING"/"ONGOING" values — only
//      DRAFT | ACTIVE | COMPLETED | ARCHIVED | PUBLISHED (confirmed
//      earlier too). Fixed to filter by "ACTIVE" only.
//      (examConfig model name + examClasses relation name were BOTH
//      confirmed correct by this error — only the enum values were wrong.)
//   2. MarksEntry fields: marksObtained → obtainedMarks, totalMarks →
//      maxMarks (confirmed via Prisma's field list). Also, `examConfig`
//      is a DIRECT relation on MarksEntry (not nested via
//      examSubject.examClass.examConfig) — restructured to use it
//      directly. Subject name is now fetched via a SEPARATE query to
//      ExamSubject (a model already confirmed correct in the Marks
//      Entry module), avoiding a guess about MarksEntry's relation to
//      Subject, which isn't in its confirmed field list.
//   3. StudyAssignment has NO `status` field at all — only `isActive`
//      (boolean), confirmed via Prisma's field list. Fixed to filter
//      by isActive: true.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[parent/dashboard] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function verifyParentChild(parentUserId: number, studentRecordId: number, schoolId: number): Promise<boolean> {
  const student = await safe("verifyParentChild: student lookup", () =>
    prisma.student.findFirst({ where: { id: studentRecordId, schoolId }, select: { userId: true } }), null);
  if (!student) return false;
  const link = await safe("verifyParentChild: link lookup", () =>
    prisma.parentStudent.findFirst({ where: { parentId: parentUserId, studentId: student.userId } }), null);
  return !!link;
}

export async function parentDashboardRoutes(app: FastifyInstance) {

  app.get("/parent/dashboard",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { studentId } = req.query as { studentId: string };

      if (!studentId) return reply.status(400).send({ success: false, error: "STUDENT_ID_REQUIRED" });
      const sid = parseInt(studentId);

      if (!(await verifyParentChild(userId, sid, schoolId))) {
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });
      }

      const student = await safe("student fetch", () =>
        prisma.student.findFirst({
          where: { id: sid, schoolId },
          select: {
            id: true, admissionNumber: true, rollNumber: true,
            user: { select: { name: true, avatarUrl: true } },
            class: { select: { id: true, name: true, section: true } },
          },
        }), null);
      if (!student) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      const today      = new Date(); today.setHours(0, 0, 0, 0);
      const todayEnd    = new Date(); todayEnd.setHours(23, 59, 59, 999);
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

      const [
        monthAtt, todayAtt, pendingFee,
        upcomingExams, activeBooks, recentMarksRaw,
        pendingHw, announcements,
      ] = await Promise.all([
        safe("attendance.findMany (month)", () =>
          prisma.attendance.findMany({
            where: { studentId: sid, date: { gte: monthStart, lte: todayEnd } },
            select: { status: true },
          }), [] as any[]),

        safe("attendance.findFirst (today)", () =>
          prisma.attendance.findFirst({
            where: { studentId: sid, date: { gte: today, lte: todayEnd } },
            select: { status: true },
          }), null),

        safe("studentFeeInstallment.aggregate", () =>
          prisma.studentFeeInstallment.aggregate({
            where: { studentId: sid, status: { in: ["PENDING", "OVERDUE", "PARTIAL"] }, studentPlan: { isActive: true } },
            _sum: { dueAmount: true }, _count: true,
          }), { _sum: { dueAmount: 0 }, _count: 0 } as any),

        // FIX 1: ExamStatus has no UPCOMING/ONGOING — only ACTIVE
        safe("examConfig.findMany (upcoming)", () =>
          (prisma as any).examConfig.findMany({
            where: {
              schoolId, status: "ACTIVE",
              classes: { some: { classId: student.class?.id } },
            },
            take: 3, orderBy: { startDate: "asc" },
            select: { id: true, name: true, startDate: true, status: true },
          }), [] as any[]),

        safe("libIssue.count", () =>
          prisma.libIssue.count({ where: { studentId: sid, status: "ACTIVE" } }), 0),

        // FIX 2: obtainedMarks/maxMarks (not marksObtained/totalMarks),
        // examConfig is a DIRECT relation (not nested via examSubject.examClass)
        safe("marksEntry.findMany", () =>
          prisma.marksEntry.findMany({
            where: { studentId: sid }, take: 3, orderBy: { createdAt: "desc" },
            select: {
              obtainedMarks: true, maxMarks: true, examSubjectId: true,
              examConfig: { select: { name: true } },
            },
          }), [] as any[]),

        // FIX 3: StudyAssignment has no `status` field — only `isActive`
        safe("studyAssignment.count", () =>
          prisma.studyAssignment.count({
            where: { schoolId, classId: student.class?.id, isActive: true, dueDate: { gte: today } },
          }), 0),

        safe("commBroadcast.findMany", () =>
          prisma.commBroadcast.findMany({
            where: { schoolId, status: "SENT", audienceType: { in: ["ALL", "ALL_PARENTS"] } },
            take: 3, orderBy: { sentAt: "desc" },
            select: { id: true, title: true, content: true, sentAt: true },
          }), [] as any[]),
      ]);

      // ── Resolve subject names for recentMarks via a separate,
      // already-confirmed ExamSubject query (avoids guessing a
      // MarksEntry→Subject relation that isn't in its field list) ──
      const examSubjectIds = recentMarksRaw.map((m: any) => m.examSubjectId).filter(Boolean);
      const examSubjects = await safe("examSubject.findMany (names)", () =>
        (prisma as any).examSubject.findMany({
          where: { id: { in: examSubjectIds } },
          select: { id: true, subject: { select: { name: true } } },
        }), [] as any[]);
      const subjectNameMap = new Map(examSubjects.map((es: any) => [es.id, es.subject?.name ?? "—"]));

      const present = monthAtt.filter((a: any) => a.status === "PRESENT").length;
      const total   = monthAtt.length;
      const attPct  = total > 0 ? Math.round((present / total) * 100) : 0;

      return reply.send({
        success: true,
        data: {
          student: {
            id: student.id, name: student.user.name, avatarUrl: student.user.avatarUrl,
            admissionNo: student.admissionNumber, rollNumber: student.rollNumber,
            className: `${student.class?.name ?? ""} — ${student.class?.section ?? ""}`,
          },
          stats: {
            attendancePct: attPct, presentDays: present, totalDays: total,
            todayStatus: todayAtt?.status ?? "UNMARKED",
            pendingFeeAmt: pendingFee._sum.dueAmount ?? 0, pendingFeeCnt: pendingFee._count,
            activeBooks, pendingHomework: pendingHw,
          },
          upcomingExams: upcomingExams.map((e: any) => ({
            id: e.id, name: e.name, startDate: e.startDate, status: e.status,
            daysLeft: Math.ceil((new Date(e.startDate).getTime() - today.getTime()) / 86400000),
          })),
          recentMarks: recentMarksRaw.map((m: any) => ({
            subject: subjectNameMap.get(m.examSubjectId) ?? "—",
            exam: m.examConfig?.name ?? "—",
            obtained: m.obtainedMarks, total: m.maxMarks,
            pct: m.maxMarks > 0 ? Math.round((Number(m.obtainedMarks) / Number(m.maxMarks)) * 100) : 0,
          })),
          announcements: announcements.map((a: any) => {
            const c = typeof a.content === "object"
              ? (a.content as any)?.APP_NOTIFICATION?.body ?? (a.content as any)?.SMS?.body ?? ""
              : "";
            return { id: a.id, title: a.title, body: c, sentAt: a.sentAt };
          }),
        },
      });
    }
  );
}