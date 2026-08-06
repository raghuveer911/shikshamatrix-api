// apps/api/src/routes/admin/academics/academic-policies-insights.ts
// ─────────────────────────────────────────────────────────────
// Academic Policies — the health layer on top of the existing
// academic-policies.ts (get/put/class-capacity-check/promotion-
// eligibility all untouched).
//
//   GET  /admin/academic-policies/overview      → Layer 1 stat rail
//   POST /admin/academic-policies/copy          → copy one session's
//                                                  policy onto another
//   GET  /admin/academic-policies/suggestions    → one real, computed
//                                                  suggestion — not a
//                                                  model, just this
//                                                  session's actual
//                                                  attendance average
//                                                  compared to the
//                                                  configured minimum
//
// Register alongside adminAcademicPolicyRoutes:
//   await app.register(adminAcademicPolicyInsightRoutes);
// ─────────────────────────────────────────────────────────────

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

export async function adminAcademicPolicyInsightRoutes(app: FastifyInstance) {
  const P = "/admin/academic-policies";
  const guard = { preHandler: [authenticate, requireCapability("academics.core")] };

  async function resolveSession(schoolId: number, academicYearId?: string) {
    if (academicYearId) return prisma.academicYear.findFirst({ where: { id: parseInt(academicYearId), schoolId } });
    return prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
  }

  // ── GET /admin/academic-policies/overview ────────────────
  app.get(`${P}/overview`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string };

    const session = await resolveSession(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

    const [policy, studentCount, gradeScaleCount] = await Promise.all([
      prisma.academicPolicy.findUnique({ where: { academicYearId: session.id } }),
      prisma.student.count({ where: { schoolId, class: { academicYear: session.name } } }),
      prisma.gradeScale.count({ where: { schoolId } }).catch(() => 0),
    ]);

    const effective = policy ?? { ...DEFAULTS, academicYearId: session.id };
    const deviatesFromDefault = Object.entries(DEFAULTS).filter(
      ([k, v]) => JSON.stringify((effective as any)[k]) !== JSON.stringify(v),
    ).length;

    // Real, current attendance average for this session — what the
    // configured minAttendancePct is actually being checked against.
    const attendance = await prisma.attendance.groupBy({
      by: ["status"],
      where: { schoolId, class: { academicYear: session.name } },
      _count: { _all: true },
    });
    const total = attendance.reduce((a, r) => a + r._count._all, 0);
    const present = attendance.filter((r) => r.status === "PRESENT" || r.status === "LATE").reduce((a, r) => a + r._count._all, 0);
    const currentAttendanceAvg = total > 0 ? Math.round((present / total) * 100) : null;

    return rep.send({
      success: true,
      data: {
        session: { id: session.id, name: session.name },
        isConfigured: !!policy,
        deviatesFromDefault,
        studentCount,
        gradeScaleCount,
        currentAttendanceAvg,
        minAttendancePct: effective.minAttendancePct,
        attendanceGap: currentAttendanceAvg !== null ? currentAttendanceAvg - effective.minAttendancePct : null,
      },
    });
  });

  // ── POST /admin/academic-policies/copy ───────────────────
  app.post(`${P}/copy`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { fromAcademicYearId: number; toAcademicYearId: number };

    const [from, to] = await Promise.all([
      prisma.academicYear.findFirst({ where: { id: b.fromAcademicYearId, schoolId } }),
      prisma.academicYear.findFirst({ where: { id: b.toAcademicYearId, schoolId } }),
    ]);
    if (!from || !to) return rep.status(404).send({ success: false, message: "Both sessions must exist." });
    if (to.status === "LOCKED") return rep.status(400).send({ success: false, message: "The target session is locked." });

    const source = await prisma.academicPolicy.findUnique({ where: { academicYearId: from.id } });
    if (!source) return rep.status(404).send({ success: false, message: `${from.name} has no policy configured to copy.` });

    const { id: _drop, academicYearId: _drop2, updatedAt: _drop3, ...rest } = source as any;
    const policy = await prisma.academicPolicy.upsert({
      where: { academicYearId: to.id },
      create: { schoolId, academicYearId: to.id, ...rest },
      update: rest,
    });

    return rep.send({ success: true, message: `Policy copied from ${from.name} to ${to.name}.`, data: { policy } });
  });

  // ── GET /admin/academic-policies/suggestions ─────────────
  app.get(`${P}/suggestions`, guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { academicYearId?: string };

    const session = await resolveSession(schoolId, q.academicYearId);
    if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

    const policy = await prisma.academicPolicy.findUnique({ where: { academicYearId: session.id } });
    const minAttendancePct = policy?.minAttendancePct ?? DEFAULTS.minAttendancePct;

    const [attendance, results] = await Promise.all([
      prisma.attendance.groupBy({
        by: ["status"],
        where: { schoolId, class: { academicYear: session.name } },
        _count: { _all: true },
      }),
      prisma.studentResult.aggregate({
        where: { schoolId, class: { academicYear: session.name } },
        _avg: { percentage: true },
        _count: true,
      }).catch(() => null),
    ]);

    const total = attendance.reduce((a, r) => a + r._count._all, 0);
    const present = attendance.filter((r) => r.status === "PRESENT" || r.status === "LATE").reduce((a, r) => a + r._count._all, 0);
    const avgAttendance = total > 0 ? Math.round((present / total) * 100) : null;

    const suggestions: { title: string; detail: string; severity: "info" | "warning" }[] = [];

    if (avgAttendance !== null) {
      const gap = avgAttendance - minAttendancePct;
      if (gap < -10) {
        suggestions.push({
          title: "Attendance minimum may be unrealistic",
          detail: `The school's actual average attendance this session is ${avgAttendance}%, well below the configured ${minAttendancePct}% minimum. A large share of students may fail this check.`,
          severity: "warning",
        });
      } else if (gap > 15) {
        suggestions.push({
          title: "Attendance minimum has headroom",
          detail: `Actual average attendance is ${avgAttendance}%, comfortably above the ${minAttendancePct}% minimum. The policy is not the binding constraint right now.`,
          severity: "info",
        });
      }
    }

    if (results && results._count > 0 && results._avg.percentage !== null) {
      const avgMarks = Math.round(Number(results._avg.percentage));
      const passMin = policy?.promotionMinPct ?? DEFAULTS.promotionMinPct;
      if (avgMarks - passMin < 10) {
        suggestions.push({
          title: "Promotion minimum is close to the average score",
          detail: `Average result this session is ${avgMarks}%, only ${avgMarks - passMin} points above the ${passMin}% promotion minimum — a routine bad exam could push many students below it.`,
          severity: "warning",
        });
      }
    }

    if (suggestions.length === 0) {
      suggestions.push({
        title: "Nothing unusual",
        detail: "Current attendance and result averages sit comfortably clear of the configured thresholds.",
        severity: "info",
      });
    }

    return rep.send({ success: true, data: { suggestions, avgAttendance, minAttendancePct } });
  });
}
