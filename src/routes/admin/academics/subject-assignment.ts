// apps/api/src/routes/admin/subject-assignment.ts
// The real "who teaches what, to whom" link — replaces the old
// single teacherId that used to live directly on Subject.
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

export async function adminSubjectAssignmentRoutes(app: FastifyInstance) {
  const P = "/admin/subject-assignments";

  // ── GET /admin/subject-assignments ────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { classId?: string; teacherId?: string; academicYearId?: string; subjectId?: string };

      const assignments = await prisma.subjectAssignment.findMany({
        where: {
          schoolId, isActive: true,
          ...(q.classId ? { classId: parseInt(q.classId) } : {}),
          ...(q.teacherId ? { teacherId: parseInt(q.teacherId) } : {}),
          ...(q.academicYearId ? { academicYearId: parseInt(q.academicYearId) } : {}),
          ...(q.subjectId ? { subjectId: parseInt(q.subjectId) } : {}),
        },
        include: {
          subject: { select: { id: true, name: true, code: true, classNumber: true } },
          class: { select: { id: true, name: true, section: true } },
          teacher: { include: { user: { select: { name: true, avatarUrl: true } } } },
          academicYear: { select: { id: true, name: true } },
        },
        orderBy: [{ class: { classNumber: "asc" } }, { class: { section: "asc" } }, { subject: { name: "asc" } }],
      });

      return rep.send({ success: true, data: { assignments } });
    }
  );

  // ── GET /admin/subject-assignments/clash-check ────────────
  // Used before saving a new assignment/timetable slot — checks if a
  // teacher is already fully booked for their weekly-period quota
  // elsewhere, purely informational (not a hard block here — the real
  // per-period clash check happens in Timetable, Phase 4).
  app.get(`${P}/teacher-load`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { teacherId, academicYearId } = req.query as { teacherId: string; academicYearId: string };
      if (!teacherId || !academicYearId) return rep.status(400).send({ success: false, message: "teacherId and academicYearId are required." });

      const assignments = await prisma.subjectAssignment.findMany({
        where: { schoolId, teacherId: parseInt(teacherId), academicYearId: parseInt(academicYearId), isActive: true },
        include: { subject: { select: { name: true } }, class: { select: { name: true, section: true } } },
      });
      const totalWeeklyPeriods = assignments.reduce((s, a) => s + a.weeklyPeriods, 0);
      return rep.send({ success: true, data: { assignments, totalWeeklyPeriods } });
    }
  );

  // ── POST /admin/subject-assignments ───────────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as { subjectId: number; classId: number; teacherId: number; academicYearId: number; weeklyPeriods?: number };

      if (!b.subjectId || !b.classId || !b.teacherId || !b.academicYearId) {
        return rep.status(400).send({ success: false, message: "subjectId, classId, teacherId and academicYearId are required." });
      }

      const [subject, cls, teacher] = await Promise.all([
        prisma.subject.findFirst({ where: { id: b.subjectId, schoolId } }),
        prisma.class.findFirst({ where: { id: b.classId, schoolId } }),
        prisma.staff.findFirst({ where: { id: b.teacherId, schoolId } }),
      ]);
      if (!subject) return rep.status(404).send({ success: false, message: "Subject not found." });
      if (!cls) return rep.status(404).send({ success: false, message: "Class not found." });
      if (!teacher) return rep.status(404).send({ success: false, message: "Teacher not found." });
      if (subject.classNumber !== cls.classNumber) {
        return rep.status(400).send({ success: false, message: `"${subject.name}" is a Class ${subject.classNumber} subject — it can't be assigned to Class ${cls.name}.` });
      }

      const existing = await prisma.subjectAssignment.findFirst({
        where: { subjectId: b.subjectId, classId: b.classId, academicYearId: b.academicYearId },
      });
      if (existing) {
        if (existing.isActive) return rep.status(409).send({ success: false, message: "This subject is already assigned for this class." });
        const reactivated = await prisma.subjectAssignment.update({
          where: { id: existing.id },
          data: { isActive: true, teacherId: b.teacherId, weeklyPeriods: b.weeklyPeriods ?? existing.weeklyPeriods },
        });
        return rep.status(201).send({ success: true, message: "Assignment restored.", data: { assignment: reactivated } });
      }

      const assignment = await prisma.subjectAssignment.create({
        data: {
          schoolId, subjectId: b.subjectId, classId: b.classId, teacherId: b.teacherId,
          academicYearId: b.academicYearId, weeklyPeriods: b.weeklyPeriods ?? 0,
        },
      });
      return rep.status(201).send({ success: true, message: "Subject assigned.", data: { assignment } });
    }
  );

  // ── PUT /admin/subject-assignments/:id ────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const b = req.body as { teacherId?: number; weeklyPeriods?: number };

      const existing = await prisma.subjectAssignment.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return rep.status(404).send({ success: false, message: "Assignment not found." });

      const assignment = await prisma.subjectAssignment.update({
        where: { id: parseInt(id) },
        data: {
          ...(b.teacherId !== undefined ? { teacherId: b.teacherId } : {}),
          ...(b.weeklyPeriods !== undefined ? { weeklyPeriods: b.weeklyPeriods } : {}),
        },
      });
      return rep.send({ success: true, message: "Assignment updated.", data: { assignment } });
    }
  );

  // ── DELETE /admin/subject-assignments/:id ─────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const existing = await prisma.subjectAssignment.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return rep.status(404).send({ success: false, message: "Assignment not found." });

      await prisma.subjectAssignment.update({ where: { id: parseInt(id) }, data: { isActive: false } });
      return rep.send({ success: true, message: "Assignment removed." });
    }
  );
}
