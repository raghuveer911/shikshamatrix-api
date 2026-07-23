import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

export async function adminStudentAttendanceRoutes(app: FastifyInstance) {

  // ── GET /admin/attendance/classes ─────────────────────────
  // Classes for selector (with section info)
  app.get("/admin/attendance/classes",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const currentYear = await prisma.academicYear.findFirst({
        where: { schoolId, isCurrent: true },
      });

      const classes = await prisma.class.findMany({
        where: { schoolId, isActive: true, ...(currentYear ? { academicYear: currentYear.name } : {}) },
        orderBy: [{ classNumber: "asc" }, { section: "asc" }],
        select: {
          id: true, name: true, classNumber: true, section: true, academicYear: true,
          _count: { select: { students: { where: { isActive: true } } } },
        },
      });

      return reply.send({ success: true, data: { classes } });
    }
  );

  // ── GET /admin/attendance/students ────────────────────────
  // Students for a class with attendance status for a date
  app.get("/admin/attendance/students",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { classId: string; date: string; search?: string };

      if (!q.classId) return reply.status(400).send({ success: false, message: "classId required." });

      const date = q.date ? new Date(q.date) : new Date();
      date.setHours(0, 0, 0, 0);
      const dateEnd = new Date(date);
      dateEnd.setHours(23, 59, 59, 999);

      const cls = await prisma.class.findFirst({
        where: { id: parseInt(q.classId), schoolId },
      });
      if (!cls) return reply.status(404).send({ success: false, message: "Class not found." });

      // Fetch students
      const students = await prisma.student.findMany({
        where: {
          schoolId,
          classId: parseInt(q.classId),
          isActive: true,
          ...(q.search ? {
            OR: [
              { user: { name: { contains: q.search, mode: "insensitive" } } },
              { rollNumber: { contains: q.search } },
              { admissionNumber: { contains: q.search } },
            ],
          } : {}),
        },
        orderBy: { rollNumber: "asc" },
        include: {
          user: { select: { id: true, name: true, gender: true, avatarUrl: true } },
          parentDetail: { select: { fatherName: true, fatherPhone: true } },
        },
      });

      // Fetch existing attendance for this date
      const existing = await prisma.attendance.findMany({
        where: {
          schoolId,
          classId: parseInt(q.classId),
          date: { gte: date, lte: dateEnd },
        },
        include: {
          markedBy: { select: { name: true } },
        },
      });

      const attendanceMap: Record<number, typeof existing[0]> = {};
      existing.forEach(a => { attendanceMap[a.studentId] = a; });

      const isAlreadyTaken = existing.length > 0;

      // Check approved leaves for today
      const approvedLeaves = await prisma.leaveRequest.findMany({
        where: {
          schoolId,
          status: "APPROVED",
          studentUserId: { in: students.map(s => s.userId) },
          fromDate: { lte: dateEnd },
          toDate: { gte: date },
        },
        select: { studentUserId: true, leaveType: true },
      });
      const leaveUserIds = new Set(approvedLeaves.map(l => l.studentUserId));

      // Consecutive absent days check (last 7 days)
      const weekAgo = new Date(date);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const recentAbsences = await prisma.attendance.groupBy({
        by: ["studentId"],
        where: {
          schoolId,
          classId: parseInt(q.classId),
          status: "ABSENT",
          date: { gte: weekAgo, lte: date },
        },
        _count: true,
      });
      const consecutiveAbsences: Record<number, number> = {};
      recentAbsences.forEach(a => { consecutiveAbsences[a.studentId] = a._count; });

      const studentsWithAttendance = students.map(s => ({
        id: s.id,
        userId: s.userId,
        rollNumber: s.rollNumber,
        admissionNumber: s.admissionNumber,
        user: s.user,
        fatherName: s.parentDetail?.fatherName ?? "—",
        fatherPhone: s.parentDetail?.fatherPhone ?? "—",
        attendance: attendanceMap[s.id] ? {
          id: attendanceMap[s.id].id,
          status: attendanceMap[s.id].status,
          remarks: attendanceMap[s.id].remarks,
          markedBy: attendanceMap[s.id].markedBy?.name ?? "—",
        } : null,
        hasApprovedLeave: leaveUserIds.has(s.userId),
        consecutiveAbsences: consecutiveAbsences[s.id] ?? 0,
      }));

      // Summary
      const summary = {
        total: students.length,
        present: existing.filter(a => a.status === "PRESENT").length,
        absent: existing.filter(a => a.status === "ABSENT").length,
        late: existing.filter(a => a.status === "LATE").length,
        halfDay: existing.filter(a => a.status === "HALF_DAY").length,
        leave: existing.filter(a => a.status === "HOLIDAY").length,
      };

      return reply.send({
        success: true,
        data: {
          students: studentsWithAttendance,
          class: cls,
          date: date.toISOString().split("T")[0],
          isAlreadyTaken,
          summary,
        },
      });
    }
  );

  // ── POST /admin/attendance/submit ─────────────────────────
  // Submit full class attendance (bulk upsert)
  app.post("/admin/attendance/submit",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        classId: number;
        date: string;
        attendance: {
          studentId: number;
          status: "PRESENT" | "ABSENT" | "LATE" | "HALF_DAY" | "HOLIDAY";
          remarks?: string;
        }[];
      };

      if (!body.classId || !body.date || !body.attendance?.length) {
        return reply.status(400).send({ success: false, message: "classId, date, and attendance required." });
      }

      const date = new Date(body.date);
      date.setHours(0, 0, 0, 0);

      const cls = await prisma.class.findFirst({ where: { id: body.classId, schoolId } });
      if (!cls) return reply.status(404).send({ success: false, message: "Class not found." });

      // Bulk upsert in transaction
      const results = await prisma.$transaction(
        body.attendance.map(a =>
          prisma.attendance.upsert({
            where: { studentId_date: { studentId: a.studentId, date } },
            create: {
              schoolId,
              studentId: a.studentId,
              classId: body.classId,
              markedById: userId,
              date,
              status: a.status,
              remarks: a.remarks ?? null,
            },
            update: {
              status: a.status,
              remarks: a.remarks ?? null,
              markedById: userId,
            },
          })
        )
      );

      const summary = {
        total: results.length,
        present: results.filter(r => r.status === "PRESENT").length,
        absent: results.filter(r => r.status === "ABSENT").length,
        late: results.filter(r => r.status === "LATE").length,
        halfDay: results.filter(r => r.status === "HALF_DAY").length,
      };

      return reply.send({
        success: true,
        message: `Attendance saved for ${results.length} students.`,
        data: { summary },
      });
    }
  );

  // ── GET /admin/attendance/summary ────────────────────────
  // Monthly/weekly summary for a class
  app.get("/admin/attendance/summary",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { classId?: string; month?: string; year?: string };

      const year = parseInt(q.year ?? String(new Date().getFullYear()));
      const month = parseInt(q.month ?? String(new Date().getMonth() + 1));

      const monthStart = new Date(year, month - 1, 1);
      const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);

      const where: any = {
        schoolId,
        date: { gte: monthStart, lte: monthEnd },
        ...(q.classId ? { classId: parseInt(q.classId) } : {}),
      };

      // Daily attendance counts
      const dailyData = await prisma.attendance.groupBy({
        by: ["date", "status"],
        where,
        _count: true,
        orderBy: { date: "asc" },
      });

      // Build calendar data
      const calendarMap: Record<string, Record<string, number>> = {};
      dailyData.forEach(d => {
        const dateStr = d.date.toISOString().split("T")[0];
        if (!calendarMap[dateStr]) calendarMap[dateStr] = {};
        calendarMap[dateStr][d.status] = d._count;
      });

      // Overall stats
      const [totalPresent, totalAbsent, totalLate] = await Promise.all([
        prisma.attendance.count({ where: { ...where, status: "PRESENT" } }),
        prisma.attendance.count({ where: { ...where, status: "ABSENT" } }),
        prisma.attendance.count({ where: { ...where, status: "LATE" } }),
      ]);

      const total = totalPresent + totalAbsent + totalLate;
      const attendanceRate = total > 0 ? Math.round((totalPresent / total) * 100) : 0;

      return reply.send({
        success: true,
        data: {
          calendarMap,
          stats: { totalPresent, totalAbsent, totalLate, total, attendanceRate },
          month, year,
        },
      });
    }
  );

  // ── GET /admin/attendance/today ───────────────────────────
  // Today's attendance status across all classes
  app.get("/admin/attendance/today",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayEnd = new Date(today);
      todayEnd.setHours(23, 59, 59, 999);

      const classes = await prisma.class.findMany({
        where: { schoolId, isActive: true },
        select: { id: true, name: true, _count: { select: { students: { where: { isActive: true } } } } },
        orderBy: [{ classNumber: "asc" }, { section: "asc" }],
      });

      const classStatus = await Promise.all(classes.map(async cls => {
        const taken = await prisma.attendance.count({
          where: { schoolId, classId: cls.id, date: { gte: today, lte: todayEnd } },
        });
        return {
          id: cls.id,
          name: cls.name,
          totalStudents: cls._count.students,
          attendanceTaken: taken > 0,
          markedCount: taken,
        };
      }));

      const [totalStudents, totalPresent, totalAbsent] = await Promise.all([
        prisma.student.count({ where: { schoolId, isActive: true } }),
        prisma.attendance.count({ where: { schoolId, date: { gte: today, lte: todayEnd }, status: "PRESENT" } }),
        prisma.attendance.count({ where: { schoolId, date: { gte: today, lte: todayEnd }, status: "ABSENT" } }),
      ]);

      return reply.send({
        success: true,
        data: {
          classStatus,
          overall: {
            totalStudents, totalPresent, totalAbsent,
            rate: totalStudents > 0 ? Math.round((totalPresent / totalStudents) * 100) : 0,
          },
        },
      });
    }
  );

  // ── GET /admin/attendance/student/:studentId ──────────────
  // Individual student attendance history
  app.get("/admin/attendance/student/:studentId",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { studentId } = request.params as { studentId: string };
      const q = request.query as { month?: string; year?: string };

      const year = parseInt(q.year ?? String(new Date().getFullYear()));
      const month = parseInt(q.month ?? String(new Date().getMonth() + 1));
      const monthStart = new Date(year, month - 1, 1);
      const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);

      const records = await prisma.attendance.findMany({
        where: {
          schoolId,
          studentId: parseInt(studentId),
          date: { gte: monthStart, lte: monthEnd },
        },
        orderBy: { date: "desc" },
        include: { markedBy: { select: { name: true } } },
      });

      const stats = {
        present: records.filter(r => r.status === "PRESENT").length,
        absent: records.filter(r => r.status === "ABSENT").length,
        late: records.filter(r => r.status === "LATE").length,
        halfDay: records.filter(r => r.status === "HALF_DAY").length,
        total: records.length,
      };

      return reply.send({ success: true, data: { records, stats } });
    }
  );
}