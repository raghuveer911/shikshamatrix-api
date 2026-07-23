import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── Grade Calculator ──────────────────────────────────────────
async function getGrade(schoolId: number, examConfigId: number, pct: number) {
  const grades = await prisma.gradeScale.findMany({
    where: { schoolId, examConfigId },
    orderBy: { minPercent: "desc" },
  });
  for (const g of grades) {
    if (pct >= Number(g.minPercent) && pct <= Number(g.maxPercent)) {
      return { grade: g.grade, gradePoint: g.gradePoint ? Number(g.gradePoint) : null };
    }
  }
  return { grade: pct >= 33 ? "D" : "E", gradePoint: pct >= 33 ? 4 : 0 };
}

export async function adminGenerateResultsRoutes(app: FastifyInstance) {

  // ── GET /admin/results/meta ───────────────────────────────
  app.get("/admin/results/meta",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [examConfigs, classes] = await Promise.all([
        prisma.examConfig.findMany({
          where: { schoolId, status: { in: ["ACTIVE","PUBLISHED","COMPLETED"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, name: true, sessionName: true, category: true, passingMarks: true },
        }),
        prisma.class.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          select: { id: true, name: true, classNumber: true, section: true,
            _count: { select: { students: { where: { isActive: true } } } } },
        }),
      ]);

      // Dashboard stats
      const [totalStudents, generated, published, pending] = await Promise.all([
        prisma.student.count({ where: { schoolId, isActive: true } }),
        prisma.studentResult.count({ where: { schoolId, status: { notIn: ["DRAFT"] } } }),
        prisma.studentResult.count({ where: { schoolId, status: "PUBLISHED" } }),
        prisma.studentResult.count({ where: { schoolId, status: "DRAFT" } }),
      ]);

      return reply.send({ success: true, data: { examConfigs, classes, dashStats: { totalStudents, generated, published, pending } } });
    }
  );

  // ── POST /admin/results/generate ─────────────────────────
  // Core processing engine
  app.post("/admin/results/generate",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        examConfigId: number;
        classIds: number[];
        rankBy?: "CLASS" | "SECTION" | "OVERALL";
        includeAttendance?: boolean;
        applyCoCurricular?: boolean;
        applyGrace?: boolean;
      };

      if (!body.examConfigId || !body.classIds?.length) {
        return reply.status(400).send({ success: false, message: "examConfigId and classIds required." });
      }

      const examConfig = await prisma.examConfig.findFirst({
        where: { id: body.examConfigId, schoolId },
        select: { id: true, name: true, passingMarks: true, maxCompartments: true },
      });
      if (!examConfig) return reply.status(404).send({ success: false, message: "Exam config not found." });

      const passingPct = Number(examConfig.passingMarks);
      const results: any[] = [];
      const warnings: string[] = [];
      let processed = 0;

      for (const classId of body.classIds) {
        const students = await prisma.student.findMany({
          where: { schoolId, classId, isActive: true },
          include: { user: { select: { name: true } } },
        });

        const marksData = await prisma.marksEntry.findMany({
          where: { schoolId, examConfigId: body.examConfigId, classId },
          include: { examSubject: { include: { subject: { select: { id: true, name: true } } } } },
        });

        // Attendance
        let attMap: Record<number, { present: number; total: number }> = {};
        if (body.includeAttendance !== false) {
          const attData = await prisma.attendance.groupBy({
            by: ["studentId", "status"],
            where: { schoolId, studentId: { in: students.map(s => s.id) } },
            _count: true,
          });
          attData.forEach(a => {
            if (!attMap[a.studentId]) attMap[a.studentId] = { present: 0, total: 0 };
            attMap[a.studentId].total += a._count;
            if (a.status === "PRESENT") attMap[a.studentId].present += a._count;
          });
        }

        // Review data
        const reviews = await prisma.studentResultReview.findMany({
          where: { schoolId, examConfigId: body.examConfigId, classId },
        });
        const reviewMap: Record<number, typeof reviews[0]> = {};
        reviews.forEach(r => { reviewMap[r.studentId] = r; });

        // Process each student
        const classResults: { studentId: number; totalObtained: number; percentage: number }[] = [];

        for (const student of students) {
          const sMarks = marksData.filter(m => m.studentId === student.id);

          if (sMarks.length === 0) {
            warnings.push(`No marks found for ${student.user.name}`);
            continue;
          }

          const presentMarks = sMarks.filter(m => m.marksStatus === "PRESENT" && m.finalMarks !== null);
          const totalObtained = presentMarks.reduce((sum, m) => sum + Number(m.finalMarks), 0);
          const totalMax = presentMarks.reduce((sum, m) => sum + Number(m.maxMarks), 0);
          const percentage = totalMax > 0 ? Math.round((totalObtained / totalMax) * 100 * 100) / 100 : 0;

          const { grade, gradePoint } = await getGrade(schoolId, body.examConfigId, percentage);
          const failedSubjects = presentMarks.filter(m => m.isPassed === false).length;
          const isPassed = percentage >= passingPct && failedSubjects <= (examConfig.maxCompartments ?? 2);
          const isCompartment = !isPassed && failedSubjects > 0 && failedSubjects <= (examConfig.maxCompartments ?? 2);

          // Attendance
          const att = attMap[student.id];
          const attPct = att && att.total > 0 ? Math.round((att.present / att.total) * 100 * 10) / 10 : null;

          // Hold check
          const review = reviewMap[student.id];
          const isHeld = review?.isResultHeld ?? false;
          const holdReason = review?.holdReason ?? null;

          // Subject breakdown
          const subjectResults = sMarks.map(m => ({
            subjectId: m.examSubject.subjectId,
            subjectName: m.examSubject.subject.name,
            obtained: Number(m.finalMarks ?? 0),
            max: Number(m.maxMarks),
            grade: m.grade ?? "",
            isPassed: m.isPassed,
            status: m.marksStatus,
          }));

          classResults.push({ studentId: student.id, totalObtained, percentage });

          // Upsert result
          const existingResult = await prisma.studentResult.findFirst({
            where: { examConfigId: body.examConfigId, studentId: student.id },
          });

          const resultData = {
            totalObtained, totalMax, percentage, grade, gradePoint,
            isPassed, failedSubjects, isCompartment,
            attendancePct: attPct, presentDays: att?.present ?? null, workingDays: att?.total ?? null,
            status: "GENERATED" as const,
            isHeld, holdReason,
            graceMarksApplied: body.applyGrace ?? false,
            generatedById: userId, generatedAt: new Date(),
            subjectResults,
          };

          if (existingResult) {
            await prisma.studentResult.update({ where: { id: existingResult.id }, data: resultData });
            results.push({ ...resultData, id: existingResult.id, studentId: student.id });
          } else {
            const created = await prisma.studentResult.create({
              data: { schoolId, examConfigId: body.examConfigId, studentId: student.id, classId, ...resultData },
            });
            results.push(created);
          }
          processed++;
        }

        // Assign ranks for this class
        const sorted = [...classResults].sort((a, b) => b.totalObtained - a.totalObtained);
        for (let i = 0; i < sorted.length; i++) {
          const rank = i + 1;
          await prisma.studentResult.updateMany({
            where: { examConfigId: body.examConfigId, studentId: sorted[i].studentId },
            data: { classRank: rank },
          });
        }
      }

      return reply.send({
        success: true,
        message: `Results generated for ${processed} students.`,
        data: { processed, warnings, totalWarnings: warnings.length },
      });
    }
  );

  // ── GET /admin/results/list ───────────────────────────────
  app.get("/admin/results/list",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { examConfigId: string; classId?: string; status?: string; search?: string; page?: string; };

      if (!q.examConfigId) return reply.status(400).send({ success: false, message: "examConfigId required." });

      const page = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 20;

      const where: any = { schoolId, examConfigId: parseInt(q.examConfigId) };
      if (q.classId) where.classId = parseInt(q.classId);
      if (q.status) where.status = q.status;
      if (q.search) {
        const ids = await prisma.student.findMany({
          where: { schoolId, user: { name: { contains: q.search, mode: "insensitive" } } },
          select: { id: true },
        });
        where.studentId = { in: ids.map(s => s.id) };
      }

      const [results, total] = await Promise.all([
        prisma.studentResult.findMany({
          where, skip: (page-1)*limit, take: limit,
          orderBy: [{ classRank: "asc" }, { percentage: "desc" }],
          include: {
            student: { include: { user: { select: { id:true, name:true, avatarUrl:true } } } },
            class: { select: { id:true, name:true } },
          },
        }),
        prisma.studentResult.count({ where }),
      ]);

      // Analytics
      const all = await prisma.studentResult.findMany({
        where: { schoolId, examConfigId: parseInt(q.examConfigId), ...(q.classId?{classId:parseInt(q.classId)}:{}) },
        select: { percentage:true, isPassed:true, grade:true, isHeld:true },
      });
      const present = all.filter(r => Number(r.percentage) > 0);
      const pcts = present.map(r => Number(r.percentage));
      const avg = pcts.length > 0 ? Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length*10)/10 : 0;
      const highest = pcts.length > 0 ? Math.max(...pcts) : 0;
      const lowest  = pcts.length > 0 ? Math.min(...pcts) : 0;
      const passCount = all.filter(r => r.isPassed).length;
      const gradeDist: Record<string,number> = {};
      all.forEach(r => { if (r.grade) gradeDist[r.grade] = (gradeDist[r.grade]??0)+1; });

      return reply.send({
        success: true,
        data: {
          results, total, totalPages: Math.ceil(total/limit),
          analytics: { avg, highest, lowest, total: all.length, passed: passCount, failed: all.length-passCount, passPercent: all.length>0?Math.round((passCount/all.length)*100):0, gradeDist },
        },
      });
    }
  );

  // ── GET /admin/results/student/:studentId ─────────────────
  app.get("/admin/results/student/:studentId",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { studentId } = req.params as { studentId: string };
      const { examConfigId } = req.query as { examConfigId: string };

      const result = await prisma.studentResult.findFirst({
        where: { schoolId, studentId: parseInt(studentId), examConfigId: parseInt(examConfigId) },
        include: {
          student: { include: { user: true, class: true, parentDetail: true } },
          class: true,
          generatedBy: { select: { name: true } },
          publishedBy: { select: { name: true } },
        },
      });
      if (!result) return reply.status(404).send({ success: false, message: "Result not found." });

      // Co-curricular
      const session = await prisma.coCurricularSession.findFirst({
        where: { schoolId, classId: result.classId, examConfigId: parseInt(examConfigId) },
      });
      const coAssessments = session ? await prisma.coCurricularAssessment.findMany({
        where: { sessionId: session.id, studentId: parseInt(studentId) },
        include: { category: { select: { name: true, groupName: true } } },
      }) : [];

      // Behaviour
      const behaviourRecords = await prisma.behaviourRecord.findMany({
        where: { schoolId, studentId: parseInt(studentId) },
        orderBy: { behaviourDate: "desc" },
        take: 5,
      });

      // Remarks
      const review = await prisma.studentResultReview.findFirst({
        where: { schoolId, examConfigId: parseInt(examConfigId), studentId: parseInt(studentId) },
      });

      return reply.send({
        success: true,
        data: { result, coAssessments, behaviourRecords, review },
      });
    }
  );

  // ── PATCH /admin/results/:id/hold ─────────────────────────
  app.patch("/admin/results/:id/hold",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { hold, reason } = req.body as { hold: boolean; reason?: string };

      await prisma.studentResult.updateMany({
        where: { id: parseInt(id), schoolId },
        data: { isHeld: hold, holdReason: hold ? (reason ?? "Admin hold") : null },
      });
      return reply.send({ success: true, message: hold ? "Result held." : "Result released." });
    }
  );

  // ── POST /admin/results/publish ───────────────────────────
  app.post("/admin/results/publish",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        examConfigId: number; classIds?: number[];
        studentIds?: number[];
        parentVisible?: boolean; studentVisible?: boolean;
      };

      const where: any = {
        schoolId, examConfigId: body.examConfigId,
        status: { in: ["GENERATED","VERIFIED","APPROVED"] },
        isHeld: false, isLocked: false,
      };
      if (body.classIds?.length) where.classId = { in: body.classIds };
      if (body.studentIds?.length) where.studentId = { in: body.studentIds };

      const count = await prisma.studentResult.updateMany({
        where, data: { status: "PUBLISHED", publishedById: userId, publishedAt: new Date(), isLocked: true },
      });

      return reply.send({ success: true, message: `${count.count} results published.`, data: { published: count.count } });
    }
  );

  // ── POST /admin/results/recalculate ──────────────────────
  app.post("/admin/results/recalculate",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { examConfigId, studentIds } = req.body as { examConfigId: number; studentIds: number[] };

      // Get class IDs from existing results
      const existing = await prisma.studentResult.findMany({
        where: { schoolId, examConfigId, studentId: { in: studentIds } },
        select: { classId: true },
        distinct: ["classId"],
      });
      const classIds = existing.map(e => e.classId);

      // Forward to generate endpoint
      return app.inject({
        method: "POST", url: "/admin/results/generate",
        headers: { authorization: req.headers.authorization ?? "" },
        payload: JSON.stringify({ examConfigId, classIds }),
      }).then(r => reply.status(r.statusCode).send(JSON.parse(r.body)));
    }
  );

  // ── GET /admin/results/merit-list ────────────────────────
  app.get("/admin/results/merit-list",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { examConfigId, classId, limit: lim } = req.query as { examConfigId: string; classId?: string; limit?: string };

      const where: any = { schoolId, examConfigId: parseInt(examConfigId), isPassed: true };
      if (classId) where.classId = parseInt(classId);

      const toppers = await prisma.studentResult.findMany({
        where,
        orderBy: [{ percentage: "desc" }],
        take: parseInt(lim ?? "10"),
        include: {
          student: { include: { user: { select: { name: true, avatarUrl: true } } } },
          class: { select: { name: true } },
        },
      });

      return reply.send({ success: true, data: { toppers } });
    }
  );

  // ── POST /admin/results/lock ──────────────────────────────
  app.post("/admin/results/lock",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { examConfigId, classIds, lock } = req.body as { examConfigId: number; classIds?: number[]; lock: boolean };

      const where: any = { schoolId, examConfigId };
      if (classIds?.length) where.classId = { in: classIds };

      await prisma.studentResult.updateMany({ where, data: { isLocked: lock } });
      return reply.send({ success: true, message: lock ? "Results locked." : "Results unlocked." });
    }
  );

  // ── GET /admin/results/analytics ─────────────────────────
  app.get("/admin/results/analytics",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { examConfigId } = req.query as { examConfigId: string };

      const [byClass, overall] = await Promise.all([
        prisma.studentResult.groupBy({
          by: ["classId"],
          where: { schoolId, examConfigId: parseInt(examConfigId) },
          _avg: { percentage: true },
          _count: true,
        }),
        prisma.studentResult.findMany({
          where: { schoolId, examConfigId: parseInt(examConfigId) },
          select: { percentage: true, isPassed: true, grade: true, classId: true },
        }),
      ]);

      // Enrich class names
      const classIds = byClass.map(b => b.classId);
      const classes = await prisma.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } });
      const classMap: Record<number, string> = {};
      classes.forEach(c => { classMap[c.id] = c.name; });

      const classAnalytics = byClass.map(b => ({
        classId: b.classId,
        className: classMap[b.classId] ?? "?",
        avgPct: Math.round(Number(b._avg.percentage ?? 0) * 10) / 10,
        count: b._count,
      }));

      const pcts = overall.map(r => Number(r.percentage));
      const gradeDist: Record<string, number> = {};
      overall.forEach(r => { if (r.grade) gradeDist[r.grade] = (gradeDist[r.grade] ?? 0) + 1; });

      return reply.send({
        success: true,
        data: {
          classAnalytics,
          overall: {
            total: overall.length,
            passed: overall.filter(r => r.isPassed).length,
            failed: overall.filter(r => !r.isPassed).length,
            avg: pcts.length ? Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length*10)/10 : 0,
            highest: pcts.length ? Math.max(...pcts) : 0,
            lowest: pcts.length ? Math.min(...pcts) : 0,
            gradeDist,
          },
        },
      });
    }
  );
}
