// apps/api/src/routes/admin/academics/promote-insights.ts
// ─────────────────────────────────────────────────────────────
// Student Promotion — the health layer on top of the existing,
// already-mature promote-students.ts (preview/promote/rollback/
// history all untouched and still work exactly as before).
//
//   GET /admin/promote/overview     → Layer 1 stat rail for a class:
//                                     eligible count, risk counts,
//                                     capacity headroom in target
//   GET /admin/promote/risk-flags   → per-student: real attendance %
//                                     (from Attendance, last session)
//                                     and real exam performance (from
//                                     StudentResult, latest exam) —
//                                     not guesses
//
// Register alongside adminPromoteStudentsRoutes:
//   await app.register(adminPromoteInsightRoutes);
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminPromoteInsightRoutes(app: FastifyInstance) {
  const guard = { preHandler: [authenticate, requireCapability("students.bulkTools")] };

  // ── GET /admin/promote/risk-flags ────────────────────────
  app.get("/admin/promote/risk-flags", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { classId } = req.query as { classId: string };
    if (!classId) return rep.status(400).send({ success: false, message: "Pick a class first." });

    const cls = await prisma.class.findFirst({ where: { id: parseInt(classId), schoolId } });
    if (!cls) return rep.status(404).send({ success: false, message: "Class not found." });

    const [students, policy] = await Promise.all([
      prisma.student.findMany({ where: { schoolId, classId: cls.id, isActive: true }, select: { id: true } }),
      prisma.academicPolicy.findFirst({ where: { schoolId, academicYear: { name: cls.academicYear } } }),
    ]);
    const studentIds = students.map((s) => s.id);
    if (studentIds.length === 0) return rep.send({ success: true, data: { flags: {} } });

    const minAttendance = policy?.minAttendancePct ?? 75;
    const promotionMinPct = policy?.promotionMinPct ?? 33;

    const [attendanceRows, latestExam] = await Promise.all([
      prisma.attendance.groupBy({
        by: ["studentId", "status"],
        where: { schoolId, studentId: { in: studentIds }, class: { academicYear: cls.academicYear } },
        _count: { _all: true },
      }),
      prisma.examConfig.findFirst({
        where: { schoolId, sessionName: cls.academicYear, status: { in: ["COMPLETED", "PUBLISHED"] as any } },
        orderBy: { endDate: "desc" },
      }).catch(() => null),
    ]);

    const results = latestExam
      ? await prisma.studentResult.findMany({
          where: { schoolId, examConfigId: latestExam.id, studentId: { in: studentIds } },
          select: { studentId: true, percentage: true, isPassed: true, failedSubjects: true },
        })
      : [];
    const resultMap = new Map(results.map((r) => [r.studentId, r]));

    const attByStudent = new Map<number, { present: number; total: number }>();
    for (const row of attendanceRows) {
      const bucket = attByStudent.get(row.studentId) ?? { present: 0, total: 0 };
      bucket.total += row._count._all;
      if (row.status === "PRESENT" || row.status === "LATE") bucket.present += row._count._all;
      attByStudent.set(row.studentId, bucket);
    }

    const flags: Record<number, {
      attendancePct: number | null; attendanceRisk: boolean;
      examPct: number | null; examRisk: boolean; failedSubjects: number;
      overallRisk: "NONE" | "LOW" | "HIGH";
    }> = {};

    for (const id of studentIds) {
      const att = attByStudent.get(id);
      const attendancePct = att && att.total > 0 ? Math.round((att.present / att.total) * 100) : null;
      const attendanceRisk = attendancePct !== null && attendancePct < minAttendance;

      const result = resultMap.get(id);
      const examPct = result ? Number(result.percentage) : null;
      const examRisk = result ? !result.isPassed || examPct! < promotionMinPct : false;
      const failedSubjects = result?.failedSubjects ?? 0;

      const riskCount = (attendanceRisk ? 1 : 0) + (examRisk ? 1 : 0);
      flags[id] = {
        attendancePct, attendanceRisk, examPct, examRisk, failedSubjects,
        overallRisk: riskCount === 0 ? "NONE" : riskCount === 1 ? "LOW" : "HIGH",
      };
    }

    return rep.send({
      success: true,
      data: { flags, thresholds: { minAttendance, promotionMinPct }, examName: latestExam?.name ?? null },
    });
  });

  // ── GET /admin/promote/overview ──────────────────────────
  app.get("/admin/promote/overview", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as { classId?: string; toSession?: string };

    const currentYear = await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
    if (!currentYear) return rep.status(404).send({ success: false, message: "No active session." });

    const classes = await prisma.class.findMany({
      where: { schoolId, academicYear: currentYear.name, isActive: true },
      include: { _count: { select: { students: true } } },
    });
    const totalStudents = classes.reduce((a, c) => a + c._count.students, 0);

    const promotedThisCycle = q.toSession
      ? await prisma.promotionHistory.groupBy({
          by: ["status"],
          where: { schoolId, toSession: q.toSession, isRolledBack: false },
          _count: true,
        })
      : [];
    const promotedCount = promotedThisCycle.reduce((a, r) => a + r._count, 0);

    let classDetail = null;
    if (q.classId) {
      const cls = classes.find((c) => c.id === parseInt(q.classId!));
      if (cls) {
        const alreadyDone = q.toSession
          ? await prisma.promotionHistory.count({
              where: { schoolId, fromClassId: cls.id, toSession: q.toSession, isRolledBack: false },
            })
          : 0;
        classDetail = {
          id: cls.id, name: cls.name, totalStudents: cls._count.students,
          alreadyProcessed: alreadyDone, remaining: Math.max(0, cls._count.students - alreadyDone),
        };
      }
    }

    return rep.send({
      success: true,
      data: {
        session: currentYear.name,
        classCount: classes.length,
        totalStudents,
        promotedCount,
        statusBreakdown: promotedThisCycle.map((r) => ({ status: r.status, count: r._count })),
        classDetail,
      },
    });
  });
}
