import { prisma } from "./prisma.js";

/** Given a Student.id, returns the userId(s) of the parent(s) linked to
 *  that student — usually one, but a student can have more than one
 *  parent/guardian account linked. Returns [] if nothing's linked yet. */
export async function resolveParentUserIdsForStudent(studentId: number): Promise<number[]> {
  const student = await prisma.student.findUnique({ where: { id: studentId }, select: { userId: true } });
  if (!student) return [];

  const links = await prisma.parentStudent.findMany({
    where: { studentId: student.userId }, // ParentStudent.studentId points at the student's User.id, not Student.id
    select: { parentId: true },
  });
  return [...new Set(links.map((l) => l.parentId))];
}