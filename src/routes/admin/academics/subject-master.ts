// apps/api/src/routes/admin/subject-master.ts
// Grade-level Subject Master — the real "subject catalog" for the
// school, shared across every section of a grade instead of being
// duplicated per class-section.
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

export async function adminSubjectMasterRoutes(app: FastifyInstance) {
  const P = "/admin/subject-master";

  // ── GET /admin/subject-master ────────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { classNumber?: string; streamId?: string; search?: string };

      const subjects = await prisma.subject.findMany({
        where: {
          schoolId,
          isActive: true,
          ...(q.classNumber ? { classNumber: q.classNumber } : {}),
          ...(q.streamId ? { streamId: parseInt(q.streamId) } : {}),
          ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}),
        },
        include: {
          stream: { select: { id: true, name: true } },
          _count: { select: { assignments: true } },
        },
        orderBy: [{ classNumber: "asc" }, { name: "asc" }],
      });

      return rep.send({ success: true, data: { subjects } });
    }
  );

  // ── GET /admin/subject-master/class-numbers ──────────────
  // Distinct grades that actually have classes, for the picker.
  app.get(`${P}/class-numbers`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const classes = await prisma.class.findMany({
        where: { schoolId, isActive: true },
        distinct: ["classNumber"],
        select: { classNumber: true },
        orderBy: { classNumber: "asc" },
      });
      return rep.send({ success: true, data: { classNumbers: classes.map(c => c.classNumber) } });
    }
  );

  // ── POST /admin/subject-master ───────────────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as {
        classNumber: string; name: string; code?: string;
        isElective?: boolean; subjectMode?: "THEORY" | "PRACTICAL" | "ORAL" | "ACTIVITY" | "ASSIGNMENT";
        credits?: number; streamId?: number;
      };

      if (!b.classNumber?.trim() || !b.name?.trim()) {
        return rep.status(400).send({ success: false, message: "classNumber and name are required." });
      }

      const dup = await prisma.subject.findFirst({ where: { schoolId, classNumber: b.classNumber, name: b.name.trim() } });
      if (dup) return rep.status(409).send({ success: false, message: `"${b.name}" already exists for Class ${b.classNumber}.` });

      const subject = await prisma.subject.create({
        data: {
          schoolId, classNumber: b.classNumber, name: b.name.trim(), code: b.code ?? null,
          isElective: b.isElective ?? false, subjectMode: b.subjectMode ?? "THEORY",
          credits: b.credits ?? null, streamId: b.streamId ?? null,
        },
      });
      return rep.status(201).send({ success: true, message: "Subject created.", data: { subject } });
    }
  );

  // ── PUT /admin/subject-master/:id ────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const b = req.body as any;

      const existing = await prisma.subject.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return rep.status(404).send({ success: false, message: "Subject not found." });

      const subject = await prisma.subject.update({
        where: { id: parseInt(id) },
        data: {
          ...(b.name !== undefined ? { name: b.name.trim() } : {}),
          ...(b.code !== undefined ? { code: b.code } : {}),
          ...(b.isElective !== undefined ? { isElective: b.isElective } : {}),
          ...(b.subjectMode !== undefined ? { subjectMode: b.subjectMode } : {}),
          ...(b.credits !== undefined ? { credits: b.credits } : {}),
          ...(b.streamId !== undefined ? { streamId: b.streamId } : {}),
        },
      });
      return rep.send({ success: true, message: "Subject updated.", data: { subject } });
    }
  );

  // ── DELETE /admin/subject-master/:id ─────────────────────
  // Soft delete — a subject with existing assignments/history stays
  // referenceable, just hidden from active pickers.
  app.delete(`${P}/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const existing = await prisma.subject.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return rep.status(404).send({ success: false, message: "Subject not found." });

      const activeAssignments = await prisma.subjectAssignment.count({ where: { subjectId: parseInt(id), isActive: true } });
      if (activeAssignments > 0) {
        return rep.status(409).send({ success: false, message: `This subject has ${activeAssignments} active assignment(s) — remove those first.` });
      }

      await prisma.subject.update({ where: { id: parseInt(id) }, data: { isActive: false } });
      return rep.send({ success: true, message: "Subject removed." });
    }
  );
}
