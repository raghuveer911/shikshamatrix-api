/**
 * Shared helper — verify a parent owns a student
 *
 * ParentStudent schema:
 *   parentId  = User.id  (parent's user id)
 *   studentId = User.id  (student's user id)  ← NOT Student.id !
 *
 * So to verify:
 *   1. Find Student record where Student.id = studentId param AND schoolId matches
 *   2. Get that student's User id (Student.userId)
 *   3. Check ParentStudent where parentId = caller's userId AND studentId = student.userId
 */

import { prisma } from "../../lib/prisma.js";

export async function verifyParentChild(
  parentUserId: number,
  studentRecordId: number,   // this is Student.id from the query param
  schoolId: number
): Promise<boolean> {
  // Step 1: get the student's userId from the Student record
  const student = await prisma.student.findFirst({
    where: { id: studentRecordId, schoolId },
    select: { userId: true },
  }).catch(() => null);

  if (!student) return false;

  // Step 2: check link (studentId here = student's user id)
  const link = await prisma.parentStudent.findFirst({
    where: {
      parentId:  parentUserId,
      studentId: student.userId,
    },
  }).catch(() => null);

  return !!link;
}

/** Get the student's User.id from Student.id — for queries that need it */
export async function getStudentUserId(
  studentRecordId: number,
  schoolId: number
): Promise<number | null> {
  const s = await prisma.student.findFirst({
    where: { id: studentRecordId, schoolId },
    select: { userId: true },
  }).catch(() => null);
  return s?.userId ?? null;
}