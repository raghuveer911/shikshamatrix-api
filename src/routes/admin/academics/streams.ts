// apps/api/src/routes/admin/streams.ts
// Streams (Science / Commerce / Arts, etc.) — a real entity with
// its own subject groupings, instead of a free-text label on Class.
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminStreamRoutes(app: FastifyInstance) {
  const P = "/admin/streams";

  // ── GET /admin/streams ────────────────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const streams = await prisma.stream.findMany({
        where: { schoolId, isActive: true },
        include: { streamSubjects: { include: { subject: { select: { id: true, name: true, isElective: true } } } } },
        orderBy: { name: "asc" },
      });
      return rep.send({ success: true, data: { streams } });
    }
  );

  // ── POST /admin/streams ───────────────────────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as { name: string; code?: string; classNumbers: string[] };

      if (!b.name?.trim() || !b.classNumbers?.length) {
        return rep.status(400).send({ success: false, message: "name and classNumbers are required." });
      }
      const dup = await prisma.stream.findFirst({ where: { schoolId, name: b.name.trim() } });
      if (dup) return rep.status(409).send({ success: false, message: `Stream "${b.name}" already exists.` });

      const stream = await prisma.stream.create({
        data: { schoolId, name: b.name.trim(), code: b.code ?? null, classNumbers: b.classNumbers },
      });
      return rep.status(201).send({ success: true, message: "Stream created.", data: { stream } });
    }
  );

  // ── PUT /admin/streams/:id ────────────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const b = req.body as { name?: string; code?: string; classNumbers?: string[] };

      const existing = await prisma.stream.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return rep.status(404).send({ success: false, message: "Stream not found." });

      const stream = await prisma.stream.update({
        where: { id: parseInt(id) },
        data: {
          ...(b.name !== undefined ? { name: b.name.trim() } : {}),
          ...(b.code !== undefined ? { code: b.code } : {}),
          ...(b.classNumbers !== undefined ? { classNumbers: b.classNumbers } : {}),
        },
      });
      return rep.send({ success: true, message: "Stream updated.", data: { stream } });
    }
  );

  // ── DELETE /admin/streams/:id ─────────────────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const existing = await prisma.stream.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return rep.status(404).send({ success: false, message: "Stream not found." });

      await prisma.stream.update({ where: { id: parseInt(id) }, data: { isActive: false } });
      return rep.send({ success: true, message: "Stream removed." });
    }
  );

  // ── POST /admin/streams/:id/subjects ─────────────────────
  // Attach a subject to a stream (core, or part of an elective group).
  app.post(`${P}/:id/subjects`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const b = req.body as { subjectId: number; isCompulsory?: boolean; groupLabel?: string };

      const stream = await prisma.stream.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!stream) return rep.status(404).send({ success: false, message: "Stream not found." });
      const subject = await prisma.subject.findFirst({ where: { id: b.subjectId, schoolId } });
      if (!subject) return rep.status(404).send({ success: false, message: "Subject not found." });

      const link = await prisma.streamSubject.upsert({
        where: { streamId_subjectId: { streamId: parseInt(id), subjectId: b.subjectId } },
        create: { streamId: parseInt(id), subjectId: b.subjectId, isCompulsory: b.isCompulsory ?? true, groupLabel: b.groupLabel ?? null },
        update: { isCompulsory: b.isCompulsory ?? true, groupLabel: b.groupLabel ?? null },
      });
      return rep.status(201).send({ success: true, message: "Subject added to stream.", data: { streamSubject: link } });
    }
  );

  // ── DELETE /admin/streams/:id/subjects/:subjectId ────────
  app.delete(`${P}/:id/subjects/:subjectId`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id, subjectId } = req.params as { id: string; subjectId: string };
      const stream = await prisma.stream.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!stream) return rep.status(404).send({ success: false, message: "Stream not found." });

      await prisma.streamSubject.deleteMany({ where: { streamId: parseInt(id), subjectId: parseInt(subjectId) } });
      return rep.send({ success: true, message: "Subject removed from stream." });
    }
  );
}
