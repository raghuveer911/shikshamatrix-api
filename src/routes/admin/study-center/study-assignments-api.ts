// apps/api/src/routes/admin/study-center/study-assignments-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminStudyAssignmentsRoutes(app: FastifyInstance) {
  const P = "/admin/study/assignments";

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const now = new Date();
      const [active, totalSubmissions, evaluated, late, typeBreakdown] = await Promise.all([
        prisma.studyAssignment.count({ where: { schoolId, isActive: true } }),
        prisma.studyAssignmentSubmission.count({ where: { assignment: { schoolId } } }),
        prisma.studyAssignmentSubmission.count({ where: { assignment: { schoolId }, status: "EVALUATED" } }),
        prisma.studyAssignmentSubmission.count({ where: { assignment: { schoolId }, isLate: true } }),
        prisma.studyAssignment.groupBy({
          by: ["type"],
          where: { schoolId, isActive: true },
          _count: { id: true },
        }),
      ]);

      const pending = totalSubmissions - evaluated;

      // Recent assignments
      const recent = await prisma.studyAssignment.findMany({
        where: { schoolId, isActive: true },
        orderBy: { createdAt: "desc" },
        take: 6,
        include: {
          class:   { select: { name: true } },
          createdBy: { include: { user: { select: { name: true } } } },
          _count: { select: { submissions: true } },
        },
      });

      // Overdue assignments
      const overdue = await prisma.studyAssignment.count({
        where: { schoolId, isActive: true, dueDate: { lt: now } },
      });

      return rep.send({ active, totalSubmissions, evaluated, late, pending, typeBreakdown, recent, overdue });
    }
  );

  // ─── LIST ASSIGNMENTS ─────────────────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId, isActive: true };
      if (q.classId)   where.classId   = Number(q.classId);
      if (q.classNumber) where.classNumber = q.classNumber;
      if (q.subjectName) where.subjectName = q.subjectName;
      if (q.chapterId) where.chapterId = Number(q.chapterId);
      if (q.type)      where.type      = q.type;
      if (q.isReusable === "true") where.isReusable = true;
      if (q.academicYear) where.academicYear = q.academicYear;
      if (q.search) where.title = { contains: q.search, mode: "insensitive" };

      const [assignments, total] = await Promise.all([
        prisma.studyAssignment.findMany({
          where,
          include: {
            chapter: { select: { name: true } },
            class:   { select: { name: true } },
            createdBy: { include: { user: { select: { name: true, avatarUrl: true } } } },
            _count: { select: { submissions: true, materials: true } },
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.studyAssignment.count({ where }),
      ]);

      return rep.send({ assignments, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── GET ONE ASSIGNMENT + SUBMISSION SUMMARY ──────────────
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);

      const assignment = await prisma.studyAssignment.findFirst({
        where: { id, schoolId },
        include: {
          chapter: { select: { name: true } },
          topic:   { select: { name: true } },
          class:   { select: { name: true } },
          createdBy: { include: { user: { select: { name: true } } } },
          materials: {
            include: { material: { select: { id: true, title: true, type: true, fileUrl: true, thumbnailUrl: true } } },
            orderBy: { sortOrder: "asc" },
          },
        },
      });
      if (!assignment) return rep.code(404).send({ error: "Not found" });

      const submissionStats = await prisma.studyAssignmentSubmission.groupBy({
        by: ["status"],
        where: { assignmentId: id },
        _count: { id: true },
      });

      return rep.send({ assignment, submissionStats });
    }
  );

  // ─── CREATE ASSIGNMENT ────────────────────────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId } });
      if (!staff) return rep.code(403).send({ error: "Staff profile not found" });

      const assignment = await prisma.studyAssignment.create({
        data: {
          schoolId,
          createdById: staff.id,
          classId:    b.classId    ? Number(b.classId)    : null,
          classNumber: b.classNumber ?? null,
          subjectName: b.subjectName ?? null,
          chapterId:  b.chapterId  ? Number(b.chapterId)  : null,
          topicId:    b.topicId    ? Number(b.topicId)    : null,
          title:        b.title,
          instructions: b.instructions ?? null,
          totalMarks:   Number(b.totalMarks ?? 10),
          dueDate:      b.dueDate ? new Date(b.dueDate) : null,
          type:         b.type as any ?? "HOMEWORK",
          isReusable:   b.isReusable ?? false,
          academicYear: b.academicYear ?? null,
        },
      });

      // Attach existing materials (reuse from content library)
      if (b.materialIds?.length) {
        await prisma.studyAssignmentMaterial.createMany({
          data: (b.materialIds as number[]).map((mid: number, idx: number) => ({
            assignmentId: assignment.id,
            materialId:   Number(mid),
            sortOrder:    idx,
          })),
          skipDuplicates: true,
        });
      }

      return rep.code(201).send({ assignment });
    }
  );

  // ─── UPDATE ASSIGNMENT ────────────────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const assignment = await prisma.studyAssignment.update({
        where: { id, schoolId },
        data: {
          title:        b.title,
          instructions: b.instructions,
          totalMarks:   b.totalMarks   ? Number(b.totalMarks)  : undefined,
          dueDate:      b.dueDate      ? new Date(b.dueDate)   : undefined,
          type:         b.type as any,
          isReusable:   b.isReusable,
          isActive:     b.isActive,
        },
      });

      // Sync material links
      if (b.materialIds) {
        await prisma.studyAssignmentMaterial.deleteMany({ where: { assignmentId: id } });
        if (b.materialIds.length) {
          await prisma.studyAssignmentMaterial.createMany({
            data: (b.materialIds as number[]).map((mid: number, idx: number) => ({
              assignmentId: id, materialId: Number(mid), sortOrder: idx,
            })),
          });
        }
      }

      return rep.send({ assignment });
    }
  );

  // ─── SOFT DELETE ──────────────────────────────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.studyAssignment.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─── SUBMISSIONS LIST ─────────────────────────────────────
  app.get(`${P}/:id/submissions`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const q = req.query as any;

      const where: any = { assignmentId: id };
      if (q.status) where.status = q.status;

      const submissions = await prisma.studyAssignmentSubmission.findMany({
        where,
        include: {
          student: {
            include: {
              user: { select: { name: true, avatarUrl: true } },
              class: { select: { name: true } },
            },
          },
          evaluatedBy: { include: { user: { select: { name: true } } } },
        },
        orderBy: { submittedAt: "desc" },
      });

      return rep.send({ submissions });
    }
  );

  // ─── CREATE SUBMISSION (student portal) ───────────────────
  app.post(`${P}/:id/submissions`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const id = Number((req.params as any).id);
      const b  = req.body as any;

      const assignment = await prisma.studyAssignment.findFirst({ where: { id } });
      if (!assignment) return rep.code(404).send({ error: "Assignment not found" });

      const isLate = assignment.dueDate ? new Date() > new Date(assignment.dueDate) : false;

      const submission = await prisma.studyAssignmentSubmission.upsert({
        where: { assignmentId_studentId: { assignmentId: id, studentId: Number(b.studentId) } },
        create: {
          assignmentId: id,
          studentId:    Number(b.studentId),
          fileUrl:      b.fileUrl ?? null,
          fileName:     b.fileName ?? null,
          notes:        b.notes ?? null,
          status:       isLate ? "LATE" : "SUBMITTED",
          isLate,
          submittedAt:  new Date(),
        },
        update: {
          fileUrl:     b.fileUrl ?? undefined,
          notes:       b.notes ?? undefined,
          status:      isLate ? "LATE" : "SUBMITTED",
          isLate,
          submittedAt: new Date(),
        },
      });

      return rep.code(201).send({ submission });
    }
  );

  // ─── EVALUATE SUBMISSION ──────────────────────────────────
  app.put(`${P}/:id/submissions/:subId/evaluate`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const subId = Number((req.params as any).subId);
      const b = req.body as any;

      const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId } });

      const submission = await prisma.studyAssignmentSubmission.update({
        where: { id: subId },
        data: {
          marks:        b.marks != null ? Number(b.marks) : undefined,
          feedback:     b.feedback ?? undefined,
          status:       "EVALUATED",
          evaluatedAt:  new Date(),
          evaluatedById: staff?.id ?? null,
        },
      });

      return rep.send({ submission });
    }
  );

  // ─── BULK EVALUATE ────────────────────────────────────────
  app.post(`${P}/:id/submissions/bulk-evaluate`, { preHandler: [authenticate, requireCapability('studyCenter.advanced')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { evaluations } = req.body as any; // [{subId, marks, feedback}]

      const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId } });
      let count = 0;

      for (const ev of evaluations) {
        await prisma.studyAssignmentSubmission.update({
          where: { id: Number(ev.subId) },
          data: { marks: Number(ev.marks), feedback: ev.feedback ?? null, status: "EVALUATED", evaluatedAt: new Date(), evaluatedById: staff?.id ?? null },
        });
        count++;
      }

      return rep.send({ evaluated: count });
    }
  );

  // ─── ASSIGNMENT BANK (reusable) ───────────────────────────
  app.get(`${P}/bank/list`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const bank = await prisma.studyAssignment.findMany({
        where: {
          schoolId,
          isReusable: true,
          isActive: true,
          ...(q.classNumber ? { classNumber: q.classNumber } : {}),
          ...(q.subjectName ? { subjectName: q.subjectName } : {}),
          ...(q.type ? { type: q.type as any } : {}),
        },
        include: {
          chapter: { select: { name: true } },
          _count: { select: { submissions: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      return rep.send({ bank });
    }
  );

  // ─── CLONE FROM BANK ──────────────────────────────────────
  app.post(`${P}/:id/clone`, { preHandler: [authenticate, requireCapability('studyCenter.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const src = await prisma.studyAssignment.findFirst({ where: { id, schoolId }, include: { materials: true } });
      if (!src) return rep.code(404).send({ error: "Not found" });

      const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId } });
      const clone = await prisma.studyAssignment.create({
        data: {
          schoolId,
          createdById: staff?.id ?? src.createdById,
          classId:     b.classId  ? Number(b.classId) : src.classId,
          classNumber: src.classNumber,
          subjectName: src.subjectName,
          chapterId:   src.chapterId,
          title:       b.title ?? `${src.title} (Copy)`,
          instructions: src.instructions,
          totalMarks:   src.totalMarks,
          dueDate:      b.dueDate ? new Date(b.dueDate) : null,
          type:         src.type,
          isReusable:   false,
          academicYear: b.academicYear ?? src.academicYear,
        },
      });

      if (src.materials.length) {
        await prisma.studyAssignmentMaterial.createMany({
          data: src.materials.map(m => ({ assignmentId: clone.id, materialId: m.materialId, sortOrder: m.sortOrder })),
        });
      }

      return rep.code(201).send({ assignment: clone });
    }
  );

  // ─── ANALYTICS ────────────────────────────────────────────
  app.get(`${P}/analytics/overview`, { preHandler: [authenticate, requireCapability('studyCenter.advanced')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const [submissionByStatus, submissionBySubject] = await Promise.all([
        prisma.studyAssignmentSubmission.groupBy({
          by: ["status"],
          where: { assignment: { schoolId, ...(q.academicYear ? { academicYear: q.academicYear } : {}) } },
          _count: { id: true },
        }),
        prisma.studyAssignment.groupBy({
          by: ["subjectName"],
          where: { schoolId, isActive: true, subjectName: { not: null } },
          _count: { id: true },
          orderBy: { _count: { id: "desc" } },
          take: 8,
        }),
      ]);

      return rep.send({
        submissionByStatus,
        submissionBySubject: submissionBySubject.map(s => ({
          name: s.subjectName ?? "?", count: s._count.id,
        })),
      });
    }
  );
}
