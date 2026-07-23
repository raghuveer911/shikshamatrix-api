import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

export async function adminPromoteStudentsRoutes(app: FastifyInstance) {

  // ── GET /admin/promote/classes ────────────────────────────
  // All classes for current/selected session
  app.get("/admin/promote/classes",
    { preHandler: [authenticate, requireCapability('students.bulkTools')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { sessionName?: string };

      const currentYear = await prisma.academicYear.findFirst({
        where: { schoolId, isCurrent: true },
      });

      const sessionName = q.sessionName ?? currentYear?.name ?? "";

      const classes = await prisma.class.findMany({
        where: { schoolId, academicYear: sessionName, isActive: true },
        orderBy: [{ classNumber: "asc" }, { section: "asc" }],
        include: {
          _count: { select: { students: true } },
        },
      });

      // Group by classNumber
      const grouped: Record<string, typeof classes> = {};
      classes.forEach(cls => {
        if (!grouped[cls.classNumber]) grouped[cls.classNumber] = [];
        grouped[cls.classNumber].push(cls);
      });

      // Get all sessions
      const sessions = await prisma.academicYear.findMany({
        where: { schoolId },
        orderBy: { startDate: "desc" },
      });

      return reply.send({
        success: true,
        data: { classes, grouped, sessions, currentSession: sessionName },
      });
    }
  );

  // ── GET /admin/promote/students ───────────────────────────
  // Students in a specific class for promotion
  app.get("/admin/promote/students",
    { preHandler: [authenticate, requireCapability('students.bulkTools')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { classId: string; toSession?: string; search?: string };

      if (!q.classId) return reply.status(400).send({ success: false, message: "classId required." });

      const cls = await prisma.class.findFirst({
        where: { id: parseInt(q.classId), schoolId },
      });
      if (!cls) return reply.status(404).send({ success: false, message: "Class not found." });

      const students = await prisma.student.findMany({
        where: {
          schoolId,
          classId: parseInt(q.classId),
          isActive: true,
          ...(q.search ? {
            user: {
              name: { contains: q.search, mode: "insensitive" },
            },
          } : {}),
        },
        include: {
          user: { select: { id: true, name: true, phone: true, gender: true } },
          class: { select: { id: true, name: true, classNumber: true, section: true } },
        },
        orderBy: { rollNumber: "asc" },
      });

      // Check which students are already promoted to the target session
      const alreadyPromotedIds = new Set<number>();
      if (q.toSession) {
        const existing = await prisma.promotionHistory.findMany({
          where: {
            schoolId,
            toSession: q.toSession,
            studentId: { in: students.map(s => s.id) },
            isRolledBack: false,
          },
          select: { studentId: true },
        });
        existing.forEach(e => alreadyPromotedIds.add(e.studentId));
      }

      // Get parent info
      const studentsWithParents = await Promise.all(students.map(async s => {
        const parent = await prisma.parentStudent.findFirst({
          where: { studentId: s.user.id },
          include: { parent: { select: { name: true, phone: true } } },
        });
        return {
          ...s,
          parentName: parent?.parent?.name ?? "—",
          parentPhone: parent?.parent?.phone ?? "—",
          alreadyPromoted: alreadyPromotedIds.has(s.id),
        };
      }));

      return reply.send({
        success: true,
        data: {
          students: studentsWithParents,
          class: cls,
          total: students.length,
        },
      });
    }
  );

  // ── GET /admin/promote/target-classes ─────────────────────
  // Classes available in the target session
  app.get("/admin/promote/target-classes",
    { preHandler: [authenticate, requireCapability('students.bulkTools')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { sessionName: string; classNumber?: string };

      const classes = await prisma.class.findMany({
        where: {
          schoolId,
          academicYear: q.sessionName,
          isActive: true,
          ...(q.classNumber ? { classNumber: q.classNumber } : {}),
        },
        orderBy: [{ classNumber: "asc" }, { section: "asc" }],
        include: { _count: { select: { students: true } } },
      });

      return reply.send({ success: true, data: { classes } });
    }
  );

  // ── POST /admin/promote/preview ───────────────────────────
  // Preview promotion before executing
  app.post("/admin/promote/preview",
    { preHandler: [authenticate, requireCapability('students.bulkTools')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as {
        studentIds: number[];
        toClassId: number;
        toSession: string;
      };

      const targetClass = await prisma.class.findFirst({
        where: { id: body.toClassId, schoolId },
        include: { _count: { select: { students: true } } },
      });
      if (!targetClass) return reply.status(404).send({ success: false, message: "Target class not found." });

      const currentStudentsInTarget = targetClass._count.students;
      const capacity = targetClass.capacity;
      const afterPromotion = currentStudentsInTarget + body.studentIds.length;
      const willExceedCapacity = afterPromotion > capacity;

      // Check already promoted
      const alreadyPromoted = await prisma.promotionHistory.findMany({
        where: {
          schoolId,
          toSession: body.toSession,
          studentId: { in: body.studentIds },
          isRolledBack: false,
        },
        include: { student: { include: { user: { select: { name: true } } } } },
      });

      return reply.send({
        success: true,
        data: {
          targetClass: { ...targetClass, currentCount: currentStudentsInTarget },
          capacity, afterPromotion, willExceedCapacity,
          alreadyPromotedCount: alreadyPromoted.length,
          alreadyPromotedStudents: alreadyPromoted.map(p => p.student.user.name),
          eligibleCount: body.studentIds.length - alreadyPromoted.length,
        },
      });
    }
  );

  // ── POST /admin/promote/promote ───────────────────────────
  // Execute promotion with database transaction
  app.post("/admin/promote/promote",
    { preHandler: [authenticate, requireCapability('students.bulkTools')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        studentPromotions: {
          studentId: number;
          status: string;   // PROMOTED | DETAINED | TC | DROPPED | FAILED | LEFT_SCHOOL
          newRollNumber?: string;
          remarks?: string;
        }[];
        fromClassId: number;
        toClassId: number;
        fromSession: string;
        toSession: string;
        autoGenerateRollNumbers: boolean;
      };

      if (!body.studentPromotions?.length) {
        return reply.status(400).send({ success: false, message: "No students selected." });
      }

      // Validate sessions
      if (body.fromSession === body.toSession) {
        return reply.status(400).send({ success: false, message: "Cannot promote to the same session." });
      }

      // Validate target class exists
      const targetClass = await prisma.class.findFirst({ where: { id: body.toClassId, schoolId } });
      if (!targetClass) return reply.status(404).send({ success: false, message: "Target class not found." });

      const result = {
        promoted: 0, detained: 0, tc: 0,
        dropped: 0, failed: 0, leftSchool: 0,
        skipped: 0, errors: [] as string[],
      };

      // Execute in transaction
      await prisma.$transaction(async (tx) => {
        for (const item of body.studentPromotions) {
          try {
            const student = await tx.student.findFirst({
              where: { id: item.studentId, schoolId },
              include: { user: { select: { name: true } } },
            });
            if (!student) { result.errors.push(`Student ${item.studentId} not found`); continue; }

            // Check duplicate promotion
            const alreadyPromoted = await tx.promotionHistory.findFirst({
              where: { schoolId, studentId: item.studentId, toSession: body.toSession, isRolledBack: false },
            });
            if (alreadyPromoted) { result.skipped++; continue; }

            const oldRollNumber = student.rollNumber;
            let newRollNumber = oldRollNumber;

            if (item.status === "PROMOTED" || item.status === "FAILED") {
              const toClassId = item.status === "PROMOTED" ? body.toClassId : body.fromClassId;

              // Auto-generate roll number if needed
              if (body.autoGenerateRollNumbers && item.status === "PROMOTED") {
                const maxRoll = await tx.student.aggregate({
                  where: { schoolId, classId: toClassId },
                  _count: true,
                });
                newRollNumber = item.newRollNumber ?? `${targetClass.classNumber}${targetClass.section}${String(maxRoll._count + 1).padStart(2, "0")}`;
              } else {
                newRollNumber = item.newRollNumber ?? oldRollNumber;
              }

              // Update student class
              await tx.student.update({
                where: { id: item.studentId },
                data: {
                  classId: toClassId,
                  rollNumber: newRollNumber,
                },
              });
            } else if (["TC","DROPPED","LEFT_SCHOOL"].includes(item.status)) {
              // Deactivate student
              await tx.student.update({
                where: { id: item.studentId },
                data: { isActive: false, classId: null },
              });
            }
            // DETAINED → stays in same class, no update needed

            // Create promotion history
            await tx.promotionHistory.create({
              data: {
                schoolId,
                studentId: item.studentId,
                fromClassId: body.fromClassId,
                toClassId: item.status === "PROMOTED" ? body.toClassId : body.fromClassId,
                fromSession: body.fromSession,
                toSession: body.toSession,
                status: item.status as any,
                oldRollNumber,
                newRollNumber,
                promotedById: userId,
                remarks: item.remarks ?? null,
              },
            });

            // Count results
            const k = item.status.toLowerCase().replace("_school","School") as keyof typeof result;
            if (typeof result[k] === "number") (result[k] as number)++;
          } catch (e: any) {
            result.errors.push(`Student ${item.studentId}: ${e.message}`);
          }
        }
      });

      return reply.send({
        success: true,
        message: `Promotion complete. ${result.promoted} promoted, ${result.detained} detained.`,
        data: { result },
      });
    }
  );

  // ── POST /admin/promote/rollback ──────────────────────────
  app.post("/admin/promote/rollback",
    { preHandler: [authenticate, requireCapability('students.bulkTools')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as { promotionIds: number[] };

      let rolledBack = 0;

      await prisma.$transaction(async (tx) => {
        for (const pid of body.promotionIds) {
          const history = await tx.promotionHistory.findFirst({
            where: { id: pid, schoolId, isRolledBack: false },
          });
          if (!history) continue;

          // Restore student to original class
          await tx.student.update({
            where: { id: history.studentId },
            data: {
              classId: history.fromClassId,
              rollNumber: history.oldRollNumber ?? undefined,
              isActive: true,
            },
          });

          // Mark as rolled back
          await tx.promotionHistory.update({
            where: { id: pid },
            data: { isRolledBack: true, rolledBackAt: new Date(), rolledBackById: userId },
          });

          rolledBack++;
        }
      });

      return reply.send({ success: true, message: `${rolledBack} promotion(s) rolled back.` });
    }
  );

  // ── GET /admin/promote/history ────────────────────────────
  app.get("/admin/promote/history",
    { preHandler: [authenticate, requireCapability('students.bulkTools')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { toSession?: string; fromClassId?: string; page?: string };

      const page = parseInt(q.page ?? "1");
      const limit = 20;

      const [history, total] = await Promise.all([
        prisma.promotionHistory.findMany({
          where: {
            schoolId,
            ...(q.toSession ? { toSession: q.toSession } : {}),
            ...(q.fromClassId ? { fromClassId: parseInt(q.fromClassId) } : {}),
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            student: { include: { user: { select: { name: true } } } },
            fromClass: { select: { name: true } },
            toClass: { select: { name: true } },
            promotedBy: { select: { name: true } },
          },
        }),
        prisma.promotionHistory.count({ where: { schoolId } }),
      ]);

      // Summary stats for session
      const stats = q.toSession ? await prisma.promotionHistory.groupBy({
        by: ["status"],
        where: { schoolId, toSession: q.toSession, isRolledBack: false },
        _count: true,
      }) : [];

      return reply.send({ success: true, data: { history, total, stats } });
    }
  );
}
