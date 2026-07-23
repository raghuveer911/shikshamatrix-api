// apps/api/src/routes/dashboard/students/attendance.ts
//
// UPDATED: added class-level authorization — only the class's Class
// Teacher or SYSTEM_ADMIN/FRONT_OFFICE may mark/view-for-marking
// attendance. Reuses the already-confirmed Class.classTeacherId field
// (same pattern as the rest of the Students module) — no schema
// guessing, no new models/enums introduced.
//
// Everything else (upsert logic, summary calculation, response shape)
// is UNCHANGED from your existing working version.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { z } from "zod";

const FULL_ACCESS_ROLES = ["SYSTEM_ADMIN", "FRONT_OFFICE"];

const markSchema = z.object({
  classId: z.number(),
  date:    z.string(), // "YYYY-MM-DD"
  records: z.array(z.object({
    studentId: z.number(),
    status:    z.enum(["PRESENT", "ABSENT", "LATE", "HALF_DAY"]),
    remarks:   z.string().optional(),
  })),
});

// Only the class teacher of THIS class (or admin/front-office) can mark attendance for it.
async function canMarkAttendance(classId: number, schoolId: number, role: string, staffId: number | undefined): Promise<boolean> {
  if (FULL_ACCESS_ROLES.includes(role)) return true;
  if (!staffId) return false;
  try {
    const cls = await prisma.class.findFirst({ where: { id: classId, schoolId, classTeacherId: staffId } });
    return !!cls;
  } catch (err: any) {
    console.log("[students/attendance] canMarkAttendance check failed:", err?.message ?? err);
    return false;
  }
}

export async function studentsAttendanceRoutes(app: FastifyInstance) {

  // ── GET /students/attendance — Fetch for a class+date ──────
  app.get("/students/attendance",
    { preHandler: [appAuth, requireCapability('students.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, role, staffId } = req as any;
      const { classId, date } = req.query as Record<string, string>;

      if (!classId || !date) {
        return reply.status(400).send({ success: false, error: "classId and date required" });
      }

      const allowed = await canMarkAttendance(parseInt(classId), schoolId, role, staffId);
      if (!allowed) {
        return reply.status(403).send({ success: false, error: "NO_ACCESS", message: "Only this class's teacher or admin can mark attendance." });
      }

      const targetDate = new Date(date); // "YYYY-MM-DD" — parses as UTC midnight already
      const dayStart   = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate()));
      const dayEnd     = new Date(dayStart.getTime() + 86400000 - 1);

      // Fetch students of class
      const students = await prisma.student.findMany({
        where:   { schoolId, classId: parseInt(classId), isActive: true },
        orderBy: { rollNumber: "asc" },
        select: {
          id:        true,
          rollNumber: true,
          user:{select:{name:true,avatarUrl:true}},
          user: { select: { name: true } },
        },
      });

      // Fetch existing attendance
      const existing = await prisma.attendance.findMany({
        where: {
          schoolId,
          classId:   parseInt(classId),
          date:      { gte: dayStart, lte: dayEnd },
        },
        select: { studentId: true, status: true, remarks: true },
      });

      const attendanceMap = new Map(existing.map((a) => [a.studentId, a]));

      return reply.send({
        success: true,
        data: {
          date,
          alreadyMarked: existing.length > 0,
          students: students.map((s) => {
            const att = attendanceMap.get(s.id);
            return {
              id:         s.id,
              name:       s.user.name,
              rollNumber: s.rollNumber,
              avatarUrl:  s.user.avatarUrl,
              status:     att?.status   ?? null,
              remarks:    att?.remarks  ?? null,
            };
          }),
        },
      });
    }
  );

  // ── POST /students/attendance — Mark attendance ─────────────
  app.post("/students/attendance",
    { preHandler: [appAuth, requireCapability('students.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId, role, staffId } = req as any;

      const parsed = markSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.errors[0]?.message,
        });
      }

      const { classId, date, records } = parsed.data;

      const allowed = await canMarkAttendance(classId, schoolId, role, staffId);
      if (!allowed) {
        return reply.status(403).send({ success: false, error: "NO_ACCESS", message: "Only this class's teacher or admin can mark attendance." });
      }

      const targetDate  = new Date(date);

      // Upsert each record
      await Promise.all(
        records.map((r) =>
          prisma.attendance.upsert({
            where: {
              schoolId_studentId_classId_date: {
                schoolId,
                studentId: r.studentId,
                classId,
                date:      targetDate,
              },
            },
            update: {
              status:      r.status,
              remarks:     r.remarks ?? null,
              markedById:  userId,
            },
            create: {
              schoolId,
              studentId:   r.studentId,
              classId,
              date:        targetDate,
              status:      r.status,
              remarks:     r.remarks ?? null,
              markedById:  userId,
            },
          })
        )
      );

      return reply.send({
        success: true,
        message: `Attendance marked for ${records.length} students`,
      });
    }
  );

  // ── GET /students/:id/attendance — Student attendance history
  app.get("/students/:id/attendance",
    { preHandler: [appAuth, requireCapability('students.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id }       = req.params as { id: string };
      const { month, year } = req.query as Record<string, string>;

      const m = parseInt(month ?? new Date().getMonth() + 1 + "");
      const y = parseInt(year  ?? new Date().getFullYear() + "");

      const from = new Date(y, m - 1, 1);
      const to   = new Date(y, m, 0, 23, 59, 59);

      const records = await prisma.attendance.findMany({
        where: {
          schoolId,
          studentId: parseInt(id),
          date: { gte: from, lte: to },
        },
        orderBy: { date: "asc" },
        select:  { date: true, status: true, remarks: true },
      });

      const summary = {
        present:  records.filter((r) => r.status === "PRESENT").length,
        absent:   records.filter((r) => r.status === "ABSENT").length,
        late:     records.filter((r) => r.status === "LATE").length,
        halfDay:  records.filter((r) => r.status === "HALF_DAY").length,
        total:    records.length,
      };

      const percentage = summary.total > 0
        ? Math.round(((summary.present + summary.halfDay * 0.5) / summary.total) * 100)
        : 0;

      return reply.send({
        success: true,
        data: { records, summary, percentage },
      });
    }
  );
}