// apps/api/src/routes/student/academics-materials.ts
//
// Study Materials + Notes — both use the SAME StudyMaterial model.
// "Notes" is just a filtered view (type: "NOTES", a confirmed enum
// value) — not a separate model.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/academics-materials] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function getStudentContext(userId: number, schoolId: number) {
  return safe("student lookup", () =>
    prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true, classId: true } }), null);
}

export async function studentAcademicsMaterialsRoutes(app: FastifyInstance) {

  // ── GET /student/academics/materials?subjectId= ─────────────
  app.get("/student/academics/materials",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { subjectId } = req.query as { subjectId?: string };

      const student = await getStudentContext(userId, schoolId);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const materials = await safe("materials", () =>
        prisma.studyMaterial.findMany({
          where: {
            schoolId, classId: student.classId, isArchived: false,
            visibility: { in: ["STUDENT_VISIBLE", "PARENT_VISIBLE", "PUBLIC"] },
            ...(subjectId ? { subjectId: parseInt(subjectId) } : {}),
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true, title: true, description: true, type: true,
            fileUrl: true, externalUrl: true, tags: true, viewCount: true, createdAt: true,
            subject: { select: { id: true, name: true } },
            chapter: { select: { name: true, chapterNumber: true } },
          },
        }), [] as any[]);

      return reply.send({ success: true, data: { materials } });
    }
  );

  // ── GET /student/academics/notes?subjectId= — same model, type=NOTES ──
  app.get("/student/academics/notes",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { subjectId } = req.query as { subjectId?: string };

      const student = await getStudentContext(userId, schoolId);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const notes = await safe("notes", () =>
        prisma.studyMaterial.findMany({
          where: {
            schoolId, classId: student.classId, isArchived: false, type: "NOTES",
            visibility: { in: ["STUDENT_VISIBLE", "PARENT_VISIBLE", "PUBLIC"] },
            ...(subjectId ? { subjectId: parseInt(subjectId) } : {}),
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true, title: true, description: true,
            fileUrl: true, externalUrl: true, viewCount: true, createdAt: true,
            subject: { select: { id: true, name: true } },
            chapter: { select: { name: true, chapterNumber: true } },
          },
        }), [] as any[]);

      return reply.send({ success: true, data: { notes } });
    }
  );

  // ── PATCH /student/academics/materials/:id/view — view count ────
  app.patch("/student/academics/materials/:id/view",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      await safe("increment view", () =>
        prisma.studyMaterial.update({ where: { id: parseInt(id) }, data: { viewCount: { increment: 1 } } }), null);
      return reply.send({ success: true });
    }
  );
}