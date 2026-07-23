// apps/api/src/routes/dashboard/messages/permissions.ts
//
// UPDATED MATRIX (v3) — replaces the old scoped-parent logic:
//   PARENT  ↔ ANY STAFF role: unscoped (parent can message any staff member)
//   STUDENT ↔ STAFF: scoped —
//     - TEACHER: only their own class's teachers (unchanged)
//     - LIBRARIAN: only if student has an active LibMembership
//     - HOSTEL_WARDEN: only if student is an active hostel resident (unchanged)
//     - TRANSPORT_MANAGER ("driver"): only if student is on that route
//       (⚠️ best-effort — student↔route model still unconfirmed, defaults deny)
//     - FRONT_OFFICE / ACCOUNTANT / HR_EXECUTIVE / INVENTORY_MANAGER /
//       EXAM_COORDINATOR: NOT reachable by students (not mentioned in the
//       new spec — kept restricted; tell me if students should reach these too)
//   Staff ↔ Staff: unchanged, open
//   SYSTEM_ADMIN: unchanged, unscoped both directions
//
import { prisma } from "../../../lib/prisma.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[messages/permissions] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export const STAFF_ROLES = [
  "SYSTEM_ADMIN","TEACHER","FRONT_OFFICE","ACCOUNTANT","HR_EXECUTIVE",
  "LIBRARIAN","INVENTORY_MANAGER","HOSTEL_WARDEN","TRANSPORT_MANAGER","EXAM_COORDINATOR",
];

// Staff roles a STUDENT can reach, subject to the scoping check for each.
const STUDENT_SCOPED_ROLES = ["TEACHER", "LIBRARIAN", "HOSTEL_WARDEN", "TRANSPORT_MANAGER"];

async function getStudentContext(userId: number, schoolId: number) {
  return safe("getStudentContext", () =>
    prisma.student.findFirst({ where: { userId, schoolId }, select: { id: true, classId: true } }), null);
}

async function isTeacherOfClass(staffId: number, classId: number | null): Promise<boolean> {
  if (!classId) return false;
  return safe("isTeacherOfClass", async () => {
    const viaSubject = await prisma.periodSlot.findFirst({ where: { teacherId: staffId, classId } });
    if (viaSubject) return true;
    const viaClassTeacher = await (prisma as any).class.findFirst({ where: { id: classId, classTeacherId: staffId } }).catch(() => null);
    return !!viaClassTeacher;
  }, false);
}

async function isWardenOfStudent(staffId: number, studentId: number | null): Promise<boolean> {
  if (!studentId) return false;
  return safe("isWardenOfStudent", async () => {
    const allocation = await prisma.hostelAllocation.findFirst({
      where: { studentId, status: "ACTIVE", hostel: { wardenId: staffId } },
    });
    return !!allocation;
  }, false);
}

async function isLibrarianForStudent(staffId: number, studentId: number | null, schoolId: number): Promise<boolean> {
  if (!studentId) return false;
  return safe("isLibrarianForStudent", async () => {
    // Any active library member can reach any librarian on staff —
    // library staff typically operate school-wide, not per-membership-assigned.
    const membership = await (prisma as any).libMembership?.findFirst?.({
      where: { studentId, isActive: true },
    });
    if (!membership) return false;
    const librarian = await prisma.staff.findFirst({ where: { id: staffId, user: { role: "LIBRARIAN" } } });
    return !!librarian;
  }, false);
}

// ⚠️ Best-effort — student↔route assignment model still unconfirmed.
async function isTransportManagerOfStudent(staffId: number, studentId: number | null, schoolId: number): Promise<boolean> {
  if (!studentId) return false;
  return safe("isTransportManagerOfStudent", async () => {
    const stop = await (prisma as any).transportStop?.findFirst?.({
      where: { route: { schoolId, managerId: staffId }, studentAssignments: { some: { studentId } } },
    });
    return !!stop;
  }, false);
}

async function checkStudentStaff(staffRole: string, staffUserId: number, studentUserId: number, schoolId: number): Promise<boolean> {
  if (!STUDENT_SCOPED_ROLES.includes(staffRole)) return false;

  const staff = await safe("staff lookup (student check)", () =>
    prisma.staff.findFirst({ where: { userId: staffUserId, schoolId }, select: { id: true } }), null);
  if (!staff) return false;

  const student = await getStudentContext(studentUserId, schoolId);
  if (!student) return false;

  if (staffRole === "TEACHER")           return isTeacherOfClass(staff.id, student.classId);
  if (staffRole === "HOSTEL_WARDEN")     return isWardenOfStudent(staff.id, student.id);
  if (staffRole === "LIBRARIAN")         return isLibrarianForStudent(staff.id, student.id, schoolId);
  if (staffRole === "TRANSPORT_MANAGER") return isTransportManagerOfStudent(staff.id, student.id, schoolId);
  return false;
}

