// apps/api/src/routes/parent/children.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

export async function parentChildrenRoutes(app: FastifyInstance) {

  app.get("/parent/children",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      // parentId = parent's User.id  |  studentId = student's User.id
      const links = await prisma.parentStudent.findMany({
        where: { parentId: userId },
        select: {
          relation: true,
          // "student" relation on ParentStudent → User (the student user)
          student: {
            select: {
              id:        true,
              name:      true,
              avatarUrl: true,
            },
          },
        },
      });

      // For each linked user, get the Student record
      const children = await Promise.all(
        links.map(async (l) => {
          const studentRecord = await prisma.student.findFirst({
            where:  { userId: l.student.id, schoolId },
            select: {
              id: true, admissionNumber: true, rollNumber: true, isActive: true,
              class: { select: { name: true, section: true } },
            },
          });

          if (!studentRecord?.isActive) return null;

          return {
            studentId:   studentRecord.id,
            userId:      l.student.id,
            name:        l.student.name,
            avatarUrl:   l.student.avatarUrl,
            admissionNo: studentRecord.admissionNumber,
            rollNumber:  studentRecord.rollNumber,
            className:   `${studentRecord.class?.name ?? ""} — ${studentRecord.class?.section ?? ""}`,
            relation:    l.relation,
          };
        })
      );

      return reply.send({
        success: true,
        data: { children: children.filter(Boolean) },
      });
    }
  );
}