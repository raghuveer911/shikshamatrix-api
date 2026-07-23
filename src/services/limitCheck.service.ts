// services/limitCheck.service.ts
// Call assertStudentLimitNotExceeded() at the top of your admission-creation route,
// before the Prisma transaction that creates the Student + User records.

import { prisma } from '../lib/prisma.js';

export class PlanLimitError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function assertStudentLimitNotExceeded(schoolId: number) {
  const sub = await prisma.schoolSubscription.findUnique({
    where: { schoolId },
    include: { plan: true },
  });

  if (!sub) throw new PlanLimitError('NO_SUBSCRIPTION', 'No active subscription found.');

  // maxStudents = 0 means unlimited (Enterprise tier)
  if (sub.plan.maxStudents === 0) return;

  const currentCount = await prisma.student.count({
    where: { schoolId, isActive: true },
  });

  if (currentCount >= sub.plan.maxStudents) {
    throw new PlanLimitError(
      'STUDENT_LIMIT_REACHED',
      `Your ${sub.plan.name} plan allows a maximum of ${sub.plan.maxStudents} students. Please upgrade to add more.`
    );
  }
}

export async function assertStaffLimitNotExceeded(schoolId: number) {
  const sub = await prisma.schoolSubscription.findUnique({
    where: { schoolId },
    include: { plan: true },
  });

  if (!sub) throw new PlanLimitError('NO_SUBSCRIPTION', 'No active subscription found.');
  if (sub.plan.maxStaff === 0) return;

  const currentCount = await prisma.staff.count({
    where: { schoolId, isActive: true },
  });

  if (currentCount >= sub.plan.maxStaff) {
    throw new PlanLimitError(
      'STAFF_LIMIT_REACHED',
      `Your ${sub.plan.name} plan allows a maximum of ${sub.plan.maxStaff} staff members. Please upgrade to add more.`
    );
  }
}

// Route usage example:
//
// fastify.post('/api/admissions', async (request, reply) => {
//   const { schoolId } = request.user as { schoolId: number };
//   try {
//     await assertStudentLimitNotExceeded(schoolId);
//   } catch (err) {
//     if (err instanceof PlanLimitError) {
//       return reply.code(403).send({ error: err.code, message: err.message });
//     }
//     throw err;
//   }
//   // ... proceed with admission creation transaction
// });
