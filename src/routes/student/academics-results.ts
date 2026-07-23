// apps/api/src/routes/student/academics-results.ts
//
// Results — StudentResult model, filtered to visible statuses only
// (PUBLISHED/LOCKED — DRAFT/GENERATED/VERIFIED/APPROVED are internal
// workflow states not meant for student view).
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/results] "${label}" failed:`, err?.message ?? err); return fallback; }
}

const VISIBLE_STATUSES = ["PUBLISHED", "LOCKED"];

async function getStudentId(userId: number, schoolId: number): Promise<number | null> {
  const s = await safe("student lookup", () =>
    prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true } }), null);
  return s?.id ?? null;
}

export async function studentResultsRoutes(app: FastifyInstance) {

  // ── GET /student/academics/exams/results ─────────────────────
  app.get("/student/academics/exams/results",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const results = await safe("studentResult.findMany", () =>
        prisma.studentResult.findMany({
          where: { studentId: sid, status: { in: VISIBLE_STATUSES as any } },
          orderBy: { createdAt: "desc" },
          select: {
            id: true, totalObtained: true, totalMax: true, percentage: true, grade: true,
            isPassed: true, classRank: true, sectionRank: true, overallRank: true, status: true,
            examConfig: { select: { name: true, startDate: true } },
          },
        }), [] as any[]);

      return reply.send({
        success: true,
        data: {
          results: results.map((r: any) => ({
            id: r.id, examName: r.examConfig?.name, examDate: r.examConfig?.startDate,
            totalObtained: r.totalObtained, totalMax: r.totalMax, percentage: r.percentage,
            grade: r.grade, isPassed: r.isPassed, classRank: r.classRank, status: r.status,
          })),
        },
      });
    }
  );

  // ── GET /student/academics/exams/results/:id — subject breakdown ──
  app.get("/student/academics/exams/results/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { id } = req.params as { id: string };
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const result = await safe("studentResult detail", () =>
        prisma.studentResult.findFirst({
          where: { id: parseInt(id), studentId: sid, status: { in: VISIBLE_STATUSES as any } },
          select: {
            totalObtained: true, totalMax: true, percentage: true, grade: true, gradePoint: true,
            isPassed: true, failedSubjects: true, isCompartment: true,
            classRank: true, sectionRank: true, overallRank: true,
            attendancePct: true, presentDays: true, workingDays: true,
            subjectResults: true, examConfig: { select: { name: true, startDate: true } },
          },
        }), null);
      if (!result) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      return reply.send({ success: true, data: { result } });
    }
  );

  // ── GET /student/academics/exams/report-cards ────────────────
  app.get("/student/academics/exams/report-cards",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const cards = await safe("generatedReportCard.findMany", () =>
        prisma.generatedReportCard.findMany({
          where: { studentId: sid, isPublished: true },
          orderBy: { publishedAt: "desc" },
          select: {
            id: true, pdfUrl: true, qrCode: true, publishedAt: true,
            examConfig: { select: { name: true, startDate: true } },
          },
        }), [] as any[]);

      return reply.send({
        success: true,
        data: { reportCards: cards.map((c: any) => ({ id: c.id, examName: c.examConfig?.name, pdfUrl: c.pdfUrl, publishedAt: c.publishedAt })) },
      });
    }
  );

  // ── GET /student/academics/exams/analytics ───────────────────
  app.get("/student/academics/exams/analytics",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const results = await safe("results for analytics", () =>
        prisma.studentResult.findMany({
          where: { studentId: sid, status: { in: VISIBLE_STATUSES as any } },
          orderBy: { createdAt: "asc" },
          select: { percentage: true, classRank: true, subjectResults: true, examConfig: { select: { name: true, startDate: true } } },
        }), [] as any[]);

      // Percentage trend across exams
      const trend = results.map((r: any) => ({
        examName: r.examConfig?.name, examDate: r.examConfig?.startDate,
        percentage: Number(r.percentage), rank: r.classRank,
      }));

      // Aggregate per-subject average across all exams (subjectResults JSON: [{subjectName, obtained, max}])
      const subjectTotals = new Map<string, { obtained: number; max: number; count: number }>();
      for (const r of results) {
        const subs = Array.isArray(r.subjectResults) ? r.subjectResults : [];
        for (const s of subs as any[]) {
          const key = s.subjectName ?? "Unknown";
          const cur = subjectTotals.get(key) ?? { obtained: 0, max: 0, count: 0 };
          cur.obtained += Number(s.obtained ?? 0);
          cur.max += Number(s.max ?? 0);
          cur.count += 1;
          subjectTotals.set(key, cur);
        }
      }
      const subjectAverages = Array.from(subjectTotals.entries()).map(([name, v]) => ({
        subject: name, avgPct: v.max > 0 ? Math.round((v.obtained / v.max) * 100) : 0,
      })).sort((a, b) => b.avgPct - a.avgPct);

      const overallAvg = trend.length > 0 ? Math.round(trend.reduce((s, t) => s + t.percentage, 0) / trend.length) : 0;
      const bestExam = trend.length > 0 ? trend.reduce((a, b) => (a.percentage > b.percentage ? a : b)) : null;
      const latestRank = trend.length > 0 ? trend[trend.length - 1].rank : null;

      return reply.send({
        success: true,
        data: {
          trend, subjectAverages, overallAvg, bestExam, latestRank,
          strongestSubject: subjectAverages[0] ?? null,
          weakestSubject: subjectAverages[subjectAverages.length - 1] ?? null,
        },
      });
    }
  );
}