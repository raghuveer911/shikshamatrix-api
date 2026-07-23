import { prisma } from "../lib/prisma.js";

export interface AudienceInput {
  audienceType: string;
  targetClassIds?: number[];
  targetUserIds?: number[];
}

// NOTE: SECTION_WISE, TRANSPORT_ROUTE, HOSTEL, and FEE_DEFAULTERS aren't
// resolved yet — they currently return no recipients. These are
// straightforward student-list filters and can be added incrementally
// without touching this function's callers.
export async function resolveAudienceUserIds(schoolId: number, input: AudienceInput): Promise<number[]> {
  const { audienceType, targetClassIds, targetUserIds } = input;

  switch (audienceType) {
    case "ALL": {
      const [students, staff, parentIds] = await Promise.all([
        prisma.student.findMany({ where: { schoolId, isActive: true }, select: { userId: true } }),
        prisma.staff.findMany({ where: { schoolId, isActive: true }, select: { userId: true } }),
        resolveParentUserIds(schoolId),
      ]);
      return dedupe([...students.map((s) => s.userId), ...staff.map((s) => s.userId), ...parentIds]);
    }

    case "ALL_STUDENTS": {
      const students = await prisma.student.findMany({ where: { schoolId, isActive: true }, select: { userId: true } });
      return dedupe(students.map((s) => s.userId));
    }

    case "ALL_PARENTS": {
      return dedupe(await resolveParentUserIds(schoolId));
    }

    case "ALL_STAFF": {
      const staff = await prisma.staff.findMany({ where: { schoolId, isActive: true }, select: { userId: true } });
      return dedupe(staff.map((s) => s.userId));
    }

    case "ALL_TEACHERS": {
      const staff = await prisma.staff.findMany({
        where: { schoolId, isActive: true, user: { role: "TEACHER" } },
        select: { userId: true },
      });
      return dedupe(staff.map((s) => s.userId));
    }

    case "CLASS_WISE": {
      if (!targetClassIds?.length) return [];
      const students = await prisma.student.findMany({
        where: { schoolId, isActive: true, classId: { in: targetClassIds } },
        select: { userId: true },
      });
      return dedupe(students.map((s) => s.userId));
    }

    case "CUSTOM_SEGMENT": {
      // targetUserIds is the direct recipient list in this case (either a
      // hand-picked list, or already resolved from a saved CommAudienceSegment
      // by the caller before reaching here).
      return dedupe(targetUserIds ?? []);
    }

    // Not resolvable yet — see note above.
    case "SECTION_WISE":
    case "TRANSPORT_ROUTE":
    case "HOSTEL":
    case "FEE_DEFAULTERS":
    default:
      return [];
  }
}

// Resolves every parent-login account linked (via ParentStudent) to any
// active student in the school. Note: ParentStudent.studentId points at
// the STUDENT'S OWN User.id (not Student.id) — admission.ts links parents
// this way, and siblings correctly share one parent account by phone.
async function resolveParentUserIds(schoolId: number): Promise<number[]> {
  const students = await prisma.student.findMany({ where: { schoolId, isActive: true }, select: { userId: true } });
  const studentUserIds = students.map((s) => s.userId);
  if (studentUserIds.length === 0) return [];

  const links = await prisma.parentStudent.findMany({
    where: { studentId: { in: studentUserIds } },
    select: { parentId: true },
  });
  return dedupe(links.map((l) => l.parentId));
}

function dedupe(ids: number[]): number[] {
  return [...new Set(ids)];
}
