import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── Default Categories ──────────────────────────────────────
const DEFAULT_CATEGORIES = [
  // Behaviour
  { name: "Discipline",       groupName: "Behaviour",       gradeType: "DESCRIPTIVE", color: "#ef4444", icon: "shield", serialNumber: 1 },
  { name: "Punctuality",      groupName: "Behaviour",       gradeType: "DESCRIPTIVE", color: "#f97316", icon: "clock",  serialNumber: 2 },
  { name: "Respect",          groupName: "Behaviour",       gradeType: "DESCRIPTIVE", color: "#f59e0b", icon: "heart",  serialNumber: 3 },
  { name: "Responsibility",   groupName: "Behaviour",       gradeType: "DESCRIPTIVE", color: "#eab308", icon: "star",   serialNumber: 4 },
  // Communication
  { name: "Speaking",         groupName: "Communication",   gradeType: "GRADES",      color: "#22c55e", icon: "mic",    serialNumber: 5 },
  { name: "Confidence",       groupName: "Communication",   gradeType: "GRADES",      color: "#10b981", icon: "zap",    serialNumber: 6 },
  // Co-Curricular
  { name: "Sports",           groupName: "Co-Curricular",   gradeType: "GRADES",      color: "#06b6d4", icon: "trophy", serialNumber: 7 },
  { name: "Music",            groupName: "Co-Curricular",   gradeType: "GRADES",      color: "#6366f1", icon: "music",  serialNumber: 8 },
  { name: "Art",              groupName: "Co-Curricular",   gradeType: "GRADES",      color: "#8b5cf6", icon: "palette",serialNumber: 9 },
  // Life Skills
  { name: "Leadership",       groupName: "Life Skills",     gradeType: "DESCRIPTIVE", color: "#0ea5e9", icon: "users",  serialNumber: 10 },
  { name: "Teamwork",         groupName: "Life Skills",     gradeType: "DESCRIPTIVE", color: "#84cc16", icon: "handshake", serialNumber: 11 },
  { name: "Creativity",       groupName: "Life Skills",     gradeType: "DESCRIPTIVE", color: "#d946ef", icon: "lightbulb", serialNumber: 12 },
  // Work Habits
  { name: "Homework",         groupName: "Work Habits",     gradeType: "GRADES",      color: "#f472b6", icon: "book",   serialNumber: 13 },
  { name: "Participation",    groupName: "Work Habits",     gradeType: "GRADES",      color: "#fb923c", icon: "hand",   serialNumber: 14 },
];

const GRADE_OPTIONS: Record<string, string[]> = {
  GRADES:      ["A+", "A", "B+", "B", "C", "D"],
  DESCRIPTIVE: ["Excellent", "Very Good", "Good", "Average", "Needs Improvement"],
  STARS:       ["5", "4", "3", "2", "1"],
  POINTS:      [],  // numeric input
};

const ACHIEVEMENT_TAGS = [
  "Best Speaker", "Sports Captain", "Creative Thinker", "Class Monitor",
  "Best Discipline", "Cultural Leader", "Academic Excellence", "Sports Champion",
  "Art Enthusiast", "Team Player", "Science Star", "Leadership Award",
];

