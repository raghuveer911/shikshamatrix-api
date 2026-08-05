// apps/api/src/routes/admin/academic-sessions.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

export async function adminAcademicSessionRoutes(app: FastifyInstance) {
  const P = "/admin/academic-sessions";

  // ── GET /admin/academic-sessions ─────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const sessions = await prisma.academicYear.findMany({
        where: { schoolId },
        orderBy: { startDate: "desc" },
      });

      const sessionsWithStats = await Promise.all(sessions.map(async (s) => {
        const [classes, students, staff, classesWithStudents] = await Promise.all([
          prisma.class.count({ where: { schoolId, academicYear: s.name, isActive: true } }),
          prisma.student.count({ where: { schoolId, class: { academicYear: s.name } } }),
          prisma.staff.count({ where: { schoolId, isActive: true } }),
          prisma.class.count({ where: { schoolId, academicYear: s.name, isActive: true, students: { some: {} } } }),
        ]);

        const today = new Date();
        const start = new Date(s.startDate);
        const end = new Date(s.endDate);
        const totalDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
        const elapsedDays = today > start ? Math.min(Math.ceil((today.getTime() - start.getTime()) / 86400000), totalDays) : 0;
        const progress = Math.round((elapsedDays / totalDays) * 100);

        return {
          ...s,
          stats: { classes, students, staff, classesWithStudents, progress, totalDays, elapsedDays },
        };
      }));

      return reply.send({ success: true, data: { sessions: sessionsWithStats } });
    }
  );

  // ── GET /admin/academic-sessions/:id ─────────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const session = await prisma.academicYear.findFirst({
        where: { id: parseInt(id), schoolId },
        include: { clonedFrom: { select: { id: true, name: true } }, clonedInto: { select: { id: true, name: true } } },
      });
      if (!session) return reply.status(404).send({ success: false, message: "Session not found." });

      const [classes, students, feeStructures, invoices] = await Promise.all([
        prisma.class.findMany({
          where: { schoolId, academicYear: session.name, isActive: true },
          include: { _count: { select: { students: true } } },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
        }),
        prisma.student.count({ where: { schoolId, class: { academicYear: session.name } } }),
        prisma.feeStructure.count({ where: { schoolId, academicYear: { name: session.name } } }),
        prisma.invoice.aggregate({
          where: { schoolId, academicYear: { name: session.name } },
          _sum: { totalAmount: true, paidAmount: true },
          _count: true,
        }),
      ]);

      return reply.send({
        success: true,
        data: {
          session,
          details: {
            classes, students, feeStructures,
            totalFees: Number(invoices._sum.totalAmount ?? 0),
            collectedFees: Number(invoices._sum.paidAmount ?? 0),
            totalInvoices: invoices._count,
          },
        },
      });
    }
  );

  // ── GET /admin/academic-sessions/:id/timeline ────────────
  // Session Timeline — the real lifecycle events, from the fields
  // that actually persist them (not guessed/computed).
  app.get(`${P}/:id/timeline`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const session = await prisma.academicYear.findFirst({
        where: { id: parseInt(id), schoolId },
        include: { clonedFrom: { select: { id: true, name: true } } },
      });
      if (!session) return reply.status(404).send({ success: false, message: "Session not found." });

      const events: { date: Date; label: string }[] = [
        { date: session.createdAt, label: session.clonedFrom ? `Created — cloned from "${session.clonedFrom.name}"` : "Session created" },
      ];
      if (session.activatedAt) events.push({ date: session.activatedAt, label: "Marked as active session" });
      if (session.lockedAt) events.push({ date: session.lockedAt, label: "Locked" });
      if (session.archivedAt) events.push({ date: session.archivedAt, label: "Archived" });
      events.push({ date: session.startDate, label: "Session start date" });
      events.push({ date: session.endDate, label: "Session end date" });

      events.sort((a, b) => a.date.getTime() - b.date.getTime());
      return reply.send({ success: true, data: { timeline: events } });
    }
  );

  // ── POST /admin/academic-sessions ────────────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as { name: string; startDate: string; endDate: string; setAsCurrent?: boolean };

      if (!body.name?.trim() || !body.startDate || !body.endDate) {
        return reply.status(400).send({ success: false, message: "Name, startDate, endDate are required." });
      }
      const start = new Date(body.startDate);
      const end = new Date(body.endDate);
      if (start >= end) {
        return reply.status(400).send({ success: false, message: "End date must be after start date." });
      }
      const existing = await prisma.academicYear.findFirst({ where: { schoolId, name: body.name.trim() } });
      if (existing) return reply.status(409).send({ success: false, message: `Session "${body.name}" already exists.` });

      if (body.setAsCurrent) {
        await prisma.academicYear.updateMany({ where: { schoolId }, data: { isCurrent: false } });
      }

      const session = await prisma.academicYear.create({
        data: {
          schoolId, name: body.name.trim(), startDate: start, endDate: end,
          isCurrent: body.setAsCurrent ?? false,
          status: body.setAsCurrent ? "OPEN" : "DRAFT",
          activatedAt: body.setAsCurrent ? new Date() : null,
        },
      });

      return reply.status(201).send({ success: true, message: `Session "${session.name}" created.`, data: { session } });
    }
  );

  // ── POST /admin/academic-sessions/:id/clone ──────────────
  // Clone Previous Session — creates a new session, and clones this
  // session's class structure (sections, capacity, room, shift) so
  // the new year starts from a matching skeleton instead of from
  // scratch. Subjects/Streams are school-wide (not session-scoped)
  // so nothing needs cloning there — that's a direct benefit of the
  // Subject/Stream redesign in Phase 1.
  app.post(`${P}/:id/clone`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as { name: string; startDate: string; endDate: string; cloneClasses?: boolean };

      const source = await prisma.academicYear.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!source) return reply.status(404).send({ success: false, message: "Source session not found." });
      if (!body.name?.trim() || !body.startDate || !body.endDate) {
        return reply.status(400).send({ success: false, message: "Name, startDate, endDate are required." });
      }
      const existing = await prisma.academicYear.findFirst({ where: { schoolId, name: body.name.trim() } });
      if (existing) return reply.status(409).send({ success: false, message: `Session "${body.name}" already exists.` });

      const newSession = await prisma.academicYear.create({
        data: {
          schoolId, name: body.name.trim(),
          startDate: new Date(body.startDate), endDate: new Date(body.endDate),
          status: "DRAFT", clonedFromId: source.id,
        },
      });

      let clonedClasses = 0;
      if (body.cloneClasses ?? true) {
        const sourceClasses = await prisma.class.findMany({ where: { schoolId, academicYear: source.name, isActive: true } });
        for (const c of sourceClasses) {
          const dupe = await prisma.class.findFirst({ where: { schoolId, name: c.name, academicYear: newSession.name } });
          if (dupe) continue; // already exists — skip rather than error, so clone is safely re-runnable
          await prisma.class.create({
            data: {
              schoolId, name: c.name, classNumber: c.classNumber, section: c.section,
              stream: c.stream, room: c.room, shift: c.shift, capacity: c.capacity,
              academicYear: newSession.name,
            },
          });
          clonedClasses++;
        }
      }

      return reply.status(201).send({
        success: true,
        message: `Session "${newSession.name}" created from "${source.name}"${clonedClasses ? ` — ${clonedClasses} class(es) cloned` : ""}.`,
        data: { session: newSession, clonedClasses },
      });
    }
  );

  // ── PUT /admin/academic-sessions/:id ──────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; startDate?: string; endDate?: string };

      const session = await prisma.academicYear.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!session) return reply.status(404).send({ success: false, message: "Session not found." });
      if (session.status === "LOCKED") {
        return reply.status(400).send({ success: false, message: "This session is locked — unlock it first to make changes." });
      }
      if (body.name && body.name !== session.name) {
        const dup = await prisma.academicYear.findFirst({ where: { schoolId, name: body.name.trim(), id: { not: parseInt(id) } } });
        if (dup) return reply.status(409).send({ success: false, message: `Session "${body.name}" already exists.` });
      }

      const updated = await prisma.academicYear.update({
        where: { id: parseInt(id) },
        data: {
          ...(body.name && { name: body.name.trim() }),
          ...(body.startDate && { startDate: new Date(body.startDate) }),
          ...(body.endDate && { endDate: new Date(body.endDate) }),
        },
      });
      return reply.send({ success: true, message: "Session updated.", data: { session: updated } });
    }
  );

  // ── PATCH /admin/academic-sessions/:id/activate ──────────
  app.patch(`${P}/:id/activate`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const session = await prisma.academicYear.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!session) return reply.status(404).send({ success: false, message: "Session not found." });
      if (session.status === "LOCKED" || session.status === "CLOSED") {
        return reply.status(400).send({ success: false, message: `A ${session.status.toLowerCase()} session can't be activated directly.` });
      }

      await prisma.academicYear.updateMany({ where: { schoolId }, data: { isCurrent: false } });
      const updated = await prisma.academicYear.update({
        where: { id: parseInt(id) },
        data: { isCurrent: true, status: "OPEN", activatedAt: new Date() },
      });

      return reply.send({ success: true, message: `"${updated.name}" is now the active session.`, data: { session: updated } });
    }
  );

  // ── PATCH /admin/academic-sessions/:id/lock ──────────────
  // Genuinely persists — locked sessions block edits (enforced above
  // in PUT) until explicitly unlocked.
  app.patch(`${P}/:id/lock`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as { locked: boolean };

      const session = await prisma.academicYear.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!session) return reply.status(404).send({ success: false, message: "Session not found." });
      if (session.isCurrent && body.locked) {
        return reply.status(400).send({ success: false, message: "Cannot lock the active session." });
      }

      const updated = await prisma.academicYear.update({
        where: { id: parseInt(id) },
        data: body.locked
          ? { status: "LOCKED", lockedAt: new Date() }
          : { status: session.archivedAt ? "CLOSED" : "DRAFT", lockedAt: null },
      });

      return reply.send({ success: true, message: body.locked ? "Session locked." : "Session unlocked.", data: { session: updated } });
    }
  );

  // ── PATCH /admin/academic-sessions/:id/archive ───────────
  app.patch(`${P}/:id/archive`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const session = await prisma.academicYear.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!session) return reply.status(404).send({ success: false, message: "Session not found." });
      if (session.isCurrent) {
        return reply.status(400).send({ success: false, message: "Cannot archive the active session. Set another session as current first." });
      }

      const updated = await prisma.academicYear.update({
        where: { id: parseInt(id) },
        data: { status: "CLOSED", archivedAt: new Date() },
      });
      return reply.send({ success: true, message: `Session "${session.name}" archived.`, data: { session: updated } });
    }
  );

  // ── DELETE /admin/academic-sessions/:id ──────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const session = await prisma.academicYear.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!session) return reply.status(404).send({ success: false, message: "Session not found." });
      if (session.isCurrent) return reply.status(400).send({ success: false, message: "Cannot delete the active session." });
      if (session.status === "LOCKED") return reply.status(400).send({ success: false, message: "Unlock this session before deleting it." });

      const classCount = await prisma.class.count({ where: { schoolId, academicYear: session.name } });
      if (classCount > 0) {
        return reply.status(400).send({ success: false, message: `Cannot delete: ${classCount} class(es) belong to this session. Archive it instead.` });
      }

      await prisma.academicYear.delete({ where: { id: parseInt(id) } });
      return reply.send({ success: true, message: `Session "${session.name}" deleted.` });
    }
  );
}