// ════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ════════════════════════════════════════════════════════════
export async function canMessage(opts: {
  senderId: number; senderRole: string; schoolId: number;
  receiverId: number; receiverRole: string;
}): Promise<boolean> {
  const { senderId, senderRole, schoolId, receiverId, receiverRole } = opts;

  if (senderId === receiverId) return false;
  if (senderRole === "SYSTEM_ADMIN" || receiverRole === "SYSTEM_ADMIN") return true;

  const senderIsStaff   = STAFF_ROLES.includes(senderRole);
  const receiverIsStaff = STAFF_ROLES.includes(receiverRole);

  // Staff <-> Staff — open
  if (senderIsStaff && receiverIsStaff) return true;

  // PARENT <-> Staff — now UNSCOPED (any staff member reachable)
  if (senderRole === "PARENT" && receiverIsStaff) return true;
  if (senderIsStaff && receiverRole === "PARENT") return true;

  // STUDENT <-> Staff — scoped by actual involvement
  if (senderRole === "STUDENT" && receiverIsStaff)
    return checkStudentStaff(receiverRole, receiverId, senderId, schoolId);
  if (senderIsStaff && receiverRole === "STUDENT")
    return checkStudentStaff(senderRole, senderId, receiverId, schoolId);

  // Student <-> Student, Parent <-> Parent, Student <-> Parent: denied by design
  return false;
}