export async function adminCoCurricularRoutes(app: FastifyInstance) {

  // ── GET /admin/co-curricular/meta ─────────────────────────
  app.get("/admin/co-curricular/meta",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const [categories, examConfigs, classes, currentYear] = await Promise.all([
        prisma.coCurricularCategory.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ groupName: "asc" }, { serialNumber: "asc" }],
        }),
        prisma.examConfig.findMany({
          where: { schoolId, status: { in: ["ACTIVE", "PUBLISHED"] } },
          select: { id: true, name: true, sessionName: true },
          orderBy: { createdAt: "desc" },
        }),
        prisma.class.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          select: { id: true, name: true, classNumber: true, section: true },
        }),
        prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } }),
      ]);

      return reply.send({
        success: true,
        data: {
          categories,
          gradeOptions: GRADE_OPTIONS,
          examConfigs, classes,
          currentSession: currentYear?.name ?? "",
          achievementTags: ACHIEVEMENT_TAGS,
          hasDefaultCategories: categories.length > 0,
        },
      });
    }
  );

  // ── POST /admin/co-curricular/setup-defaults ──────────────
  app.post("/admin/co-curricular/setup-defaults",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const existing = await prisma.coCurricularCategory.count({ where: { schoolId } });
      if (existing > 0) return reply.send({ success: true, message: "Categories already exist." });

      await prisma.coCurricularCategory.createMany({
        data: DEFAULT_CATEGORIES.map(c => ({ ...c, schoolId, gradeType: c.gradeType as any })),
      });

      return reply.send({ success: true, message: `${DEFAULT_CATEGORIES.length} default categories created.` });
    }
  );

  // ── GET /admin/co-curricular/categories ───────────────────
  app.get("/admin/co-curricular/categories",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const cats = await prisma.coCurricularCategory.findMany({
        where: { schoolId },
        orderBy: [{ groupName: "asc" }, { serialNumber: "asc" }],
      });
      return reply.send({ success: true, data: { categories: cats } });
    }
  );

  // ── POST /admin/co-curricular/categories ──────────────────
  app.post("/admin/co-curricular/categories",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as {
        name: string; groupName: string; gradeType: string;
        includeInReport?: boolean; weightage?: number; maxPoints?: number;
        color?: string; icon?: string;
      };

      const cat = await prisma.coCurricularCategory.create({
        data: {
          schoolId, name: body.name, groupName: body.groupName,
          gradeType: body.gradeType as any,
          includeInReport: body.includeInReport ?? true,
          weightage: body.weightage ?? 0,
          maxPoints: body.maxPoints ?? null,
          color: body.color ?? "#6366f1",
          icon: body.icon ?? null,
          serialNumber: await prisma.coCurricularCategory.count({ where: { schoolId } }) + 1,
        },
      });
      return reply.status(201).send({ success: true, data: { category: cat } });
    }
  );

  // ── DELETE /admin/co-curricular/categories/:id ────────────
  app.delete("/admin/co-curricular/categories/:id",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      await prisma.coCurricularCategory.updateMany({
        where: { id: parseInt(id), schoolId },
        data: { isActive: false },
      });
      return reply.send({ success: true, message: "Category hidden." });
    }
  );

  // ── GET /admin/co-curricular/session ──────────────────────
  // Get or create session for exam+class
  app.get("/admin/co-curricular/session",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { examConfigId?: string; classId: string; sessionName?: string };

      const where: any = { schoolId, classId: parseInt(q.classId) };
      if (q.examConfigId) where.examConfigId = parseInt(q.examConfigId);

      const session = await prisma.coCurricularSession.findFirst({
        where,
        include: {
          createdBy: { select: { name: true } },
          _count: { select: { assessments: true } },
        },
      });

      return reply.send({ success: true, data: { session } });
    }
  );

  // ── POST /admin/co-curricular/session ─────────────────────
  app.post("/admin/co-curricular/session",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as { examConfigId?: number; classId: number; sessionName: string; };

      const existing = await prisma.coCurricularSession.findFirst({
        where: { schoolId, classId: body.classId, ...(body.examConfigId ? { examConfigId: body.examConfigId } : {}) },
      });
      if (existing) return reply.send({ success: true, data: { session: existing } });

      const session = await prisma.coCurricularSession.create({
        data: {
          schoolId, classId: body.classId,
          examConfigId: body.examConfigId ?? null,
          sessionName: body.sessionName, status: "DRAFT", createdById: userId,
        },
      });
      return reply.status(201).send({ success: true, data: { session } });
    }
  );

  // ── GET /admin/co-curricular/students ─────────────────────
  app.get("/admin/co-curricular/students",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { sessionId: string; search?: string };

      const session = await prisma.coCurricularSession.findFirst({
        where: { id: parseInt(q.sessionId), schoolId },
      });
      if (!session) return reply.status(404).send({ success: false, message: "Session not found." });

      const students = await prisma.student.findMany({
        where: {
          schoolId, classId: session.classId, isActive: true,
          ...(q.search ? { OR: [
            { user: { name: { contains: q.search, mode: "insensitive" } } },
            { rollNumber: { contains: q.search } },
          ]} : {}),
        },
        orderBy: { rollNumber: "asc" },
        include: { user: { select: { id: true, name: true, gender: true, avatarUrl: true } } },
      });

      // Existing assessments
      const existingAssessments = await prisma.coCurricularAssessment.findMany({
        where: { sessionId: parseInt(q.sessionId), schoolId },
        include: { category: { select: { id: true, name: true, groupName: true } } },
      });

      // Existing detailed
      const existingDetailed = await prisma.studentDetailedAssessment.findMany({
        where: { sessionId: parseInt(q.sessionId), schoolId },
      });

      // Build map
      const assessmentMap: Record<string, { grade?: string; points?: number; remarks?: string }> = {};
      existingAssessments.forEach(a => {
        assessmentMap[`${a.studentId}_${a.categoryId}`] = { grade: a.grade ?? undefined, points: a.points ?? undefined, remarks: a.remarks ?? undefined };
      });
      const detailedMap: Record<number, typeof existingDetailed[0]> = {};
      existingDetailed.forEach(d => { detailedMap[d.studentId] = d; });

      const studentsWithGrades = students.map(s => ({
        id: s.id, userId: s.userId, rollNumber: s.rollNumber,
        admissionNumber: s.admissionNumber, name: s.user.name, gender: s.user.gender,
        grades: assessmentMap,
        detailed: detailedMap[s.id] ?? null,
      }));

      // Stats
      const categories = await prisma.coCurricularCategory.findMany({ where: { schoolId, isActive: true } });
      const totalPossible = students.length * categories.length;
      const totalFilled = existingAssessments.length;

      return reply.send({
        success: true,
        data: {
          students: studentsWithGrades,
          session,
          stats: { total: students.length, filled: totalFilled, possible: totalPossible, completion: totalPossible > 0 ? Math.round((totalFilled / totalPossible) * 100) : 0 },
        },
      });
    }
  );

  // ── POST /admin/co-curricular/save ────────────────────────
  app.post("/admin/co-curricular/save",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        sessionId: number;
        entries: { studentId: number; categoryId: number; grade?: string; points?: number; remarks?: string }[];
      };

      await prisma.$transaction(
        body.entries.map(e =>
          prisma.coCurricularAssessment.upsert({
            where: { sessionId_categoryId_studentId: { sessionId: body.sessionId, categoryId: e.categoryId, studentId: e.studentId } },
            create: { schoolId, sessionId: body.sessionId, categoryId: e.categoryId, studentId: e.studentId, grade: e.grade ?? null, points: e.points ?? null, remarks: e.remarks ?? null, enteredById: userId },
            update: { grade: e.grade ?? null, points: e.points ?? null, remarks: e.remarks ?? null, enteredById: userId },
          })
        )
      );

      return reply.send({ success: true, message: `${body.entries.length} assessments saved.` });
    }
  );

  // ── POST /admin/co-curricular/detailed ───────────────────
  app.post("/admin/co-curricular/detailed",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as {
        sessionId: number; studentId: number;
        strengths?: string; areasOfImprovement?: string;
        teacherRemarks?: string; parentRecommendation?: string;
        counsellingNotes?: string; achievementTags?: string[];
      };

      const record = await prisma.studentDetailedAssessment.upsert({
        where: { studentId: body.studentId },
        create: { schoolId, sessionId: body.sessionId, studentId: body.studentId, strengths: body.strengths ?? null, areasOfImprovement: body.areasOfImprovement ?? null, teacherRemarks: body.teacherRemarks ?? null, parentRecommendation: body.parentRecommendation ?? null, counsellingNotes: body.counsellingNotes ?? null, achievementTags: body.achievementTags ?? [] },
        update: { strengths: body.strengths ?? null, areasOfImprovement: body.areasOfImprovement ?? null, teacherRemarks: body.teacherRemarks ?? null, parentRecommendation: body.parentRecommendation ?? null, counsellingNotes: body.counsellingNotes ?? null, achievementTags: body.achievementTags ?? [] },
      });

      return reply.send({ success: true, data: { record } });
    }
  );

  // ── PATCH /admin/co-curricular/session/:id/publish ────────
  app.patch("/admin/co-curricular/session/:id/publish",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const session = await prisma.coCurricularSession.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!session) return reply.status(404).send({ success: false, message: "Not found." });

      await prisma.$transaction([
        prisma.coCurricularSession.update({ where: { id: parseInt(id) }, data: { status: "PUBLISHED", publishedAt: new Date() } }),
        prisma.coCurricularAssessment.updateMany({ where: { sessionId: parseInt(id) }, data: { isLocked: true } }),
      ]);

      return reply.send({ success: true, message: "Assessment published and locked." });
    }
  );

  // ── GET /admin/co-curricular/analytics ───────────────────
  app.get("/admin/co-curricular/analytics",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { sessionId: string };

      const assessments = await prisma.coCurricularAssessment.findMany({
        where: { sessionId: parseInt(q.sessionId), schoolId },
        include: {
          category: { select: { name: true, groupName: true, color: true } },
          student: { include: { user: { select: { name: true } } } },
        },
      });

      // Grade distribution per category
      const byCategory: Record<string, Record<string, number>> = {};
      assessments.forEach(a => {
        if (!byCategory[a.category.name]) byCategory[a.category.name] = {};
        const g = a.grade ?? "Not Graded";
        byCategory[a.category.name][g] = (byCategory[a.category.name][g] ?? 0) + 1;
      });

      // Top performers (students with most "Excellent" or "A" grades)
      const topStudents: Record<number, { name: string; excellentCount: number }> = {};
      assessments.forEach(a => {
        if (a.grade === "Excellent" || a.grade === "A" || a.grade === "A+") {
          if (!topStudents[a.studentId]) topStudents[a.studentId] = { name: a.student.user.name, excellentCount: 0 };
          topStudents[a.studentId].excellentCount++;
        }
      });
      const topList = Object.values(topStudents).sort((a, b) => b.excellentCount - a.excellentCount).slice(0, 5);

      // Detailed tags
      const detailedRecords = await prisma.studentDetailedAssessment.findMany({
        where: { sessionId: parseInt(q.sessionId), schoolId },
        select: { achievementTags: true, student: { select: { user: { select: { name: true } } } } },
      });
      const tagDist: Record<string, number> = {};
      detailedRecords.forEach(d => d.achievementTags.forEach(t => { tagDist[t] = (tagDist[t] ?? 0) + 1; }));

      return reply.send({
        success: true,
        data: { byCategory, topPerformers: topList, tagDistribution: tagDist },
      });
    }
  );
}
