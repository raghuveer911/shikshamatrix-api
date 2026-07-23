// apps/api/src/routes/dashboard/academics/homework.ts
//
// UPDATED — added PATCH (edit) and DELETE, which were missing before.
// GET list/detail and POST create are UNCHANGED from your existing
// working version.
//
// ⚠️ Grading/feedback per submission is NOT included here — that
// needs the StudyAssignmentSubmission model's actual field names
// (marks column? feedback column?) confirmed first, to avoid
// guessing schema. Share that model and I'll add it as a follow-up.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { z } from "zod";

const createSchema = z.object({
  title:       z.string().min(1),
  description: z.string().optional(),
  classId:     z.number(),
  subjectId:   z.number().optional(),
  dueDate:     z.string(),
  attachmentUrl: z.string().optional(),
});

const updateSchema = z.object({
  title:       z.string().min(1).optional(),
  description: z.string().optional(),
  dueDate:     z.string().optional(),
  attachmentUrl: z.string().optional(),
});

export async function academicsHomeworkRoutes(app: FastifyInstance) {

  // ── GET /academics/homework — List ─────────────────────────
  app.get("/academics/homework",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { classId, page = "1" } = req.query as Record<string, string>;

      const skip = (parseInt(page) - 1) * 20;

      const where: any = {
        schoolId,
        createdById: staffId,
        ...(classId ? { classId: parseInt(classId) } : {}),
      };

      const [homeworks, total] = await Promise.all([
        prisma.studyAssignment.findMany({
          where,
          skip,
          take: 20,
          orderBy: { createdAt: "desc" },
          select: {
            id:          true,
            title:       true,
            description: true,
            dueDate:     true,
            status:      true,
            createdAt:   true,
            class: {
              select: { name: true, section: true },
            },
            subject: {
              select: { name: true },
            },
            _count: { select: { submissions: true } },
          },
        }),
        prisma.studyAssignment.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: {
          homeworks,
          pagination: {
            total,
            page:       parseInt(page),
            totalPages: Math.ceil(total / 20),
          },
        },
      });
    }
  );

  // ── GET /academics/homework/:id — Detail ────────────────────
  app.get("/academics/homework/:id",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };

      const hw = await prisma.studyAssignment.findFirst({
        where: { id: parseInt(id), schoolId },
        select: {
          id:            true,
          title:         true,
          description:   true,
          dueDate:       true,
          status:        true,
          attachmentUrl: true,
          createdAt:     true,
          createdById:   true,
          classId:       true,
          subjectId:     true,
          class:   { select: { name: true, section: true } },
          subject: { select: { name: true, code: true } },
          submissions: {
            select: {
              id:          true,
              status:      true,
              submittedAt: true,
              student: {
                select: {
                  rollNumber: true,
                  user: { select: { name: true } },
                },
              },
            },
          },
        },
      });

      if (!hw) {
        return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      }

      return reply.send({ success: true, data: { homework: hw } });
    }
  );

  // ── POST /academics/homework — Create ───────────────────────
  app.post("/academics/homework",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId, userId } = req as any;

      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.errors[0]?.message,
        });
      }

      const { title, description, classId, subjectId, dueDate, attachmentUrl } = parsed.data;

      const hw = await prisma.studyAssignment.create({
        data: {
          schoolId,
          title,
          description: description ?? null,
          classId,
          subjectId:   subjectId ?? null,
          dueDate:     new Date(dueDate),
          createdById: staffId,
          status:      "PUBLISHED",
          attachmentUrl: attachmentUrl ?? null,
        },
      });

      return reply.status(201).send({
        success: true,
        message: "Homework created",
        data:    { id: hw.id },
      });
    }
  );

  // ── PATCH /academics/homework/:id — Edit ────────────────────
  app.patch("/academics/homework/:id",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { id } = req.params as { id: string };

      const existing = await prisma.studyAssignment.findFirst({
        where: { id: parseInt(id), schoolId },
        select: { createdById: true },
      });
      if (!existing) return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      if (existing.createdById !== staffId) {
        return reply.status(403).send({ success: false, error: "NOT_ALLOWED", message: "Only the creator can edit this homework." });
      }

      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });
      }
      const { title, description, dueDate, attachmentUrl } = parsed.data;

      await prisma.studyAssignment.update({
        where: { id: parseInt(id) },
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(dueDate !== undefined ? { dueDate: new Date(dueDate) } : {}),
          ...(attachmentUrl !== undefined ? { attachmentUrl } : {}),
        },
      });

      return reply.send({ success: true, message: "Homework updated" });
    }
  );

  // ── DELETE /academics/homework/:id — Delete ─────────────────
  app.delete("/academics/homework/:id",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { id } = req.params as { id: string };

      const existing = await prisma.studyAssignment.findFirst({
        where: { id: parseInt(id), schoolId },
        select: { createdById: true },
      });
      if (!existing) return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      if (existing.createdById !== staffId) {
        return reply.status(403).send({ success: false, error: "NOT_ALLOWED", message: "Only the creator can delete this homework." });
      }

      await prisma.studyAssignment.delete({ where: { id: parseInt(id) } });

      return reply.send({ success: true, message: "Homework deleted" });
    }
  );
}