// ════════════════════════════════════════════════════════════
// CONTACT LIST
// ════════════════════════════════════════════════════════════
export async function getAllowedContacts(
  userId: number, role: string, schoolId: number, search?: string
) {
  const searchFilter = search ? { name: { contains: search, mode: "insensitive" as const } } : {};
  const contacts: { userId: number; name: string; role: string; subtitle: string }[] = [];
  const seen = new Set<number>();
  const push = (u: { id: number; name: string; role: string }, subtitle: string) => {
    if (seen.has(u.id) || u.id === userId) return;
    seen.add(u.id); contacts.push({ userId: u.id, name: u.name, role: u.role, subtitle });
  };

  // ── SYSTEM_ADMIN: everyone ──
  if (role === "SYSTEM_ADMIN") {
    const all = await safe("admin: all users", () =>
      prisma.user.findMany({
        where: { schoolId, isActive: true, id: { not: userId }, ...searchFilter },
        select: { id: true, name: true, role: true }, take: 40,
      }), [] as any[]);
    all.forEach((u) => push(u, u.role.replace(/_/g, " ")));
    return contacts;
  }

  // ── Any staff role: all other staff (open) ──
  if (STAFF_ROLES.includes(role)) {
    const staffUsers = await safe("staff: all staff members", () =>
      prisma.user.findMany({
        where: { schoolId, isActive: true, id: { not: userId }, role: { in: STAFF_ROLES }, ...searchFilter },
        select: { id: true, name: true, role: true,
          staffMember: { select: { departmentRef: { select: { name: true } }, designationRef: { select: { name: true } } } } },
        take: 30,
      }), [] as any[]);
    staffUsers.forEach((u: any) => push(u, u.staffMember?.designationRef?.name ?? u.role.replace(/_/g, " ")));

    // Any staff can now reach any parent (unscoped) — same policy as Parent→Staff
    const parents = await safe("staff: all parents (unscoped)", () =>
      prisma.user.findMany({
        where: { schoolId, isActive: true, role: "PARENT", ...searchFilter },
        select: { id: true, name: true, role: true }, take: 30,
      }), [] as any[]);
    parents.forEach((p) => push(p, "Parent"));

    // Scoped student access, per role (TEACHER/LIBRARIAN/HOSTEL_WARDEN/TRANSPORT_MANAGER)
    const staffRecord = await safe("staff record", () =>
      prisma.staff.findFirst({ where: { userId, schoolId }, select: { id: true } }), null);

    if (staffRecord) {
      if (role === "TEACHER") {
        const classIds = await safe("teacher's classes", () =>
          prisma.periodSlot.findMany({ where: { teacherId: staffRecord.id }, select: { classId: true }, distinct: ["classId"] }), [] as any[]);
        const ids = classIds.map((c: any) => c.classId);
        if (ids.length > 0) {
          const students = await safe("teacher's students", () =>
            prisma.student.findMany({
              where: { classId: { in: ids }, isActive: true },
              select: { class: { select: { name: true, section: true } }, user: { select: { id: true, name: true, role: true } } },
              take: 40,
            }), [] as any[]);
          students.forEach((s: any) => push(s.user, `Student · ${s.class?.name}-${s.class?.section}`));
        }
      }

      if (role === "HOSTEL_WARDEN") {
        const residents = await safe("warden's residents", () =>
          prisma.hostelAllocation.findMany({
            where: { status: "ACTIVE", hostel: { wardenId: staffRecord.id } },
            select: { student: { select: { user: { select: { id: true, name: true, role: true } } } } },
          }), [] as any[]);
        residents.forEach((r: any) => push(r.student.user, "Hostel Resident"));
      }

      if (role === "LIBRARIAN") {
        const members = await safe("librarian's members", () =>
          (prisma as any).libMembership?.findMany?.({
            where: { isActive: true, student: { schoolId } },
            select: { student: { select: { user: { select: { id: true, name: true, role: true } } } } },
          }), [] as any[]);
        (members ?? []).forEach((m: any) => push(m.student.user, "Library Member"));
      }

      if (role === "TRANSPORT_MANAGER") {
        const routeStudents = await safe("transport manager's route students", async () => {
          const stops = await (prisma as any).transportStop?.findMany?.({
            where: { route: { schoolId, managerId: staffRecord.id } },
            select: { studentAssignments: { select: { studentId: true } } },
          });
          const studentIds = (stops ?? []).flatMap((s: any) => (s.studentAssignments ?? []).map((a: any) => a.studentId));
          if (studentIds.length === 0) return [];
          return prisma.student.findMany({
            where: { id: { in: studentIds } },
            select: { user: { select: { id: true, name: true, role: true } } },
          });
        }, [] as any[]);
        routeStudents.forEach((s: any) => push(s.user, "On Route"));
      }
    }

    return contacts;
  }

  // ── STUDENT: teacher(s) + librarian (if member) + warden (if resident) + transport manager (if on route) ──
  if (role === "STUDENT") {
    const student = await getStudentContext(userId, schoolId);

    if (student?.classId) {
      const teacherIds = await safe("student's teachers", () =>
        prisma.periodSlot.findMany({ where: { classId: student.classId }, select: { teacherId: true }, distinct: ["teacherId"] }), [] as any[]);
      const ids = teacherIds.map((t: any) => t.teacherId).filter(Boolean);
      if (ids.length > 0) {
        const teachers = await safe("student's teachers detail", () =>
          prisma.staff.findMany({
            where: { id: { in: ids } },
            select: { user: { select: { id: true, name: true, role: true } }, designationRef: { select: { name: true } } },
          }), [] as any[]);
        teachers.forEach((t: any) => push(t.user, t.designationRef?.name ?? "Teacher"));
      }
    }

    if (student) {
      const allocation = await safe("student's hostel", () =>
        prisma.hostelAllocation.findFirst({
          where: { studentId: student.id, status: "ACTIVE" },
          select: { hostel: { select: { warden: { select: { user: { select: { id: true, name: true, role: true } } } } } } },
        }), null);
      if (allocation?.hostel?.warden?.user) push(allocation.hostel.warden.user, "Hostel Warden");

      const libMembership = await safe("student's library membership", () =>
        (prisma as any).libMembership?.findFirst?.({ where: { studentId: student.id, isActive: true } }), null);
      if (libMembership) {
        const librarians = await safe("librarians", () =>
          prisma.user.findMany({ where: { schoolId, role: "LIBRARIAN", isActive: true }, select: { id: true, name: true, role: true } }), [] as any[]);
        librarians.forEach((l) => push(l, "Librarian"));
      }

      const transportInfo = await safe("student's transport route", async () => {
        const stop = await (prisma as any).transportStop?.findFirst?.({
          where: { studentAssignments: { some: { studentId: student.id } } },
          select: { route: { select: { managerId: true } } },
        });
        return stop?.route?.managerId ?? null;
      }, null);
      if (transportInfo) {
        const manager = await safe("transport manager", () =>
          prisma.staff.findFirst({ where: { id: transportInfo }, select: { user: { select: { id: true, name: true, role: true } } } }), null);
        if (manager?.user) push(manager.user, "Transport Manager");
      }
    }

    return contacts;
  }

  // ── PARENT: ALL staff, unscoped ──
  if (role === "PARENT") {
    const allStaff = await safe("parent: all staff (unscoped)", () =>
      prisma.user.findMany({
        where: { schoolId, isActive: true, role: { in: STAFF_ROLES }, ...searchFilter },
        select: { id: true, name: true, role: true,
          staffMember: { select: { departmentRef: { select: { name: true } }, designationRef: { select: { name: true } } } } },
        take: 40,
      }), [] as any[]);
    allStaff.forEach((u: any) => push(u, u.staffMember?.designationRef?.name ?? u.role.replace(/_/g, " ")));
    return contacts;
  }

  return contacts;
}