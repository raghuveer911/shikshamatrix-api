import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── Default Grade Scales ───────────────────────────────────
const CBSE_GRADES = [
  { minPercent: 91, maxPercent: 100, grade: "A1", gradePoint: 10, description: "Outstanding", color: "#10b981" },
  { minPercent: 81, maxPercent: 90,  grade: "A2", gradePoint: 9,  description: "Excellent",   color: "#22c55e" },
  { minPercent: 71, maxPercent: 80,  grade: "B1", gradePoint: 8,  description: "Very Good",   color: "#84cc16" },
  { minPercent: 61, maxPercent: 70,  grade: "B2", gradePoint: 7,  description: "Good",        color: "#eab308" },
  { minPercent: 51, maxPercent: 60,  grade: "C1", gradePoint: 6,  description: "Above Avg",   color: "#f59e0b" },
  { minPercent: 41, maxPercent: 50,  grade: "C2", gradePoint: 5,  description: "Average",     color: "#f97316" },
  { minPercent: 33, maxPercent: 40,  grade: "D",  gradePoint: 4,  description: "Pass",        color: "#ef4444" },
  { minPercent: 0,  maxPercent: 32,  grade: "E",  gradePoint: 0,  description: "Fail",        color: "#dc2626" },
];

function genExamCode(schoolId: number): string {
  const year = new Date().getFullYear();
  const rand = Math.floor(Math.random() * 900) + 100;
  return `EXM-${year}-${rand}`;
}

