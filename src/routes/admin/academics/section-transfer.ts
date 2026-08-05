// apps/api/src/routes/admin/section-transfer.ts
//
// Mid-session moves — 5-A → 5-B, or a stream change (Commerce →
// Science) where the school allows it. Distinct from Student
// Promotion: this happens WITHIN a session, not across one, and
// never touches roll-number-generation-for-a-new-year logic.
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminSectionTransferRoutes(app: FastifyInstance) {
  const P = "/admin/section-transfer";

  // ── GET /admin/section-transfer/eligible-classes ──────────
  // Given a source class, which classes can a student move to?
  // Same grade → any section. Different grade → only if the target
  // is a stream-change scenario the school explicitly allows (i.e.
  // moving Commerce ↔ Science mid-year), which we surface but don't
  // silently permit without the admin picking it deliberately.
  app.get(`${P}/eligible-classes`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { classId } = req.query as { classId: string };
      if (!classId) return rep.status(400).send({ success: false, message: "classId is required." });

      const source = await prisma.class.findFirst({ where: { id: parseInt(classId), schoolId } });
      if (!source) return rep.status(404).send({ success: false, message: "Class not found." });

      const [sameSections, streamOptions] = await Promise.all([
        prisma.class.findMany({
          where: { schoolId, classNumber: source.classNumber, academicYear: source.academicYear, isActive: true, id: { not: source.id } },
          include: { _count: { select: { students: true } } },
          orderBy: { section: "asc" },
        }),
        source.stream
          ? prisma.class.findMany({
              where: { schoolId, classNumber: source.classNumber, academicYear: source.academicYear, isActive: true, stream: { not: source.stream } },
              include: { _count: { select: { students: true } } },
              orderBy: { section: "asc" },
            })
          : Promise.resolve([]),
      ]);

      return rep.send({
        success: true,
        data: {
          source: { id: source.id, name: source.name, section: source.section, stream: source.stream, capacity: source.capacity },
          sameSectionOptions: sameSections,
          streamChangeOptions: streamOptions,
        },
      });
    }
  );

  // ── POST /admin/section-transfer ──────────────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('students.bulkTools')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as {
        studentIds: number[];
        toClassId: number;
        isStreamChange?: boolean;
        reason?: string;
        assignRollNumbers?: Record<number, string>; // studentId -> new roll number, optional
      };

      if (!b.studentIds?.length || !b.toClassId) {
        return rep.status(400).send({ success: false, message: "studentIds and toClassId are required." });
      }

      const toClass = await prisma.class.findFirst({ where: { id: b.toClassId, schoolId } });
      if (!toClass) return rep.status(404).send({ success: false, message: "Target class not found." });

      const currentCount = await prisma.student.count({ where: { schoolId, classId: b.toClassId, isActive: true } });
      if (currentCount + b.studentIds.length > toClass.capacity) {
        return rep.status(400).send({
          success: false,
          message: `Class ${toClass.name}-${toClass.section} has room for ${Math.max(0, toClass.capacity - currentCount)} more student(s), but ${b.studentIds.length} were selected.`,
        });
      }

      const results = { transferred: 0, skipped: [] as string[] };

      await prisma.$transaction(async (tx) => {
        for (const studentId of b.studentIds) {
          const student = await tx.student.findFirst({
            where: { id: studentId, schoolId, isActive: true },
            include: { user: { select: { name: true } }, class: { select: { classNumber: true, academicYear: true, stream: true, name: true, section: true } } },
          });
          if (!student || !student.class) { results.skipped.push(`Student ${studentId}: not found or inactive`); continue; }

          // Same-grade, same-session moves only — a real grade change
          // belongs to Student Promotion, not this endpoint.
          if (student.class.academicYear !== toClass.academicYear) {
            results.skipped.push(`${student.user.name}: different session — use Student Promotion instead.`);
            continue;
          }
          if (student.class.classNumber !== toClass.classNumber && !b.isStreamChange) {
            results.skipped.push(`${student.user.name}: different grade — set isStreamChange if this is an intentional stream move.`);
            continue;
          }

          const fromClassId = student.classId!;
          await tx.student.update({
            where: { id: studentId },
            data: {
              classId: b.toClassId,
              ...(b.assignRollNumbers?.[studentId] ? { rollNumber: b.assignRollNumbers[studentId] } : {}),
            },
          });

          // Reuses PromotionHistory so a student's full class-move
          // history (promotions AND transfers) is visible in one place.
          await tx.promotionHistory.create({
            data: {
              schoolId, studentId,
              fromClassId, toClassId: b.toClassId,
              fromSession: student.class.academicYear, toSession: toClass.academicYear,
              status: "PROMOTED",
              oldRollNumber: student.rollNumber,
              newRollNumber: b.assignRollNumbers?.[studentId] ?? student.rollNumber,
              promotedById: userId,
              remarks: b.reason ?? (b.isStreamChange ? `Stream transfer: ${student.class.stream ?? "—"} → ${toClass.stream ?? "—"}` : `Section transfer: ${student.class.name}-${student.class.section} → ${toClass.name}-${toClass.section}`),
            },
          });
          results.transferred++;
        }
      });

      return rep.send({
        success: true,
        message: `${results.transferred} student(s) transferred to ${toClass.name}-${toClass.section}.${results.skipped.length ? ` ${results.skipped.length} skipped.` : ""}`,
        data: results,
      });
    }
  );

  // ── GET /admin/section-transfer/history ───────────────────
  app.get(`${P}/history`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { studentId?: string; classId?: string };

      const history = await prisma.promotionHistory.findMany({
        where: {
          schoolId,
          ...(q.studentId ? { studentId: parseInt(q.studentId) } : {}),
          ...(q.classId ? { OR: [{ fromClassId: parseInt(q.classId) }, { toClassId: parseInt(q.classId) }] } : {}),
        },
        include: {
          student: { include: { user: { select: { name: true } } } },
          fromClass: { select: { name: true, section: true } },
          toClass: { select: { name: true, section: true } },
          promotedBy: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });

      // Only show same-session moves here (fromSession === toSession) —
      // that's what distinguishes a transfer from a cross-year promotion.
      const transfers = history.filter(h => h.fromSession === h.toSession);
      return rep.send({ success: true, data: { transfers } });
    }
  );
}
