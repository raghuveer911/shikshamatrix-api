// apps/api/src/routes/admin/academic-policies.ts
//
// School-wide default academic rules per session — attendance
// requirement, promotion rules, passing marks, grace marks, grading
// system, class strength. Distinct from GradeScale (which defines the
// A+/A/B+ boundaries for one specific exam) — this is the broader
// policy layer other modules (Promotion, Report Cards, Attendance)
// can check against.
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

const DEFAULTS = {
  minAttendancePct: 75,
  promotionMinPct: 33,
  subjectPassingMarks: 33,
  graceMarks: 0,
  allowGraceMarks: true,
  gradingSystem: "PERCENTAGE" as const,
  maxClassStrength: null as number | null,
};

async function resolveSession(schoolId: number, academicYearId?: string) {
  if (academicYearId) return prisma.academicYear.findFirst({ where: { id: parseInt(academicYearId), schoolId } });
  return prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
}

export async function adminAcademicPolicyRoutes(app: FastifyInstance) {
  const P = "/admin/academic-policies";

  // ── GET /admin/academic-policies ───────────────────────────
  // Always returns a usable policy — the school's saved one, or the
  // sensible defaults, so callers never have to handle "not configured".
  app.get(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { academicYearId?: string };

      const session = await resolveSession(schoolId, q.academicYearId);
      if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

      const policy = await prisma.academicPolicy.findUnique({ where: { academicYearId: session.id } });

      return rep.send({
        success: true,
        data: {
          academicYearId: session.id,
          isConfigured: !!policy,
          policy: policy ?? { ...DEFAULTS, academicYearId: session.id },
        },
      });
    }
  );

  // ── PUT /admin/academic-policies ───────────────────────────
  app.put(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as {
        academicYearId: number;
        minAttendancePct?: number;
        promotionMinPct?: number;
        subjectPassingMarks?: number;
        graceMarks?: number;
        allowGraceMarks?: boolean;
        gradingSystem?: "PERCENTAGE" | "GPA" | "LETTER_GRADE";
        maxClassStrength?: number | null;
      };

      if (!b.academicYearId) return rep.status(400).send({ success: false, message: "academicYearId is required." });

      // Sanity bounds — these are percentages/marks, not free numbers.
      for (const [field, val] of [["minAttendancePct", b.minAttendancePct], ["promotionMinPct", b.promotionMinPct], ["subjectPassingMarks", b.subjectPassingMarks]] as const) {
        if (val !== undefined && (val < 0 || val > 100)) {
          return rep.status(400).send({ success: false, message: `${field} must be between 0 and 100.` });
        }
      }
      if (b.graceMarks !== undefined && b.graceMarks < 0) {
        return rep.status(400).send({ success: false, message: "graceMarks can't be negative." });
      }
      if (b.maxClassStrength !== undefined && b.maxClassStrength !== null && b.maxClassStrength < 1) {
        return rep.status(400).send({ success: false, message: "maxClassStrength must be at least 1." });
      }

      const session = await prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } });
      if (!session) return rep.status(404).send({ success: false, message: "Session not found." });
      if (session.status === "LOCKED") return rep.status(400).send({ success: false, message: "This session is locked." });

      const data = {
        ...(b.minAttendancePct !== undefined ? { minAttendancePct: b.minAttendancePct } : {}),
        ...(b.promotionMinPct !== undefined ? { promotionMinPct: b.promotionMinPct } : {}),
        ...(b.subjectPassingMarks !== undefined ? { subjectPassingMarks: b.subjectPassingMarks } : {}),
        ...(b.graceMarks !== undefined ? { graceMarks: b.graceMarks } : {}),
        ...(b.allowGraceMarks !== undefined ? { allowGraceMarks: b.allowGraceMarks } : {}),
        ...(b.gradingSystem !== undefined ? { gradingSystem: b.gradingSystem } : {}),
        ...(b.maxClassStrength !== undefined ? { maxClassStrength: b.maxClassStrength } : {}),
      };

      const policy = await prisma.academicPolicy.upsert({
        where: { academicYearId: b.academicYearId },
        create: { schoolId, academicYearId: b.academicYearId, ...DEFAULTS, ...data },
        update: data,
      });

      return rep.send({ success: true, message: "Academic policy updated.", data: { policy } });
    }
  );

  // ── GET /admin/academic-policies/class-capacity-check ──────
  // Lets Admissions / Section Transfer ask "is this class allowed to
  // take one more student?" against the school's own configured limit
  // (falling back to the class's own capacity if no policy override).
  app.get(`${P}/class-capacity-check`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { classId } = req.query as { classId: string };
      if (!classId) return rep.status(400).send({ success: false, message: "classId is required." });

      const cls = await prisma.class.findFirst({ where: { id: parseInt(classId), schoolId } });
      if (!cls) return rep.status(404).send({ success: false, message: "Class not found." });

      const session = await prisma.academicYear.findFirst({ where: { schoolId, name: cls.academicYear } });
      const policy = session ? await prisma.academicPolicy.findUnique({ where: { academicYearId: session.id } }) : null;
      const limit = policy?.maxClassStrength ?? cls.capacity;

      const currentCount = await prisma.student.count({ where: { schoolId, classId: cls.id, isActive: true } });

      return rep.send({
        success: true,
        data: { classId: cls.id, currentCount, limit, availableSeats: Math.max(0, limit - currentCount), isFull: currentCount >= limit },
      });
    }
  );

  // ── GET /admin/academic-policies/promotion-eligibility/:studentId ──
  // Checks a student's attendance % against the policy's minimum —
  // a genuinely useful cross-check for Student Promotion (Phase 5) to
  // flag before an admin bulk-promotes without looking closely.
  app.get(`${P}/promotion-eligibility/:studentId`, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { studentId } = req.params as { studentId: string };
      const q = req.query as { academicYearId?: string };

      const session = await resolveSession(schoolId, q.academicYearId);
      if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

      const student = await prisma.student.findFirst({
        where: { id: parseInt(studentId), schoolId },
        include: { user: { select: { name: true } }, class: { select: { academicYear: true } } },
      });
      if (!student) return rep.status(404).send({ success: false, message: "Student not found." });

      const policy = await prisma.academicPolicy.findUnique({ where: { academicYearId: session.id } });
      const minAttendancePct = policy?.minAttendancePct ?? DEFAULTS.minAttendancePct;

      const [presentCount, totalCount] = await Promise.all([
        prisma.attendance.count({ where: { schoolId, studentId: student.id, status: "PRESENT" } }),
        prisma.attendance.count({ where: { schoolId, studentId: student.id } }),
      ]);
      const attendancePct = totalCount > 0 ? Math.round((presentCount / totalCount) * 100) : 0;
      const meetsAttendance = totalCount === 0 ? true : attendancePct >= minAttendancePct; // no records yet — don't block on it

      return rep.send({
        success: true,
        data: {
          studentId: student.id, studentName: student.user.name,
          attendancePct, minAttendancePct, meetsAttendance,
          note: totalCount === 0 ? "No attendance records found for this session — check manually." : null,
        },
      });
    }
  );
}
