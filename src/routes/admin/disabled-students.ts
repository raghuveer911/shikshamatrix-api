import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

const REASON_CATEGORIES = [
  "Family Relocation", "Financial Issue", "Transfer Certificate",
  "Medical Reason", "Disciplinary Action", "Passed Out",
  "Long Leave", "Overseas Migration", "Personal Reason", "Other",
];

const STATUS_LABELS: Record<string, string> = {
  INACTIVE: "Inactive", LEFT: "Left School", TRANSFERRED: "Transferred",
  TC_ISSUED: "TC Issued", PASSED_OUT: "Passed Out", SUSPENDED: "Suspended",
  DROPPED: "Dropped", ALUMNI: "Alumni", LONG_LEAVE: "Long Leave", EXPELLED: "Expelled",
};

export async function adminDisabledStudentsRoutes(app: FastifyInstance) {

  // ── GET /admin/disabled-students ─────────────────────────
  app.get("/admin/disabled-students",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as {
        page?: string; search?: string;
        status?: string; classId?: string;
        from?: string; to?: string;
      };

      const page = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 15;
      const skip = (page - 1) * limit;

      // ✅ FIX: isDeleted is on User model, NOT Student model
      const where: any = {
        schoolId,
        isActive: false,
        user: { isDeleted: false },   // ← filter via User relation
      };

      if (q.classId) where.classId = parseInt(q.classId);
      if (q.search) {
        where.OR = [
          { user: { name: { contains: q.search, mode: "insensitive" } } },
          { admissionNumber: { contains: q.search, mode: "insensitive" } },
          { rollNumber: { contains: q.search, mode: "insensitive" } },
        ];
      }

      // Filter by archive status / date
      let archiveWhere: any = { schoolId, isRestored: false };
      if (q.status) archiveWhere.status = q.status;
      if (q.from || q.to) {
        archiveWhere.disabledAt = {};
        if (q.from) archiveWhere.disabledAt.gte = new Date(q.from);
        if (q.to) {
          const t = new Date(q.to);
          t.setHours(23, 59, 59, 999);
          archiveWhere.disabledAt.lte = t;
        }
      }

      // Get student IDs from archives (for status/date filter)
      if (q.status || q.from || q.to) {
        const archives = await prisma.studentArchive.findMany({
          where: archiveWhere,
          select: { studentId: true },
          distinct: ["studentId"],
        });
        const filteredIds = archives.map(a => a.studentId);
        if (filteredIds.length === 0) {
          return reply.send({
            success: true,
            data: {
              students: [], total: 0, page, totalPages: 0,
              stats: { totalDisabled: 0, suspended: 0, left: 0, tc: 0, passedOut: 0 },
              reasonCategories: REASON_CATEGORIES,
            },
          });
        }
        where.id = { in: filteredIds };
      }

      const [students, total] = await Promise.all([
        prisma.student.findMany({
          where,
          skip,
          take: limit,
          orderBy: { id: "desc" },
          include: {
            user: {
              select: { id: true, name: true, gender: true, avatarUrl: true, isActive: true },
            },
            class: {
              select: { id: true, name: true, classNumber: true, section: true },
            },
            parentDetail: {
              select: { fatherName: true, fatherPhone: true },
            },
            archives: {
              orderBy: { createdAt: "desc" },
              take: 1,
              include: {
                disabledBy: { select: { name: true } },
              },
            },
          },
        }),
        prisma.student.count({ where }),
      ]);

      // Stats — ✅ no isDeleted on Student
      const [totalDisabled, suspended, left, tc, passedOut] = await Promise.all([
        prisma.student.count({ where: { schoolId, isActive: false } }),
        prisma.studentArchive.count({ where: { schoolId, status: "SUSPENDED", isRestored: false } }),
        prisma.studentArchive.count({ where: { schoolId, status: "LEFT", isRestored: false } }),
        prisma.studentArchive.count({ where: { schoolId, status: "TC_ISSUED", isRestored: false } }),
        prisma.studentArchive.count({ where: { schoolId, status: "PASSED_OUT", isRestored: false } }),
      ]);

      return reply.send({
        success: true,
        data: {
          students,
          total,
          page,
          totalPages: Math.ceil(total / limit),
          stats: { totalDisabled, suspended, left, tc, passedOut },
          reasonCategories: REASON_CATEGORIES,
        },
      });
    }
  );

  // ── GET /admin/disabled-students/check-fees/:studentId ───
  // IMPORTANT: Must be before /:id to avoid route conflict
  app.get("/admin/disabled-students/check-fees/:studentId",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { studentId } = request.params as { studentId: string };

      const pendingFees = await prisma.invoice.aggregate({
        where: {
          schoolId,
          studentId: parseInt(studentId),
          status: { in: ["PENDING", "OVERDUE", "PARTIAL"] },
        },
        _sum: { dueAmount: true },
        _count: true,
      });

      return reply.send({
        success: true,
        data: {
          pendingAmount: Number(pendingFees._sum.dueAmount ?? 0),
          pendingInvoices: pendingFees._count,
          hasPending: pendingFees._count > 0,
        },
      });
    }
  );

  // ── GET /admin/disabled-students/analytics ───────────────
  // IMPORTANT: Must be before /:id to avoid route conflict
  app.get("/admin/disabled-students/analytics",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const [byStatus, monthly] = await Promise.all([
        prisma.studentArchive.groupBy({
          by: ["status"],
          where: { schoolId, isRestored: false },
          _count: true,
        }),
        (async () => {
          const data = [];
          for (let i = 5; i >= 0; i--) {
            const d = new Date();
            d.setMonth(d.getMonth() - i);
            const mStart = new Date(d.getFullYear(), d.getMonth(), 1);
            const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
            const [disabled, restored] = await Promise.all([
              prisma.studentArchive.count({
                where: { schoolId, disabledAt: { gte: mStart, lte: mEnd } },
              }),
              prisma.studentArchive.count({
                where: { schoolId, restoredAt: { gte: mStart, lte: mEnd }, isRestored: true },
              }),
            ]);
            data.push({
              month: mStart.toLocaleString("en-IN", { month: "short", year: "2-digit" }),
              disabled,
              restored,
            });
          }
          return data;
        })(),
      ]);

      // ✅ no isDeleted on Student
      const totalActive = await prisma.student.count({ where: { schoolId, isActive: true } });
      const totalDisabled = await prisma.student.count({ where: { schoolId, isActive: false } });

      return reply.send({
        success: true,
        data: {
          byStatus: byStatus.map(b => ({
            status: STATUS_LABELS[b.status] ?? b.status,
            count: b._count,
          })),
          monthly,
          rates: {
            total: totalActive + totalDisabled,
            active: totalActive,
            disabled: totalDisabled,
            dropoutRate: totalDisabled + totalActive > 0
              ? Math.round((totalDisabled / (totalActive + totalDisabled)) * 100)
              : 0,
          },
        },
      });
    }
  );

  // ── GET /admin/disabled-students/:id ─────────────────────
  app.get("/admin/disabled-students/:id",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const student = await prisma.student.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          user: true,
          class: true,
          parentDetail: true,
          admissionDocuments: true,
          archives: {
            orderBy: { createdAt: "desc" },
            include: {
              disabledBy: { select: { name: true } },
              restoredBy: { select: { name: true } },
            },
          },
        },
      });

      if (!student) return reply.status(404).send({ success: false, message: "Student not found." });

      const [pendingFees, attendanceCount] = await Promise.all([
        prisma.invoice.aggregate({
          where: {
            schoolId,
            studentId: parseInt(id),
            status: { in: ["PENDING", "OVERDUE", "PARTIAL"] },
          },
          _sum: { dueAmount: true },
        }),
        prisma.attendance.count({ where: { schoolId, studentId: parseInt(id) } }),
      ]);

      return reply.send({
        success: true,
        data: {
          student,
          pendingFees: Number(pendingFees._sum.dueAmount ?? 0),
          attendanceCount,
        },
      });
    }
  );

  // ── POST /admin/disabled-students/disable ────────────────
  app.post("/admin/disabled-students/disable",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        studentIds: number[];
        status: string;
        reason: string;
        reasonCategory?: string;
        suspensionFrom?: string;
        suspensionTo?: string;
        autoReactivate?: boolean;
        tcNumber?: string;
        notes?: string;
      };

      if (!body.studentIds?.length) {
        return reply.status(400).send({ success: false, message: "studentIds required." });
      }
      if (!body.status || !body.reason) {
        return reply.status(400).send({ success: false, message: "status and reason required." });
      }

      const results: { studentId: number; name: string; success: boolean; pendingFees?: number }[] = [];

      await prisma.$transaction(async (tx) => {
        for (const studentId of body.studentIds) {
          const student = await tx.student.findFirst({
            where: { id: studentId, schoolId },
            include: { user: { select: { name: true } } },
          });
          if (!student) continue;

          // Check pending fees
          const feeAgg = await tx.invoice.aggregate({
            where: { schoolId, studentId, status: { in: ["PENDING", "OVERDUE", "PARTIAL"] } },
            _sum: { dueAmount: true },
          });
          const pendingAmount = Number(feeAgg._sum.dueAmount ?? 0);

          // Disable student + user
          await tx.student.update({ where: { id: studentId }, data: { isActive: false } });
          await tx.user.update({ where: { id: student.userId }, data: { isActive: false } });

          // Create archive record
          await tx.studentArchive.create({
            data: {
              schoolId,
              studentId,
              status: body.status as any,
              reason: body.reason,
              reasonCategory: body.reasonCategory ?? null,
              suspensionFrom: body.suspensionFrom ? new Date(body.suspensionFrom) : null,
              suspensionTo: body.suspensionTo ? new Date(body.suspensionTo) : null,
              autoReactivate: body.autoReactivate ?? false,
              pendingFees: pendingAmount,
              tcNumber: body.tcNumber ?? null,
              disabledById: userId,
              notes: body.notes ?? null,
            },
          });

          results.push({ studentId, name: student.user.name, success: true, pendingFees: pendingAmount });
        }
      });

      return reply.send({
        success: true,
        message: `${results.length} student(s) disabled.`,
        data: { results },
      });
    }
  );

  // ── POST /admin/disabled-students/:id/restore ────────────
  app.post("/admin/disabled-students/:id/restore",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as { restoreReason?: string; classId?: number };

      const student = await prisma.student.findFirst({
        where: { id: parseInt(id), schoolId },
        include: { user: { select: { name: true } } },
      });
      if (!student) return reply.status(404).send({ success: false, message: "Student not found." });

      await prisma.$transaction(async (tx) => {
        await tx.student.update({
          where: { id: parseInt(id) },
          data: {
            isActive: true,
            ...(body.classId && { classId: body.classId }),
          },
        });
        await tx.user.update({
          where: { id: student.userId },
          data: { isActive: true },
        });
        await tx.studentArchive.updateMany({
          where: { studentId: parseInt(id), schoolId, isRestored: false },
          data: {
            isRestored: true,
            restoredById: userId,
            restoredAt: new Date(),
            restoreReason: body.restoreReason ?? "Restored by admin",
          },
        });
      });

      return reply.send({
        success: true,
        message: `${student.user.name} has been restored.`,
      });
    }
  );

  // ── PATCH /admin/disabled-students/:id/status ────────────
  app.patch("/admin/disabled-students/:id/status",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as { status: string; reason?: string; notes?: string };

      const student = await prisma.student.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!student) return reply.status(404).send({ success: false, message: "Not found." });

      await prisma.studentArchive.updateMany({
        where: { studentId: parseInt(id), schoolId, isRestored: false },
        data: {
          status: body.status as any,
          ...(body.reason && { reason: body.reason }),
          ...(body.notes && { notes: body.notes }),
        },
      });

      return reply.send({ success: true, message: "Status updated." });
    }
  );
}