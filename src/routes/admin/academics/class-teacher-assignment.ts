// apps/api/src/routes/admin/class-teacher-assignment.ts
//
// Primary / Assistant / Coordinator roles per class per session —
// replaces the single Class.classTeacherId with proper multi-role
// support. Class.classTeacherId is kept in sync automatically when a
// PRIMARY assignment is made, so any older code reading it directly
// still sees the right teacher.
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminClassTeacherAssignmentRoutes(app: FastifyInstance) {
  const P = "/admin/class-teacher-assignments";

  // ── GET /admin/class-teacher-assignments ──────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { classId?: string; academicYearId?: string; staffId?: string };

      let academicYearId = q.academicYearId ? parseInt(q.academicYearId) : null;
      if (!academicYearId) {
        const current = await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
        academicYearId = current?.id ?? null;
      }

      const assignments = await prisma.classTeacherAssignment.findMany({
        where: {
          schoolId,
          ...(academicYearId ? { academicYearId } : {}),
          ...(q.classId ? { classId: parseInt(q.classId) } : {}),
          ...(q.staffId ? { staffId: parseInt(q.staffId) } : {}),
        },
        include: {
          class: { select: { id: true, name: true, section: true, classNumber: true } },
          staff: { include: { user: { select: { name: true, avatarUrl: true } } } },
        },
        orderBy: [{ class: { classNumber: "asc" } }, { class: { section: "asc" } }, { role: "asc" }],
      });

      return rep.send({ success: true, data: { assignments } });
    }
  );

  // ── POST /admin/class-teacher-assignments ─────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as { classId: number; staffId: number; role?: "PRIMARY" | "ASSISTANT" | "COORDINATOR"; academicYearId: number };

      if (!b.classId || !b.staffId || !b.academicYearId) {
        return rep.status(400).send({ success: false, message: "classId, staffId and academicYearId are required." });
      }
      const [cls, staff, session] = await Promise.all([
        prisma.class.findFirst({ where: { id: b.classId, schoolId } }),
        prisma.staff.findFirst({ where: { id: b.staffId, schoolId } }),
        prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } }),
      ]);
      if (!cls) return rep.status(404).send({ success: false, message: "Class not found." });
      if (!staff) return rep.status(404).send({ success: false, message: "Staff member not found." });
      if (!session) return rep.status(404).send({ success: false, message: "Session not found." });
      if (session.status === "LOCKED") return rep.status(400).send({ success: false, message: "This session is locked." });

      const role = b.role ?? "PRIMARY";
      const assignment = await prisma.classTeacherAssignment.upsert({
        where: { classId_role_academicYearId: { classId: b.classId, role, academicYearId: b.academicYearId } },
        create: { schoolId, classId: b.classId, staffId: b.staffId, role, academicYearId: b.academicYearId },
        update: { staffId: b.staffId },
        include: { staff: { include: { user: { select: { name: true } } } } },
      });

      // Keep Class.classTeacherId in sync for PRIMARY, so existing
      // reports/UI that read it directly stay correct without changes.
      if (role === "PRIMARY" && session.isCurrent) {
        await prisma.class.update({ where: { id: b.classId }, data: { classTeacherId: b.staffId } });
      }

      return rep.status(201).send({ success: true, message: `${staff ? "" : ""}${role === "PRIMARY" ? "Class teacher" : role === "ASSISTANT" ? "Assistant teacher" : "Coordinator"} assigned.`, data: { assignment } });
    }
  );

  // ── DELETE /admin/class-teacher-assignments/:id ───────────
  app.delete(`${P}/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const existing = await prisma.classTeacherAssignment.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return rep.status(404).send({ success: false, message: "Assignment not found." });

      await prisma.classTeacherAssignment.delete({ where: { id: parseInt(id) } });

      if (existing.role === "PRIMARY") {
        const cls = await prisma.class.findFirst({ where: { id: existing.classId } });
        if (cls?.classTeacherId === existing.staffId) {
          await prisma.class.update({ where: { id: existing.classId }, data: { classTeacherId: null } });
        }
      }
      return rep.send({ success: true, message: "Assignment removed." });
    }
  );

  // ── GET /admin/class-teacher-assignments/staff-load ───────
  // How many classes a teacher is already responsible for — useful
  // before assigning them to one more.
  app.get(`${P}/staff-load`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { academicYearId } = req.query as { academicYearId?: string };
      let yearId = academicYearId ? parseInt(academicYearId) : null;
      if (!yearId) {
        const current = await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
        yearId = current?.id ?? null;
      }

      const assignments = await prisma.classTeacherAssignment.findMany({
        where: { schoolId, ...(yearId ? { academicYearId: yearId } : {}) },
        include: { class: { select: { name: true, section: true } }, staff: { include: { user: { select: { name: true } } } } },
      });

      const byStaff = new Map<number, { name: string; roles: { role: string; className: string }[] }>();
      for (const a of assignments) {
        if (!byStaff.has(a.staffId)) byStaff.set(a.staffId, { name: a.staff.user.name, roles: [] });
        byStaff.get(a.staffId)!.roles.push({ role: a.role, className: `${a.class.name}-${a.class.section}` });
      }

      return rep.send({ success: true, data: { staffLoad: Array.from(byStaff.entries()).map(([staffId, v]) => ({ staffId, ...v })) } });
    }
  );
}
