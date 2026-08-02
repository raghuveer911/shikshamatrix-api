// apps/api/src/routes/student/dashboard.ts
//
// v3 — added "Upcoming Events" using the confirmed SchoolEvent model.
// Not filtering by eventType (avoids guessing the enum's full value
// list — we don't need it since we want to show all event types).
//
// "Recent Messages" is intentionally NOT duplicated here — the
// frontend calls the existing, already-working /messages/inbox
// endpoint directly for that widget, reusing tested logic instead of
// re-guessing the messaging schema inside this route.
//
// Also includes useFocusEffect fix reminder (frontend) — see notes.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/dashboard] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function getStudent(userId: number, schoolId: number) {
  return safe("getStudent", () =>
    prisma.student.findFirst({
      where: { userId, schoolId, isActive: true },
      select: {
        id: true, admissionNumber: true, rollNumber: true, isActive: true,
        houseAssignment: true, photoUrl: true,
        class: {select: {
        id: true, name: true, section: true,
        academicYear: true,},},
        user: { select: { name: true, avatarUrl: true, phone: true, email: true } },
        school: { select: { name: true } },
      },
    }), null);
}

function todayDayNumber(): number {
  return new Date().getDay();
}

export async function studentDashboardRoutes(app: FastifyInstance) {

  app.get("/student/dashboard",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const student: any = await getStudent(userId, schoolId);
      if (!student) {
        return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });
      }

      const now        = new Date();
      const today       = new Date(); today.setHours(0, 0, 0, 0);
      const todayEnd    = new Date(); todayEnd.setHours(23, 59, 59, 999);
      const monthStart  = new Date(now.getFullYear(), now.getMonth(), 1);
      const todayDow    = todayDayNumber();
      const classId     = student.class?.id;

      const [
        monthAttendance, todayAttendance, pendingFee, nextFeeInstallment,
        upcomingExams, activeIssues, libraryIssuesDetail, recentMarksRaw,
        announcements, todayPeriods, pendingHomework, recentStudyMaterials,
        hostelAllocation, pendingDocsCount, totalDocsCount,
        schoolSettings, latestResult,
        upcomingEventsRaw,
      ] = await Promise.all([
        safe("attendance.findMany (month)", () =>
          prisma.attendance.findMany({
            where: { studentId: student.id, date: { gte: monthStart, lte: todayEnd } },
            select: { status: true },
          }), [] as any[]),

        safe("attendance.findFirst (today)", () =>
          prisma.attendance.findFirst({
            where: { studentId: student.id, date: { gte: today, lte: todayEnd } },
            select: { status: true },
          }), null),

        safe("studentFeeInstallment.aggregate", () =>
          prisma.studentFeeInstallment.aggregate({
            where: { studentId: student.id, status: { in: ["PENDING", "OVERDUE", "PARTIAL"] }, studentPlan: { isActive: true } },
            _sum: { dueAmount: true }, _count: true,
          }), { _sum: { dueAmount: 0 }, _count: 0 } as any),

        safe("nextFeeInstallment", () =>
          prisma.studentFeeInstallment.findFirst({
            where: { studentId: student.id, status: { in: ["PENDING", "OVERDUE", "PARTIAL"] }, studentPlan: { isActive: true } },
            orderBy: { dueDate: "asc" },
            select: { dueDate: true, dueAmount: true },
          }), null),

        safe("examConfig.findMany", () =>
          (prisma as any).examConfig.findMany({
            where: { schoolId, status: "ACTIVE", classes: { some: { classId } } },
            take: 3, orderBy: { startDate: "asc" },
            select: { id: true, name: true, startDate: true, endDate: true, status: true },
          }), [] as any[]),

        safe("libIssue.count", () =>
          prisma.libIssue.count({ where: { studentId: student.id, status: "ACTIVE" } }), 0),

        safe("libIssue.findMany", () =>
          prisma.libIssue.findMany({
            where: { studentId: student.id, status: "ACTIVE" },
            orderBy: { dueDate: "asc" }, take: 5,
            select: {
              dueDate: true,
              copy: { select: { book: { select: { title: true } } } },
              fine: { select: { totalAmount: true, status: true } },
            },
          }), [] as any[]),

        safe("marksEntry.findMany", () =>
          prisma.marksEntry.findMany({
            where: { studentId: student.id }, take: 5, orderBy: { createdAt: "desc" },
            select: {
              obtainedMarks: true, maxMarks: true, examSubjectId: true,
              examConfig: { select: { name: true } },
            },
          }), [] as any[]),

        safe("commBroadcast.findMany", () =>
          prisma.commBroadcast.findMany({
            where: { schoolId, status: "SENT", audienceType: { in: ["ALL", "ALL_STUDENTS"] } },
            take: 5, orderBy: { sentAt: "desc" },
            select: { id: true, title: true, content: true, sentAt: true },
          }), [] as any[]),

        safe("periodSlot.findMany", () =>
          prisma.periodSlot.findMany({
            where: { classId, dayOfWeek: todayDow },
            orderBy: { periodNumber: "asc" },
            select: {
              id: true, periodNumber: true, startTime: true, duration: true,
              subject: { select: { name: true } },
              teacher: { select: { user: { select: { name: true } } } },
            },
          }), [] as any[]),

        safe("studyAssignment.findMany", () =>
          prisma.studyAssignment.findMany({
            where: { schoolId, classId, isActive: true, dueDate: { gte: today } },
            orderBy: { dueDate: "asc" }, take: 5,
            select: {
              id: true, title: true, dueDate: true,
              subject: { select: { name: true } },
              submissions: { where: { studentId: student.id }, select: { id: true } },
            },
          }), [] as any[]),

        safe("studyMaterial.findMany", () =>
          prisma.studyMaterial.findMany({
            where: { schoolId, classId, isArchived: false },
            orderBy: { createdAt: "desc" }, take: 5,
            select: {
              id: true, title: true, mimeType: true, fileUrl: true, createdAt: true,
              subject: { select: { name: true } },
            },
          }), [] as any[]),

        safe("hostelAllocation.findFirst", () =>
          prisma.hostelAllocation.findFirst({
            where: { studentId: student.id, schoolId, status: "ACTIVE" },
            select: {
              hostel: { select: { name: true, warden: { select: { user: { select: { name: true } } } } } },
              room: { select: { roomNumber: true } },
            },
          }), null),

        safe("admissionDocument.count (pending)", () =>
          prisma.admissionDocument.count({ where: { studentId: student.id, status: "PENDING" } }), 0),
        safe("admissionDocument.count (total)", () =>
          prisma.admissionDocument.count({ where: { studentId: student.id } }), 0),

        safe("schoolSettings.findFirst", () =>
          prisma.schoolSettings.findFirst({ where: { schoolId }, select: { affiliationNo: true } }), null),

        safe("studentResult.findFirst", () =>
          prisma.studentResult.findFirst({
            where: { studentId: student.id },
            orderBy: { updatedAt: "desc" },
            select: { classRank: true, percentage: true },
          }), null),

        // NEW: Upcoming Events (SchoolEvent) — not filtering by
        // eventType (avoids guessing its full enum value list); shows
        // events for all classes OR specifically this student's class.
        safe("schoolEvent.findMany", () =>
          prisma.schoolEvent.findMany({
            where: {
              schoolId, endDate: { gte: today },
              OR: [{ forAllClasses: true }, { classIds: { has: classId } }],
            },
            orderBy: { startDate: "asc" }, take: 5,
            select: {
              id: true, title: true, eventType: true, color: true,
              startDate: true, endDate: true, isAllDay: true, startTime: true, endTime: true,
            },
          }), [] as any[]),
      ]);

      const examSubjectIds = recentMarksRaw.map((m: any) => m.examSubjectId).filter(Boolean);
      const examSubjects = await safe("examSubject.findMany (names)", () =>
        (prisma as any).examSubject.findMany({
          where: { id: { in: examSubjectIds } },
          select: { id: true, subject: { select: { name: true } } },
        }), [] as any[]);
      const subjectNameMap = new Map(examSubjects.map((es: any) => [es.id, es.subject?.name ?? "—"]));

      const present = monthAttendance.filter((a: any) => a.status === "PRESENT").length;
      const absent  = monthAttendance.filter((a: any) => a.status === "ABSENT").length;
      const late    = monthAttendance.filter((a: any) => a.status === "LATE").length;
      const total   = monthAttendance.length;
      const attPct  = total > 0 ? Math.round((present / total) * 100) : 0;
      const absPct  = total > 0 ? Math.round((absent  / total) * 100) : 0;
      const latePct = total > 0 ? Math.round((late    / total) * 100) : 0;

      const pendingHwFiltered = pendingHomework.filter((h: any) => h.submissions.length === 0);
      const libraryFineTotal = libraryIssuesDetail.reduce(
        (sum: number, i: any) => sum + Number(i.fine?.totalAmount ?? 0), 0
      );

      const addMinutes = (startTime: string | null, duration: number | null): string | null => {
        if (!startTime) return null;
        const m = startTime.match(/(\d{1,2}):(\d{2})/);
        if (!m) return null;
        const total = parseInt(m[1]) * 60 + parseInt(m[2]) + (duration ?? 0);
        const h = Math.floor(total / 60) % 24, min = total % 60;
        return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      };
      const periodsWithEnd = todayPeriods.map((p: any) => ({ ...p, endTime: addMinutes(p.startTime, p.duration) }));

      const nowHM = now.toTimeString().slice(0, 5);
      const currentPeriod = periodsWithEnd.find(
        (p: any) => p.startTime && p.endTime && p.startTime <= nowHM && nowHM <= p.endTime
      );

      const profileFields = [student.photoUrl, student.user.email, student.user.phone, student.houseAssignment];
      const filledCount = profileFields.filter(Boolean).length;
      const profileCompletionPct = Math.round((filledCount / profileFields.length) * 100);
      const hasDocumentsPending = pendingDocsCount > 0;

      const studentCode = `STD-${String(student.id).padStart(5, "0")}`;

      return reply.send({
        success: true,
        data: {
          student: {
            id: student.id, name: student.user.name,
            avatarUrl: student.photoUrl ?? student.user.avatarUrl,
            admissionNo: student.admissionNumber, studentCode, rollNumber: student.rollNumber,
            className: `${student.class?.name ?? ""}-${student.class?.section ?? ""}`,
            session: student.class?.academicYear ?? null,
            schoolName: student.school?.name ?? "",
            affiliationNo: schoolSettings?.affiliationNo ?? null,
            house: student.houseAssignment ?? null,
            isActive: student.isActive,
            isHosteller: !!hostelAllocation,
            isTransportUser: false,
            isClassMonitor: null,
          },
          profile: {
            completionPct: profileCompletionPct, documentsPending: hasDocumentsPending,
            pendingDocsCount, totalDocsCount,
          },
          stats: {
            attendancePct: attPct, presentDays: present, totalDays: total,
            todayStatus: todayAttendance?.status ?? "UNMARKED",
            pendingFeeAmt: pendingFee._sum.dueAmount ?? 0, pendingFeeCnt: pendingFee._count,
            nextFeeDueDate: nextFeeInstallment?.dueDate ?? null,
            nextFeeAmount: nextFeeInstallment?.dueAmount ?? 0,
            activeBooks: activeIssues, libraryFine: libraryFineTotal,
            pendingHomework: pendingHwFiltered.length, upcomingExamCount: upcomingExams.length,
          },
          attendanceBreakdown: { presentPct: attPct, absentPct: absPct, latePct },
          todayTimetable: periodsWithEnd.map((p: any) => ({
            id: p.id, periodNo: p.periodNumber, startTime: p.startTime, endTime: p.endTime,
            subject: p.subject?.name ?? "—", teacher: p.teacher?.user?.name ?? "—",
            isCurrent: currentPeriod?.id === p.id,
          })),
          currentPeriod: currentPeriod ? {
            subject: currentPeriod.subject?.name ?? "—",
            teacher: currentPeriod.teacher?.user?.name ?? "—",
            endTime: currentPeriod.endTime,
          } : null,
          upcomingExams: upcomingExams.map((e: any) => ({
            id: e.id, name: e.name, startDate: e.startDate, status: e.status,
            daysLeft: Math.ceil((new Date(e.startDate).getTime() - today.getTime()) / 86400000),
          })),
          pendingAssignments: pendingHwFiltered.map((h: any) => ({
            id: h.id, title: h.title, subject: h.subject?.name ?? "—", dueDate: h.dueDate,
            isDueTomorrow: h.dueDate
              ? new Date(h.dueDate).toDateString() === new Date(today.getTime() + 86400000).toDateString()
              : false,
            isOverdue: h.dueDate ? new Date(h.dueDate) < today : false,
          })),
          recentMarks: recentMarksRaw.map((m: any) => ({
            subject: subjectNameMap.get(m.examSubjectId) ?? "—",
            exam: m.examConfig?.name ?? "—",
            obtained: m.obtainedMarks, total: m.maxMarks,
            pct: m.maxMarks > 0 ? Math.round((Number(m.obtainedMarks) / Number(m.maxMarks)) * 100) : 0,
          })),
          performance: {
            classRank: latestResult?.classRank ?? null,
            avgPercent: latestResult?.percentage ? Number(latestResult.percentage) : null,
          },
          announcements: announcements.map((a: any) => {
            const content = typeof a.content === "object"
              ? (a.content as any)?.APP_NOTIFICATION?.body ?? (a.content as any)?.SMS?.body ?? "" : "";
            return { id: a.id, title: a.title, body: content, sentAt: a.sentAt };
          }),
          // NEW: Upcoming Events
          upcomingEvents: upcomingEventsRaw.map((e: any) => ({
            id: e.id, title: e.title, eventType: e.eventType, color: e.color,
            startDate: e.startDate, endDate: e.endDate, isAllDay: e.isAllDay,
            startTime: e.startTime, endTime: e.endTime,
            daysLeft: Math.ceil((new Date(e.startDate).getTime() - today.getTime()) / 86400000),
          })),
          studyMaterials: recentStudyMaterials.map((m: any) => ({
            id: m.id, title: m.title, fileType: m.mimeType, fileUrl: m.fileUrl,
            subject: m.subject?.name ?? "—", createdAt: m.createdAt,
          })),
          library: {
            activeCount: activeIssues, fine: libraryFineTotal,
            nextDueDate: libraryIssuesDetail[0]?.dueDate ?? null,
            items: libraryIssuesDetail.map((i: any) => ({
              title: i.copy.book.title, dueDate: i.dueDate, fine: i.fine?.totalAmount ?? 0,
            })),
          },
          transport: { enabled: false },
          hostel: hostelAllocation ? {
            enabled: true, hostelName: (hostelAllocation as any).hostel.name,
            roomNumber: (hostelAllocation as any).room?.roomNumber,
            wardenName: (hostelAllocation as any).hostel.warden?.user?.name,
          } : { enabled: false },
        },
      });
    }
  );
}