// apps/api/src/routes/student/communication.ts
//
// Teacher Announcements — CommBroadcast filtered to this student's
// class + created by a TEACHER-role user (using the confirmed
// User.role field, avoiding any guess about CommAudienceType's full
// enum list).
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/communication] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function studentCommunicationRoutes(app: FastifyInstance) {

  app.get("/student/communication/announcements",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const student = await safe("student lookup", () =>
        prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { classId: true } }), null);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const broadcasts = await safe("teacher broadcasts", () =>
        prisma.commBroadcast.findMany({
          where: {
            schoolId, status: "SENT",
            targetClassIds: { has: student.classId },
            createdBy: { role: "TEACHER" },
          },
          orderBy: { sentAt: "desc" }, take: 30,
          select: {
            id: true, title: true, content: true, sentAt: true,
            createdBy: { select: { name: true } },
          },
        }), [] as any[]);

      return reply.send({
        success: true,
        data: {
          announcements: broadcasts.map((b: any) => {
            const body = typeof b.content === "object"
              ? (b.content as any)?.APP_NOTIFICATION?.body ?? (b.content as any)?.SMS?.body ?? "" : "";
            return { id: b.id, title: b.title, body, sentAt: b.sentAt, teacherName: b.createdBy?.name };
          }),
        },
      });
    }
  );
}