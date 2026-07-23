import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── Category presets ──────────────────────────────────────────
const POSITIVE_CATEGORIES = [
  "Leadership", "Helping Others", "Academic Excellence", "Sports Achievement",
  "Discipline", "Creativity", "Community Service", "Good Conduct",
  "Punctuality", "Team Work", "Honesty", "Responsibility",
];

const NEGATIVE_CATEGORIES = [
  "Misbehaviour", "Fighting", "Bullying", "Late Coming",
  "Homework Incomplete", "Disrespect", "Property Damage", "Cheating",
  "Absenteeism", "Substance Use", "Cyberbullying", "Vandalism",
];

export async function adminBehaviourRoutes(app: FastifyInstance) {

  // ── GET /admin/behaviour/meta ─────────────────────────────
  app.get("/admin/behaviour/meta",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const [classes, staff] = await Promise.all([
        prisma.class.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          select: { id: true, name: true, classNumber: true, section: true },
        }),
        prisma.staff.findMany({
          where: { schoolId, isActive: true },
          include: { user: { select: { id: true, name: true } } },
          orderBy: { user: { name: "asc" } },
        }),
      ]);

      return reply.send({
        success: true,
        data: { classes, staff, positiveCategories: POSITIVE_CATEGORIES, negativeCategories: NEGATIVE_CATEGORIES },
      });
    }
  );

  // ── GET /admin/behaviour ──────────────────────────────────
  app.get("/admin/behaviour",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as {
        page?: string; search?: string;
        classId?: string; type?: string; severity?: string;
        status?: string; from?: string; to?: string;
        studentId?: string;
      };

      const page = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 15;
      const skip = (page - 1) * limit;

      const where: any = { schoolId };

      if (q.classId) where.classId = parseInt(q.classId);
      if (q.type) where.behaviourType = q.type;
      if (q.severity) where.severity = q.severity;
      if (q.status) where.status = q.status;
      if (q.studentId) where.studentId = parseInt(q.studentId);
      if (q.from || q.to) {
        where.behaviourDate = {};
        if (q.from) where.behaviourDate.gte = new Date(q.from);
        if (q.to) { const t = new Date(q.to); t.setHours(23,59,59,999); where.behaviourDate.lte = t; }
      }
      if (q.search) {
        where.OR = [
          { title: { contains: q.search, mode: "insensitive" } },
          { student: { user: { name: { contains: q.search, mode: "insensitive" } } } },
          { category: { contains: q.search, mode: "insensitive" } },
        ];
      }

      const [records, total] = await Promise.all([
        prisma.behaviourRecord.findMany({
          where, skip, take: limit,
          orderBy: { behaviourDate: "desc" },
          include: {
            student: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } },
            class: { select: { id: true, name: true } },
            reportedBy: { select: { id: true, name: true } },
            attachments: true,
          },
        }),
        prisma.behaviourRecord.count({ where }),
      ]);

      // Summary stats
      const [positiveCount, negativeCount, openCount, resolvedCount] = await Promise.all([
        prisma.behaviourRecord.count({ where: { schoolId, behaviourType: "POSITIVE" } }),
        prisma.behaviourRecord.count({ where: { schoolId, behaviourType: "NEGATIVE" } }),
        prisma.behaviourRecord.count({ where: { schoolId, status: "OPEN" } }),
        prisma.behaviourRecord.count({ where: { schoolId, status: "RESOLVED" } }),
      ]);

      return reply.send({
        success: true,
        data: {
          records, total,
          totalPages: Math.ceil(total / limit),
          stats: { positiveCount, negativeCount, openCount, resolvedCount, total: positiveCount + negativeCount },
        },
      });
    }
  );

  // ── GET /admin/behaviour/:id ──────────────────────────────
  app.get("/admin/behaviour/:id",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const record = await prisma.behaviourRecord.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          student: {
            include: {
              user: { select: { id: true, name: true, gender: true, avatarUrl: true } },
              class: { select: { name: true } },
              parentDetail: { select: { fatherName: true, fatherPhone: true, motherName: true } },
            },
          },
          class: { select: { id: true, name: true } },
          reportedBy: { select: { id: true, name: true } },
          attachments: true,
        },
      });

      if (!record) return reply.status(404).send({ success: false, message: "Record not found." });

      // Behaviour history for this student (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const recentCount = await prisma.behaviourRecord.count({
        where: { schoolId, studentId: record.studentId, behaviourDate: { gte: thirtyDaysAgo }, id: { not: parseInt(id) } },
      });

      // Total points for student
      const pointsAgg = await prisma.behaviourRecord.aggregate({
        where: { schoolId, studentId: record.studentId },
        _sum: { points: true },
      });

      return reply.send({
        success: true,
        data: { record, recentIncidents: recentCount, totalPoints: pointsAgg._sum.points ?? 0 },
      });
    }
  );

  // ── POST /admin/behaviour ─────────────────────────────────
  app.post("/admin/behaviour",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        studentId: number;
        title: string;
        behaviourType: string;
        category: string;
        severity: string;
        description: string;
        actionTaken?: string;
        actionNotes?: string;
        status?: string;
        points?: number;
        behaviourDate?: string;
        followUpDate?: string;
        visibleToParent?: boolean;
        visibleToStudent?: boolean;
        isAnonymous?: boolean;
        tags?: string[];
        attachments?: { fileName: string; fileUrl: string; fileType: string }[];
      };

      if (!body.studentId || !body.title || !body.behaviourType) {
        return reply.status(400).send({ success: false, message: "studentId, title, behaviourType required." });
      }

      const student = await prisma.student.findFirst({
        where: { id: body.studentId, schoolId },
      });
      if (!student) return reply.status(404).send({ success: false, message: "Student not found." });

      // Auto-calculate points based on type and severity
      let points = body.points ?? 0;
      if (points === 0) {
        const severityMultiplier = { LOW: 5, MEDIUM: 10, HIGH: 20, CRITICAL: 30 };
        const mult = severityMultiplier[body.severity as keyof typeof severityMultiplier] ?? 5;
        points = body.behaviourType === "POSITIVE" ? mult : -mult;
      }

      const record = await prisma.behaviourRecord.create({
        data: {
          schoolId,
          studentId: body.studentId,
          classId: student.classId ?? null,
          reportedById: userId,
          title: body.title.trim(),
          behaviourType: body.behaviourType as any,
          category: body.category,
          severity: body.severity as any,
          description: body.description,
          actionTaken: (body.actionTaken as any) ?? "NONE",
          actionNotes: body.actionNotes ?? null,
          status: (body.status as any) ?? "OPEN",
          points,
          behaviourDate: body.behaviourDate ? new Date(body.behaviourDate) : new Date(),
          followUpDate: body.followUpDate ? new Date(body.followUpDate) : null,
          visibleToParent: body.visibleToParent ?? true,
          visibleToStudent: body.visibleToStudent ?? false,
          isAnonymous: body.isAnonymous ?? false,
          tags: body.tags ?? [],
          attachments: body.attachments?.length ? {
            createMany: { data: body.attachments },
          } : undefined,
        },
        include: {
          student: { include: { user: { select: { name: true } } } },
          attachments: true,
        },
      });

      // Check repeat offender (3+ in last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const recentNegative = await prisma.behaviourRecord.count({
        where: {
          schoolId, studentId: body.studentId,
          behaviourType: "NEGATIVE",
          behaviourDate: { gte: thirtyDaysAgo },
        },
      });
      const isRepeatOffender = recentNegative >= 3;

      return reply.status(201).send({
        success: true,
        message: `Behaviour record added for ${record.student.user.name}.`,
        data: { record, isRepeatOffender, points },
      });
    }
  );

  // ── PUT /admin/behaviour/:id ──────────────────────────────
  app.put("/admin/behaviour/:id",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as any;

      const record = await prisma.behaviourRecord.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!record) return reply.status(404).send({ success: false, message: "Record not found." });

      const updated = await prisma.behaviourRecord.update({
        where: { id: parseInt(id) },
        data: {
          ...(body.title && { title: body.title }),
          ...(body.behaviourType && { behaviourType: body.behaviourType }),
          ...(body.category && { category: body.category }),
          ...(body.severity && { severity: body.severity }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.actionTaken !== undefined && { actionTaken: body.actionTaken }),
          ...(body.actionNotes !== undefined && { actionNotes: body.actionNotes }),
          ...(body.status !== undefined && { status: body.status }),
          ...(body.points !== undefined && { points: body.points }),
          ...(body.followUpDate !== undefined && { followUpDate: body.followUpDate ? new Date(body.followUpDate) : null }),
          ...(body.followUpNotes !== undefined && { followUpNotes: body.followUpNotes }),
          ...(body.visibleToParent !== undefined && { visibleToParent: body.visibleToParent }),
          ...(body.visibleToStudent !== undefined && { visibleToStudent: body.visibleToStudent }),
          ...(body.tags !== undefined && { tags: body.tags }),
        },
      });

      return reply.send({ success: true, message: "Record updated.", data: { record: updated } });
    }
  );

  // ── PATCH /admin/behaviour/:id/status ────────────────────
  app.patch("/admin/behaviour/:id/status",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const { status, notes } = request.body as { status: string; notes?: string };

      const record = await prisma.behaviourRecord.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!record) return reply.status(404).send({ success: false, message: "Not found." });

      await prisma.behaviourRecord.update({
        where: { id: parseInt(id) },
        data: { status: status as any, ...(notes && { actionNotes: notes }) },
      });

      return reply.send({ success: true, message: `Status updated to ${status}.` });
    }
  );

  // ── DELETE /admin/behaviour/:id ───────────────────────────
  app.delete("/admin/behaviour/:id",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const record = await prisma.behaviourRecord.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!record) return reply.status(404).send({ success: false, message: "Not found." });

      await prisma.behaviourRecord.delete({ where: { id: parseInt(id) } });
      return reply.send({ success: true, message: "Record deleted." });
    }
  );

  // ── GET /admin/behaviour/analytics ───────────────────────
  app.get("/admin/behaviour/analytics",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { from?: string; to?: string; classId?: string };

      const from = q.from ? new Date(q.from) : new Date(new Date().setDate(1));
      const to = q.to ? new Date(q.to) : new Date();

      const where: any = { schoolId, behaviourDate: { gte: from, lte: to } };
      if (q.classId) where.classId = parseInt(q.classId);

      const [byType, bySeverity, byCategory, topOffenders, topPositive] = await Promise.all([
        // Type breakdown
        prisma.behaviourRecord.groupBy({ by: ["behaviourType"], where, _count: true }),
        // Severity breakdown
        prisma.behaviourRecord.groupBy({ by: ["severity"], where, _count: true }),
        // Category breakdown
        prisma.behaviourRecord.groupBy({ by: ["category"], where, _count: true, orderBy: { _count: { category: "desc" } }, take: 8 }),
        // Top negative students (repeat offenders)
        prisma.behaviourRecord.groupBy({
          by: ["studentId"], where: { ...where, behaviourType: "NEGATIVE" },
          _count: true, _sum: { points: true },
          orderBy: { _count: { studentId: "desc" } }, take: 5,
        }),
        // Top positive students
        prisma.behaviourRecord.groupBy({
          by: ["studentId"], where: { ...where, behaviourType: "POSITIVE" },
          _count: true, _sum: { points: true },
          orderBy: { _sum: { points: "desc" } }, take: 5,
        }),
      ]);

      // Enrich top students with names
      const enrichStudents = async (items: any[]) => Promise.all(items.map(async i => {
        const s = await prisma.student.findFirst({ where: { id: i.studentId }, include: { user: { select: { name: true } }, class: { select: { name: true } } } });
        return { ...i, name: s?.user.name ?? "—", class: s?.class?.name ?? "—" };
      }));

      const [offenders, stars] = await Promise.all([enrichStudents(topOffenders), enrichStudents(topPositive)]);

      return reply.send({
        success: true,
        data: {
          byType: byType.map(b => ({ type: b.behaviourType, count: b._count })),
          bySeverity: bySeverity.map(b => ({ severity: b.severity, count: b._count })),
          byCategory: byCategory.map(b => ({ category: b.category, count: b._count })),
          topOffenders: offenders,
          topStars: stars,
        },
      });
    }
  );

  // ── GET /admin/behaviour/student/:studentId/points ────────
  app.get("/admin/behaviour/student/:studentId/points",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { studentId } = request.params as { studentId: string };

      const [records, points] = await Promise.all([
        prisma.behaviourRecord.findMany({
          where: { schoolId, studentId: parseInt(studentId) },
          orderBy: { behaviourDate: "desc" },
          take: 20,
          include: { reportedBy: { select: { name: true } } },
        }),
        prisma.behaviourRecord.aggregate({
          where: { schoolId, studentId: parseInt(studentId) },
          _sum: { points: true },
        }),
      ]);

      const totalPoints = points._sum.points ?? 0;
      const badge = totalPoints >= 100 ? "STAR" : totalPoints >= 50 ? "GOOD" : totalPoints >= 0 ? "NORMAL" : "NEEDS_ATTENTION";

      return reply.send({
        success: true,
        data: { records, totalPoints, badge },
      });
    }
  );
}