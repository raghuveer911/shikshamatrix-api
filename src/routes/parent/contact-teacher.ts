// apps/api/src/routes/parent/contact-teacher.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function verifyParentChild(
  parentUserId: number, studentRecordId: number, schoolId: number
): Promise<boolean> {
  const student = await prisma.student.findFirst({
    where: { id: studentRecordId, schoolId }, select: { userId: true },
  }).catch(() => null);
  if (!student) return false;
  const link = await prisma.parentStudent.findFirst({
    where: { parentId: parentUserId, studentId: student.userId },
  }).catch(() => null);
  return !!link;
}

export async function parentContactTeacherRoutes(app: FastifyInstance) {

  app.get("/parent/contact-teacher/list",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { studentId } = req.query as { studentId: string };
      const sid = parseInt(studentId);

      if (!(await verifyParentChild(userId, sid, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      const student = await prisma.student.findFirst({
        where: { id: sid, schoolId },
        select: { class: { select: { id: true } } },
      });

      const slots = await prisma.periodSlot.findMany({
        where: { classId: student?.class?.id, isActive: true },
        select: {
          subject: { select: { name: true } },
          teacher: { select: { id: true, user: { select: { id: true, name: true } } } },
        },
        distinct: ["teacherId"],
      }).catch(() => []);

      const teachers = slots
        .filter(s => s.teacher?.user)
        .map(s => ({
          userId:  s.teacher!.user.id,
          name:    s.teacher!.user.name,
          subject: s.subject?.name,
          role:    "SUBJECT_TEACHER",
        }));

      return reply.send({ success: true, data: { teachers } });
    }
  );
}