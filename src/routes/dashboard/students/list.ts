// apps/api/src/routes/dashboard/students/list.ts
//
// REPLACES the existing students list.ts — same export name
// (studentsListRoutes) so index.ts registration stays unchanged.
//
// Access matrix:
//   CLASS TEACHER  (Class.classTeacherId = my staffId) → FULL access to that class
//   SUBJECT TEACHER (PeriodSlot.teacherId + classId)   → LIMITED view (no personal/health/parent data)
//   SYSTEM_ADMIN / FRONT_OFFICE                        → FULL access, all classes
//
// Real-time occupancy: enrolledCount = live Student count per class.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[students/list] "${label}" failed:`, err?.message ?? err); return fallback; }
}

const FULL_ACCESS_ROLES = ["SYSTEM_ADMIN", "FRONT_OFFICE"];

// ── Resolve this staff member's class-level access ────────────
// Returns { classTeacherOf: number[], subjectTeacherOf: number[], isAdmin: boolean }
async function getClassAccess(staffId: number | undefined, role: string, schoolId: number) {
  if (FULL_ACCESS_ROLES.includes(role)) {
    return { classTeacherOf: [] as number[], subjectTeacherOf: [] as number[], isAdmin: true };
  }
  if (!staffId) return { classTeacherOf: [], subjectTeacherOf: [], isAdmin: false };

  const [ownClasses, taughtSlots] = await Promise.all([
    safe("classTeacherOf", () =>
      prisma.class.findMany({
        where: { schoolId, classTeacherId: staffId, isActive: true },
        select: { id: true },
      }), [] as any[]),
    safe("subjectTeacherOf", () =>
      prisma.periodSlot.findMany({
        where: { teacherId: staffId, class: { schoolId, isActive: true } },
        select: { classId: true }, distinct: ["classId"],
      }), [] as any[]),
  ]);

  const classTeacherOf = ownClasses.map((c: any) => c.id);
  const subjectTeacherOf = taughtSlots
    .map((s: any) => s.classId)
    .filter((id: number) => !classTeacherOf.includes(id));

  return { classTeacherOf, subjectTeacherOf, isAdmin: false };
}

// Which access level does this user have for ONE class?
// "FULL" | "LIMITED" | null
async function accessLevelForClass(classId: number, staffId: number | undefined, role: string, schoolId: number) {
  const access = await getClassAccess(staffId, role, schoolId);
  if (access.isAdmin) return "FULL";
  if (access.classTeacherOf.includes(classId)) return "FULL";
  if (access.subjectTeacherOf.includes(classId)) return "LIMITED";
  return null;
}