export async function adminExamConfigRoutes(app: FastifyInstance) {

  // ── GET /admin/exam-config/meta ───────────────────────────
  app.get("/admin/exam-config/meta",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const [currentYear, classes, stats] = await Promise.all([
        prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } }),
        prisma.class.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          select: { id: true, name: true, classNumber: true, section: true, academicYear: true,
            subjects: { where: { isActive: true }, select: { id: true, name: true } } },
        }),
        prisma.examConfig.groupBy({
          by: ["status"], where: { schoolId }, _count: true,
        }),
      ]);

      const statsMap: Record<string, number> = {};
      stats.forEach(s => { statsMap[s.status] = s._count; });

      const examCode = genExamCode(schoolId);

      return reply.send({
        success: true,
        data: {
          currentSession: currentYear?.name ?? "",
          classes,
          examCode,
          stats: {
            total: Object.values(statsMap).reduce((a, b) => a + b, 0),
            draft: statsMap.DRAFT ?? 0,
            active: statsMap.ACTIVE ?? 0,
            published: statsMap.PUBLISHED ?? 0,
            completed: statsMap.COMPLETED ?? 0,
          },
          defaultGrades: CBSE_GRADES,
        },
      });
    }
  );

  // ── GET /admin/exam-config ────────────────────────────────
  app.get("/admin/exam-config",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { page?: string; status?: string; session?: string; search?: string };

      const page = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 12;

      const where: any = { schoolId };
      if (q.status) where.status = q.status;
      if (q.session) where.sessionName = q.session;
      if (q.search) where.name = { contains: q.search, mode: "insensitive" };

      const [exams, total] = await Promise.all([
        prisma.examConfig.findMany({
          where, skip: (page - 1) * limit, take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            createdBy: { select: { name: true } },
            classes: {
              include: { class: { select: { name: true } }, _count: { select: { subjects: true } } },
            },
            _count: { select: { classes: true } },
          },
        }),
        prisma.examConfig.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: { exams, total, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  // ── GET /admin/exam-config/:id ────────────────────────────
  app.get("/admin/exam-config/:id",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const exam = await prisma.examConfig.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          createdBy: { select: { name: true } },
          classes: {
            include: {
              class: { select: { id: true, name: true, classNumber: true, section: true } },
              subjects: {
                include: {
                  subject: { select: { id: true, name: true } },
                  components: { orderBy: { serialNumber: "asc" } },
                },
              },
            },
          },
          gradeScale: { orderBy: { minPercent: "desc" } },
        },
      });

      if (!exam) return reply.status(404).send({ success: false, message: "Exam not found." });
      return reply.send({ success: true, data: { exam } });
    }
  );

  // ── POST /admin/exam-config ───────────────────────────────
  app.post("/admin/exam-config",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        // Step 1
        name: string; examCode?: string; sessionName: string;
        category: string; description?: string;
        startDate?: string; endDate?: string; resultPublishDate?: string;
        status?: string;
        // Step 2 - classes with subjects
        classes: {
          classId: number;
          subjects: {
            subjectId: number; subjectType: string;
            maxMarks: number; minMarks: number;
            includeInResult: boolean; isOptional: boolean;
            components: { name: string; maxMarks: number; minMarks: number; weightage: number; serialNumber: number }[];
          }[];
        }[];
        // Step 4 - grading
        gradingType?: string; passingMarks?: number; passingType?: string;
        maxCompartments?: number; rankBy?: string; minAttendance?: number;
        gradeScale?: { minPercent: number; maxPercent: number; grade: string; gradePoint?: number; description?: string; color?: string }[];
        // Step 5 - result
        includePractical?: boolean; includeCoCurricular?: boolean;
        includeAttendance?: boolean; includeBehaviour?: boolean;
        reportTemplate?: string; autoPublish?: boolean;
        parentVisible?: boolean; scheduledPublishAt?: string;
      };

      if (!body.name?.trim() || !body.sessionName) {
        return reply.status(400).send({ success: false, message: "name and sessionName required." });
      }

      const examCode = body.examCode?.trim() || genExamCode(schoolId);

      // Check duplicate code
      const existing = await prisma.examConfig.findFirst({ where: { schoolId, examCode } });
      if (existing) return reply.status(409).send({ success: false, message: `Exam code "${examCode}" already exists.` });

      const exam = await prisma.$transaction(async (tx) => {
        const exam = await tx.examConfig.create({
          data: {
            schoolId,
            name: body.name.trim(),
            examCode,
            sessionName: body.sessionName,
            category: body.category as any ?? "UNIT_TEST",
            description: body.description ?? null,
            startDate: body.startDate ? new Date(body.startDate) : null,
            endDate: body.endDate ? new Date(body.endDate) : null,
            resultPublishDate: body.resultPublishDate ? new Date(body.resultPublishDate) : null,
            status: body.status as any ?? "DRAFT",
            gradingType: body.gradingType as any ?? "MARKS",
            passingMarks: body.passingMarks ?? 33,
            passingType: body.passingType ?? "OVERALL",
            maxCompartments: body.maxCompartments ?? 2,
            rankBy: body.rankBy ?? "CLASS",
            minAttendance: body.minAttendance ?? 0,
            includePractical: body.includePractical ?? true,
            includeCoCurricular: body.includeCoCurricular ?? false,
            includeAttendance: body.includeAttendance ?? false,
            includeBehaviour: body.includeBehaviour ?? false,
            reportTemplate: body.reportTemplate ?? "DEFAULT",
            autoPublish: body.autoPublish ?? false,
            parentVisible: body.parentVisible ?? false,
            scheduledPublishAt: body.scheduledPublishAt ? new Date(body.scheduledPublishAt) : null,
            createdById: userId,
          },
        });

        // Create class-subject mappings
        for (const cls of (body.classes ?? [])) {
          const examClass = await tx.examClass.create({
            data: { examConfigId: exam.id, schoolId, classId: cls.classId },
          });

          for (const sub of (cls.subjects ?? [])) {
            const examSubject = await tx.examSubject.create({
              data: {
                examClassId: examClass.id, schoolId,
                subjectId: sub.subjectId,
                subjectType: sub.subjectType as any,
                maxMarks: sub.maxMarks,
                minMarks: sub.minMarks,
                includeInResult: sub.includeInResult,
                isOptional: sub.isOptional ?? false,
              },
            });

            if (sub.components?.length) {
              await tx.examComponent.createMany({
                data: sub.components.map((c, i) => ({
                  examSubjectId: examSubject.id,
                  name: c.name, maxMarks: c.maxMarks, minMarks: c.minMarks,
                  weightage: c.weightage, serialNumber: c.serialNumber ?? i + 1,
                })),
              });
            }
          }
        }

        // Grade scale
        const grades = body.gradeScale ?? CBSE_GRADES;
        await tx.gradeScale.createMany({
          data: grades.map(g => ({ ...g, examConfigId: exam.id, schoolId })),
        });

        return exam;
      });

      return reply.status(201).send({
        success: true,
        message: `Exam "${exam.name}" created.`,
        data: { examId: exam.id, examCode: exam.examCode },
      });
    }
  );

  // ── PUT /admin/exam-config/:id ────────────────────────────
  app.put("/admin/exam-config/:id",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as any;

      const exam = await prisma.examConfig.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!exam) return reply.status(404).send({ success: false, message: "Exam not found." });
      if (exam.isLocked) return reply.status(400).send({ success: false, message: "Exam is locked. Unlock before editing." });

      await prisma.$transaction(async (tx) => {
        // Update basic fields
        await tx.examConfig.update({
          where: { id: parseInt(id) },
          data: {
            ...(body.name && { name: body.name.trim() }),
            ...(body.category && { category: body.category }),
            ...(body.description !== undefined && { description: body.description }),
            ...(body.startDate !== undefined && { startDate: body.startDate ? new Date(body.startDate) : null }),
            ...(body.endDate !== undefined && { endDate: body.endDate ? new Date(body.endDate) : null }),
            ...(body.resultPublishDate !== undefined && { resultPublishDate: body.resultPublishDate ? new Date(body.resultPublishDate) : null }),
            ...(body.status && { status: body.status }),
            ...(body.gradingType && { gradingType: body.gradingType }),
            ...(body.passingMarks !== undefined && { passingMarks: body.passingMarks }),
            ...(body.passingType && { passingType: body.passingType }),
            ...(body.maxCompartments !== undefined && { maxCompartments: body.maxCompartments }),
            ...(body.rankBy && { rankBy: body.rankBy }),
            ...(body.minAttendance !== undefined && { minAttendance: body.minAttendance }),
            ...(body.includePractical !== undefined && { includePractical: body.includePractical }),
            ...(body.includeCoCurricular !== undefined && { includeCoCurricular: body.includeCoCurricular }),
            ...(body.includeAttendance !== undefined && { includeAttendance: body.includeAttendance }),
            ...(body.includeBehaviour !== undefined && { includeBehaviour: body.includeBehaviour }),
            ...(body.reportTemplate && { reportTemplate: body.reportTemplate }),
            ...(body.autoPublish !== undefined && { autoPublish: body.autoPublish }),
            ...(body.parentVisible !== undefined && { parentVisible: body.parentVisible }),
          },
        });

        // Update classes if provided
        if (body.classes) {
          // Delete and recreate
          const existingClasses = await tx.examClass.findMany({ where: { examConfigId: parseInt(id) } });
          for (const ec of existingClasses) {
            await tx.examClass.delete({ where: { id: ec.id } });
          }
          for (const cls of body.classes) {
            const examClass = await tx.examClass.create({
              data: { examConfigId: parseInt(id), schoolId, classId: cls.classId },
            });
            for (const sub of (cls.subjects ?? [])) {
              const es = await tx.examSubject.create({
                data: { examClassId: examClass.id, schoolId, subjectId: sub.subjectId, subjectType: sub.subjectType, maxMarks: sub.maxMarks, minMarks: sub.minMarks, includeInResult: sub.includeInResult, isOptional: sub.isOptional ?? false },
              });
              if (sub.components?.length) {
                await tx.examComponent.createMany({
                  data: sub.components.map((c: any, i: number) => ({ examSubjectId: es.id, name: c.name, maxMarks: c.maxMarks, minMarks: c.minMarks, weightage: c.weightage, serialNumber: c.serialNumber ?? i+1 })),
                });
              }
            }
          }
        }

        // Update grade scale if provided
        if (body.gradeScale) {
          await tx.gradeScale.deleteMany({ where: { examConfigId: parseInt(id) } });
          await tx.gradeScale.createMany({ data: body.gradeScale.map((g: any) => ({ ...g, examConfigId: parseInt(id), schoolId })) });
        }
      });

      return reply.send({ success: true, message: "Exam updated." });
    }
  );

  // ── PATCH /admin/exam-config/:id/publish ─────────────────
  app.patch("/admin/exam-config/:id/publish",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const exam = await prisma.examConfig.findFirst({
        where: { id: parseInt(id), schoolId },
        include: { classes: { include: { subjects: true } } },
      });
      if (!exam) return reply.status(404).send({ success: false, message: "Not found." });

      // Validation
      const errors: string[] = [];
      if (exam.classes.length === 0) errors.push("No classes added.");
      exam.classes.forEach(cls => {
        if (cls.subjects.length === 0) errors.push(`Class ${cls.classId} has no subjects.`);
      });
      if (errors.length > 0) return reply.status(400).send({ success: false, message: "Validation failed.", errors });

      await prisma.examConfig.update({
        where: { id: parseInt(id) },
        data: { status: "PUBLISHED", parentVisible: true },
      });

      return reply.send({ success: true, message: `"${exam.name}" published.` });
    }
  );

  // ── PATCH /admin/exam-config/:id/lock ────────────────────
  app.patch("/admin/exam-config/:id/lock",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const { lock } = request.body as { lock: boolean };

      const exam = await prisma.examConfig.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!exam) return reply.status(404).send({ success: false, message: "Not found." });

      await prisma.examConfig.update({ where: { id: parseInt(id) }, data: { isLocked: lock } });
      return reply.send({ success: true, message: lock ? "Exam locked." : "Exam unlocked." });
    }
  );

  // ── POST /admin/exam-config/:id/clone ────────────────────
  app.post("/admin/exam-config/:id/clone",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const { id } = request.params as { id: string };
      const { name, sessionName } = request.body as { name?: string; sessionName?: string };

      const source = await prisma.examConfig.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          classes: { include: { subjects: { include: { components: true } } } },
          gradeScale: true,
        },
      });
      if (!source) return reply.status(404).send({ success: false, message: "Exam not found." });

      const newCode = genExamCode(schoolId);
      const clonedExam = await prisma.$transaction(async (tx) => {
        const ne = await tx.examConfig.create({
          data: {
            schoolId, createdById: userId,
            name: name ?? `${source.name} (Copy)`,
            examCode: newCode,
            sessionName: sessionName ?? source.sessionName,
            category: source.category, description: source.description,
            status: "DRAFT", gradingType: source.gradingType,
            passingMarks: source.passingMarks, passingType: source.passingType,
            maxCompartments: source.maxCompartments, rankBy: source.rankBy,
            minAttendance: source.minAttendance, includePractical: source.includePractical,
            includeCoCurricular: source.includeCoCurricular, includeAttendance: source.includeAttendance,
            includeBehaviour: source.includeBehaviour, reportTemplate: source.reportTemplate,
            clonedFromId: source.id,
          },
        });

        for (const cls of source.classes) {
          const ec = await tx.examClass.create({ data: { examConfigId: ne.id, schoolId, classId: cls.classId } });
          for (const sub of cls.subjects) {
            const es = await tx.examSubject.create({
              data: { examClassId: ec.id, schoolId, subjectId: sub.subjectId, subjectType: sub.subjectType, maxMarks: sub.maxMarks, minMarks: sub.minMarks, includeInResult: sub.includeInResult, isOptional: sub.isOptional },
            });
            if (sub.components.length > 0) {
              await tx.examComponent.createMany({ data: sub.components.map(c => ({ examSubjectId: es.id, name: c.name, maxMarks: c.maxMarks, minMarks: c.minMarks, weightage: c.weightage, serialNumber: c.serialNumber })) });
            }
          }
        }

        await tx.gradeScale.createMany({ data: source.gradeScale.map(g => ({ examConfigId: ne.id, schoolId, minPercent: g.minPercent, maxPercent: g.maxPercent, grade: g.grade, gradePoint: g.gradePoint, description: g.description, color: g.color })) });

        return ne;
      });

      return reply.status(201).send({ success: true, message: "Exam cloned.", data: { examId: clonedExam.id } });
    }
  );

  // ── DELETE /admin/exam-config/:id ─────────────────────────
  app.delete("/admin/exam-config/:id",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const exam = await prisma.examConfig.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!exam) return reply.status(404).send({ success: false, message: "Not found." });
      if (exam.status !== "DRAFT") return reply.status(400).send({ success: false, message: "Only DRAFT exams can be deleted." });

      await prisma.examConfig.delete({ where: { id: parseInt(id) } });
      return reply.send({ success: true, message: "Exam deleted." });
    }
  );
}