export async function studentsListRoutes(app: FastifyInstance) {

  // ══════════════════════════════════════════════════════════
  // GET /students/classes — role-scoped class grid with live occupancy
  // ══════════════════════════════════════════════════════════
  app.get("/students/classes",
    { preHandler: [appAuth, requireCapability('students.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const { schoolId, role, staffId } = req as any;

        const access = await getClassAccess(staffId, role, schoolId);

        const whereClause = access.isAdmin
          ? { schoolId, isActive: true }
          : { schoolId, isActive: true, id: { in: [...access.classTeacherOf, ...access.subjectTeacherOf] } };

        const classes = await safe("classes fetch", () =>
          prisma.class.findMany({
            where: whereClause,
            select: {
              id: true, name: true, classNumber: true, section: true,
              room: true, shift: true, academicYear: true, capacity: true,
              classTeacher: { select: { user: { select: { name: true } } } },
              _count: { select: { students: { where: { isActive: true } } } },
            },
            orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          }), [] as any[]);

        const result = classes.map((c: any) => ({
          id: c.id,
          name: c.name,
          classNumber: c.classNumber,
          section: c.section,
          room: c.room,
          shift: c.shift,
          academicYear: c.academicYear,
          capacity: c.capacity,
          enrolledCount: c._count.students,               // ← real-time
          occupancyPct: c.capacity > 0 ? Math.round((c._count.students / c.capacity) * 100) : 0,
          classTeacherName: c.classTeacher?.user?.name ?? null,
          myAccess: access.isAdmin ? "FULL"
            : access.classTeacherOf.includes(c.id) ? "FULL"
            : "LIMITED",
          isMyClass: access.classTeacherOf.includes(c.id), // "Your Classes" section flag
        }));

        return reply.send({
          success: true,
          data: {
            classes: result,
            summary: {
              totalClasses: result.length,
              myClasses: result.filter((c) => c.isMyClass).length,
              totalStudents: result.reduce((s, c) => s + c.enrolledCount, 0),
            },
          },
        });
      } catch (err: any) {
        console.log("[students/classes] route error:", err?.message ?? err);
        return reply.status(500).send({ success: false, error: "INTERNAL_ERROR" });
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  // GET /students/classes/:classId/students — student list + today's attendance
  // ══════════════════════════════════════════════════════════
  app.get("/students/classes/:classId/students",
    { preHandler: [appAuth, requireCapability('students.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const { schoolId, role, staffId } = req as any;
        const classId = parseInt((req.params as any).classId);
        const { q } = req.query as { q?: string };

        const level = await accessLevelForClass(classId, staffId, role, schoolId);
        if (!level) return reply.status(403).send({ success: false, error: "NO_ACCESS", message: "You don't have access to this class." });

        const cls = await safe("class info", () =>
          prisma.class.findFirst({
            where: { id: classId, schoolId },
            select: { id: true, name: true, section: true, capacity: true,
              classTeacher: { select: { user: { select: { name: true } } } } },
          }), null);
        if (!cls) return reply.status(404).send({ success: false, error: "CLASS_NOT_FOUND" });

        const students = await safe("students fetch", () =>
          prisma.student.findMany({
            where: {
              classId, schoolId, isActive: true,
              ...(q ? { user: { name: { contains: q, mode: "insensitive" } } } : {}),
            },
            select: {
              id: true, userId: true, rollNumber: true, admissionNumber: true,
              studentStatus: true, houseAssignment: true,
              user: { select: { name: true, gender: true, avatarUrl: true } },
            },
            orderBy: { rollNumber: "asc" },
          }), [] as any[]);

        // Today's attendance status per student (single query)
        const now = new Date();
        const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const tomorrow = new Date(today.getTime() + 86400000);
        const todayAttendance = await safe("today attendance", () =>
          prisma.attendance.findMany({
            where: { classId, date: { gte: today, lt: tomorrow } },
            select: { studentId: true, status: true },
          }), [] as any[]);
        const attMap = new Map(todayAttendance.map((a: any) => [a.studentId, a.status]));

        return reply.send({
          success: true,
          data: {
            class: {
              id: cls.id, name: cls.name, section: cls.section,
              capacity: cls.capacity, enrolledCount: students.length,
              classTeacherName: cls.classTeacher?.user?.name ?? null,
            },
            accessLevel: level,
            students: students.map((s: any) => ({
              id: s.id,
              userId: s.userId,
              name: s.user.name,
              gender: s.user.gender,
              avatarUrl: s.user.avatarUrl,
              rollNumber: s.rollNumber,
              admissionNumber: s.admissionNumber,
              status: s.studentStatus,
              house: s.houseAssignment,
              todayStatus: attMap.get(s.id) ?? null,   // PRESENT/ABSENT/LATE/... or null (not marked)
            })),
          },
        });
      } catch (err: any) {
        console.log("[students/class-students] route error:", err?.message ?? err);
        return reply.status(500).send({ success: false, error: "INTERNAL_ERROR" });
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  // GET /students/:studentId — full profile, field-gated by access level
  // ══════════════════════════════════════════════════════════
  app.get("/students/:studentId",
    { preHandler: [appAuth, requireCapability('students.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const { schoolId, role, staffId } = req as any;
        const studentId = parseInt((req.params as any).studentId);

        const student = await safe("student core", () =>
          prisma.student.findFirst({
            where: { id: studentId, schoolId },
            include: {
              user: { select: { name: true, phone: true, email: true, gender: true, avatarUrl: true } },
              class: { select: { id: true, name: true, section: true } },
              parentDetail: true,
            },
          }), null);
        if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

        const level = await accessLevelForClass(student.classId, staffId, role, schoolId);
        if (!level) return reply.status(403).send({ success: false, error: "NO_ACCESS", message: "You don't have access to this student." });

        // ── Attendance summary — current month (both access levels get this) ──
        const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
        const attendance = await safe("attendance summary", async () => {
          const records = await prisma.attendance.findMany({
            where: { studentId, date: { gte: monthStart } },
            select: { status: true },
          });
          const total = records.length;
          const present = records.filter((r) => r.status === "PRESENT" || r.status === "HALF_DAY").length;
          const absent = records.filter((r) => r.status === "ABSENT").length;
          const late = records.filter((r) => r.status === "LATE").length;
          return { total, present, absent, late, pct: total > 0 ? Math.round((present / total) * 100) : null };
        }, { total: 0, present: 0, absent: 0, late: 0, pct: null as number | null });

        // ── Base payload (LIMITED = subject teacher view) ──────────
        const base = {
          id: student.id,
          name: student.user.name,
          gender: student.user.gender,
          avatarUrl: student.user.avatarUrl,
          rollNumber: student.rollNumber,
          admissionNumber: student.admissionNumber,
          class: student.class,
          status: student.studentStatus,
          house: student.houseAssignment,
          attendance,
          accessLevel: level,
        };

        if (level === "LIMITED") {
          return reply.send({ success: true, data: { student: base } });
        }

        // ── FULL payload (class teacher / admin / front office) ────
        // Recent behaviour records
        const behaviour = await safe("behaviour records", () =>
          prisma.behaviourRecord.findMany({
            where: { studentId },
            take: 5, orderBy: { incidentDate: "desc" },
            select: {
              id: true, type: true, severity: true, title: true,
              incidentDate: true, status: true,
            },
          }), [] as any[]);

        const pd: any = student.parentDetail;

        return reply.send({
          success: true,
          data: {
            student: {
              ...base,
              // Personal
              dob: student.dob,
              bloodGroup: student.bloodGroup,
              aadhaarNumber: student.aadhaarNumber,
              religion: student.religion,
              category: student.category,
              nationality: student.nationality,
              motherTongue: student.motherTongue,
              // Contact
              phone: student.user.phone,
              email: student.user.email,
              currentAddress: student.currentAddress,
              permanentAddress: student.permanentAddress,
              // Academic history
              admissionDate: student.admissionDate,
              admissionSource: student.admissionSource,
              previousSchool: student.previousSchool,
              previousClass: student.previousClass,
              previousPercent: student.previousPercent,
              // Health (best-effort — fields wrapped safely if missing)
              height: (student as any).height ?? null,
              weight: (student as any).weight ?? null,
              medicalConditions: (student as any).medicalConditions ?? null,
              allergies: (student as any).allergies ?? null,
              // Parent / Guardian
              parent: pd ? {
                fatherName: pd.fatherName, fatherPhone: pd.fatherPhone, fatherOccupation: pd.fatherOccupation,
                motherName: pd.motherName, motherPhone: pd.motherPhone, motherOccupation: pd.motherOccupation,
                guardianName: pd.guardianName, guardianPhone: pd.guardianPhone, guardianRelation: pd.guardianRelation,
                emergencyContactName: pd.emergencyContactName ?? null,
                emergencyContactPhone: pd.emergencyContactPhone ?? null,
              } : null,
              behaviour,
            },
          },
        });
      } catch (err: any) {
        console.log("[students/profile] route error:", err?.message ?? err);
        return reply.status(500).send({ success: false, error: "INTERNAL_ERROR" });
      }
    }
  );
}