import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── Remark Templates ─────────────────────────────────────────
const REMARK_TEMPLATES = [
  "Excellent progress throughout the session. Keep it up!",
  "Has shown great improvement. Encourage to maintain consistency.",
  "Needs to focus more on studies and improve concentration.",
  "Good performance in most subjects. Work harder in weak areas.",
  "Regular attendance and active participation is appreciated.",
  "Has potential but requires more effort and dedication.",
  "Satisfactory performance. Can do better with more practice.",
  "Outstanding student. A role model for peers.",
  "Needs more attention in mathematics and science.",
  "Hardworking student. Consistent efforts visible.",
];

async function addAuditLog(tx: any, reviewId: number, schoolId: number, action: string, description: string, userId: number, metadata?: any) {
  await tx.resultAuditLog.create({
    data: { reviewId, schoolId, action, description, performedById: userId, metadata: metadata ?? null },
  });
}

export async function adminRemarksApprovalRoutes(app: FastifyInstance) {

  // ── GET /admin/remarks/meta ───────────────────────────────
  app.get("/admin/remarks/meta",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const [examConfigs, classes] = await Promise.all([
        prisma.examConfig.findMany({
          where: { schoolId, status: { in: ["ACTIVE","PUBLISHED","COMPLETED"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, name: true, sessionName: true, category: true },
        }),
        prisma.class.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          select: { id: true, name: true, classNumber: true, section: true },
        }),
      ]);

      return reply.send({ success: true, data: { examConfigs, classes, remarkTemplates: REMARK_TEMPLATES } });
    }
  );

  // ── GET /admin/remarks/students ───────────────────────────
  app.get("/admin/remarks/students",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as {
        examConfigId: string; classId: string;
        status?: string; search?: string; page?: string;
      };

      if (!q.examConfigId || !q.classId) {
        return reply.status(400).send({ success: false, message: "examConfigId and classId required." });
      }

      const page = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 20;

      // Get students
      const studentWhere: any = { schoolId, classId: parseInt(q.classId), isActive: true };
      if (q.search) studentWhere.OR = [
        { user: { name: { contains: q.search, mode: "insensitive" } } },
        { rollNumber: { contains: q.search } },
        { admissionNumber: { contains: q.search } },
      ];

      const [students, total] = await Promise.all([
        prisma.student.findMany({
          where: studentWhere, skip: (page-1)*limit, take: limit,
          orderBy: { rollNumber: "asc" },
          include: { user: { select: { id: true, name: true, gender: true, avatarUrl: true } } },
        }),
        prisma.student.count({ where: studentWhere }),
      ]);

      const studentIds = students.map(s => s.id);

      // Get marks summary per student
      const marksEntries = await prisma.marksEntry.findMany({
        where: { schoolId, examConfigId: parseInt(q.examConfigId), studentId: { in: studentIds } },
        include: { examSubject: { include: { subject: { select: { id: true, name: true } } } } },
      });

      // Get existing reviews
      const reviews = await prisma.studentResultReview.findMany({
        where: { schoolId, examConfigId: parseInt(q.examConfigId), studentId: { in: studentIds } },
        include: {
          classTeacher: { select: { name: true } },
          approvedBy: { select: { name: true } },
          subjectRemarks: { include: { subject: { select: { id: true, name: true } } } },
        },
      });

      const reviewMap: Record<number, typeof reviews[0]> = {};
      reviews.forEach(r => { reviewMap[r.studentId] = r; });

      // Attendance
      const attendance = await prisma.attendance.groupBy({
        by: ["studentId", "status"],
        where: { schoolId, studentId: { in: studentIds } },
        _count: true,
      });
      const attMap: Record<number, { present: number; total: number }> = {};
      attendance.forEach(a => {
        if (!attMap[a.studentId]) attMap[a.studentId] = { present: 0, total: 0 };
        attMap[a.studentId].total += a._count;
        if (a.status === "PRESENT") attMap[a.studentId].present += a._count;
      });

      // Build summary
      const studentsWithData = students.map(s => {
        const sMarks = marksEntries.filter(m => m.studentId === s.id);
        const presentMarks = sMarks.filter(m => m.marksStatus === "PRESENT" && m.finalMarks !== null);
        const totalObtained = presentMarks.reduce((sum, m) => sum + Number(m.finalMarks), 0);
        const totalMax = presentMarks.reduce((sum, m) => sum + Number(m.maxMarks), 0);
        const percentage = totalMax > 0 ? Math.round((totalObtained / totalMax) * 100 * 10) / 10 : 0;
        const failedSubjects = presentMarks.filter(m => m.isPassed === false).length;
        const att = attMap[s.id];
        const attPct = att && att.total > 0 ? Math.round((att.present / att.total) * 100) : null;
        const review = reviewMap[s.id] ?? null;

        return {
          id: s.id, userId: s.userId, rollNumber: s.rollNumber,
          admissionNumber: s.admissionNumber, name: s.user.name,
          gender: s.user.gender,
          percentage, totalObtained, totalMax,
          failedSubjects, attendancePct: attPct,
          subjectMarks: sMarks.map(m => ({
            subjectId: m.examSubject.subjectId, subjectName: m.examSubject.subject.name,
            obtained: Number(m.finalMarks ?? 0), max: Number(m.maxMarks),
            grade: m.grade, isPassed: m.isPassed, status: m.marksStatus,
          })),
          review: review ? {
            id: review.id, approvalStatus: review.approvalStatus,
            classTeacherRemarks: review.classTeacherRemarks,
            principalRemarks: review.principalRemarks,
            promotionRecommendation: review.promotionRecommendation,
            isResultHeld: review.isResultHeld, holdReason: review.holdReason,
            parentMeetingRecommended: review.parentMeetingRecommended,
            isLocked: review.isLocked,
            subjectRemarks: review.subjectRemarks,
            classTeacher: review.classTeacher,
            approvedBy: review.approvedBy,
          } : null,
        };
      });

      // Filter by approval status
      const filtered = q.status
        ? studentsWithData.filter(s => s.review?.approvalStatus === q.status || (!s.review && q.status === "DRAFT"))
        : studentsWithData;

      // Pipeline stats
      const pipelineStats = {
        total, draft: reviews.filter(r => r.approvalStatus === "DRAFT").length,
        submitted: reviews.filter(r => r.approvalStatus === "SUBMITTED").length,
        approved: reviews.filter(r => r.approvalStatus === "APPROVED").length,
        rejected: reviews.filter(r => r.approvalStatus === "REJECTED").length,
        published: reviews.filter(r => r.approvalStatus === "PUBLISHED").length,
        pending: total - reviews.filter(r => r.approvalStatus === "APPROVED" || r.approvalStatus === "PUBLISHED").length,
      };

      return reply.send({
        success: true,
        data: { students: filtered, total: filtered.length, pipelineStats },
      });
    }
  );

  // ── POST /admin/remarks/save ──────────────────────────────
  app.post("/admin/remarks/save",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        examConfigId: number; studentId: number; classId: number;
        classTeacherRemarks?: string; principalRemarks?: string;
        behaviourRemarks?: string; internalNotes?: string;
        promotionRecommendation?: string;
        isResultHeld?: boolean; holdReason?: string;
        parentMeetingRecommended?: boolean;
        subjectRemarks?: { subjectId: number; remark: string }[];
      };

      const review = await prisma.$transaction(async (tx) => {
        const existing = await tx.studentResultReview.findFirst({
          where: { examConfigId: body.examConfigId, studentId: body.studentId },
        });

        let rev;
        if (existing) {
          if (existing.isLocked) throw new Error("Review is locked.");
          rev = await tx.studentResultReview.update({
            where: { id: existing.id },
            data: {
              classTeacherRemarks: body.classTeacherRemarks ?? undefined,
              principalRemarks: body.principalRemarks ?? undefined,
              behaviourRemarks: body.behaviourRemarks ?? undefined,
              internalNotes: body.internalNotes ?? undefined,
              promotionRecommendation: body.promotionRecommendation as any ?? undefined,
              isResultHeld: body.isResultHeld ?? undefined,
              holdReason: body.holdReason ?? undefined,
              parentMeetingRecommended: body.parentMeetingRecommended ?? undefined,
              classTeacherId: userId,
            },
          });
        } else {
          rev = await tx.studentResultReview.create({
            data: {
              schoolId, examConfigId: body.examConfigId,
              studentId: body.studentId, classId: body.classId,
              classTeacherRemarks: body.classTeacherRemarks ?? null,
              principalRemarks: body.principalRemarks ?? null,
              behaviourRemarks: body.behaviourRemarks ?? null,
              internalNotes: body.internalNotes ?? null,
              promotionRecommendation: body.promotionRecommendation as any ?? "PROMOTE",
              isResultHeld: body.isResultHeld ?? false,
              holdReason: body.holdReason ?? null,
              parentMeetingRecommended: body.parentMeetingRecommended ?? false,
              classTeacherId: userId,
              approvalStatus: "DRAFT",
            },
          });
        }

        // Subject remarks
        if (body.subjectRemarks?.length) {
          for (const sr of body.subjectRemarks) {
            if (!sr.remark.trim()) continue;
            await tx.subjectRemark.upsert({
              where: { reviewId_subjectId: { reviewId: rev.id, subjectId: sr.subjectId } },
              create: { reviewId: rev.id, subjectId: sr.subjectId, teacherId: userId, remark: sr.remark.trim() },
              update: { remark: sr.remark.trim(), teacherId: userId },
            });
          }
        }

        await addAuditLog(tx, rev.id, schoolId, "REMARK_SAVED", "Remarks updated", userId);
        return rev;
      });

      return reply.send({ success: true, message: "Remarks saved.", data: { reviewId: review.id } });
    }
  );

  // ── POST /admin/remarks/bulk-save ─────────────────────────
  app.post("/admin/remarks/bulk-save",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        examConfigId: number; classId: number;
        studentIds: number[];
        classTeacherRemarks: string;
        promotionRecommendation?: string;
      };

      let saved = 0;
      for (const studentId of body.studentIds) {
        const existing = await prisma.studentResultReview.findFirst({
          where: { examConfigId: body.examConfigId, studentId },
        });
        if (existing?.isLocked) continue;

        if (existing) {
          await prisma.studentResultReview.update({
            where: { id: existing.id },
            data: { classTeacherRemarks: body.classTeacherRemarks, classTeacherId: userId, promotionRecommendation: body.promotionRecommendation as any ?? undefined },
          });
        } else {
          await prisma.studentResultReview.create({
            data: { schoolId, examConfigId: body.examConfigId, studentId, classId: body.classId, classTeacherRemarks: body.classTeacherRemarks, promotionRecommendation: body.promotionRecommendation as any ?? "PROMOTE", classTeacherId: userId, approvalStatus: "DRAFT" },
          });
        }
        saved++;
      }

      return reply.send({ success: true, message: `Bulk remarks applied to ${saved} students.` });
    }
  );

  // ── POST /admin/remarks/:reviewId/submit ──────────────────
  app.post("/admin/remarks/:reviewId/submit",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const { reviewId } = request.params as { reviewId: string };

      const review = await prisma.studentResultReview.findFirst({ where: { id: parseInt(reviewId), schoolId } });
      if (!review) return reply.status(404).send({ success: false, message: "Review not found." });
      if (review.isLocked) return reply.status(400).send({ success: false, message: "Locked." });

      await prisma.$transaction(async (tx) => {
        await tx.studentResultReview.update({
          where: { id: parseInt(reviewId) },
          data: { approvalStatus: "SUBMITTED", submittedAt: new Date() },
        });
        await addAuditLog(tx, parseInt(reviewId), schoolId, "SUBMITTED", "Review submitted for approval", userId);
      });

      return reply.send({ success: true, message: "Submitted for approval." });
    }
  );

  // ── POST /admin/remarks/:reviewId/approve ─────────────────
  app.post("/admin/remarks/:reviewId/approve",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const { reviewId } = request.params as { reviewId: string };
      const { principalRemarks } = request.body as { principalRemarks?: string };

      const review = await prisma.studentResultReview.findFirst({ where: { id: parseInt(reviewId), schoolId } });
      if (!review) return reply.status(404).send({ success: false, message: "Not found." });

      await prisma.$transaction(async (tx) => {
        await tx.studentResultReview.update({
          where: { id: parseInt(reviewId) },
          data: { approvalStatus: "APPROVED", approvedAt: new Date(), approvedById: userId, ...(principalRemarks && { principalRemarks }) },
        });
        await addAuditLog(tx, parseInt(reviewId), schoolId, "APPROVED", "Review approved", userId);
      });

      return reply.send({ success: true, message: "Review approved." });
    }
  );

  // ── POST /admin/remarks/:reviewId/reject ──────────────────
  app.post("/admin/remarks/:reviewId/reject",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const { reviewId } = request.params as { reviewId: string };
      const { reason } = request.body as { reason: string };

      if (!reason?.trim()) return reply.status(400).send({ success: false, message: "Rejection reason required." });

      await prisma.$transaction(async (tx) => {
        await tx.studentResultReview.update({
          where: { id: parseInt(reviewId) },
          data: { approvalStatus: "REJECTED", rejectedAt: new Date(), rejectionReason: reason },
        });
        await addAuditLog(tx, parseInt(reviewId), schoolId, "REJECTED", `Rejected: ${reason}`, userId);
      });

      return reply.send({ success: true, message: "Review rejected." });
    }
  );

  // ── POST /admin/remarks/bulk-approve ─────────────────────
  app.post("/admin/remarks/bulk-approve",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const { reviewIds } = request.body as { reviewIds: number[] };

      await prisma.$transaction(async (tx) => {
        await tx.studentResultReview.updateMany({
          where: { id: { in: reviewIds }, schoolId, isLocked: false },
          data: { approvalStatus: "APPROVED", approvedAt: new Date(), approvedById: userId },
        });
        for (const rid of reviewIds) {
          await addAuditLog(tx, rid, schoolId, "BULK_APPROVED", "Bulk approved", userId);
        }
      });

      return reply.send({ success: true, message: `${reviewIds.length} reviews approved.` });
    }
  );

  // ── POST /admin/remarks/publish ───────────────────────────
  app.post("/admin/remarks/publish",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        examConfigId: number; classId: number;
        studentIds?: number[];
        parentVisible?: boolean;
      };

      const where: any = {
        schoolId, examConfigId: body.examConfigId, classId: body.classId,
        approvalStatus: "APPROVED", isLocked: false,
        ...(body.studentIds ? { studentId: { in: body.studentIds } } : {}),
      };

      const toPublish = await prisma.studentResultReview.findMany({ where, select: { id: true } });

      await prisma.$transaction(async (tx) => {
        await tx.studentResultReview.updateMany({
          where: { id: { in: toPublish.map(r => r.id) } },
          data: { approvalStatus: "PUBLISHED", publishedAt: new Date(), publishedById: userId, isLocked: true },
        });
        for (const r of toPublish) {
          await addAuditLog(tx, r.id, schoolId, "PUBLISHED", "Result published", userId);
        }
      });

      return reply.send({
        success: true,
        message: `${toPublish.length} student results published.`,
        data: { publishedCount: toPublish.length },
      });
    }
  );

  // ── GET /admin/remarks/:reviewId/audit ────────────────────
  app.get("/admin/remarks/:reviewId/audit",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { reviewId } = request.params as { reviewId: string };

      const logs = await prisma.resultAuditLog.findMany({
        where: { reviewId: parseInt(reviewId), schoolId },
        orderBy: { createdAt: "desc" },
        include: { performedBy: { select: { name: true } } },
      });

      return reply.send({ success: true, data: { logs } });
    }
  );

  // ── GET /admin/remarks/analytics ─────────────────────────
  app.get("/admin/remarks/analytics",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { examConfigId: string; classId?: string };

      const where: any = { schoolId, examConfigId: parseInt(q.examConfigId) };
      if (q.classId) where.classId = parseInt(q.classId);

      const [byStatus, byPromotion, recentActivity] = await Promise.all([
        prisma.studentResultReview.groupBy({ by: ["approvalStatus"], where, _count: true }),
        prisma.studentResultReview.groupBy({ by: ["promotionRecommendation"], where, _count: true }),
        prisma.resultAuditLog.findMany({
          where: { schoolId, review: { examConfigId: parseInt(q.examConfigId) } },
          orderBy: { createdAt: "desc" }, take: 10,
          include: { performedBy: { select: { name: true } }, review: { include: { student: { include: { user: { select: { name: true } } } } } } },
        }),
      ]);

      const totalStudents = await prisma.student.count({ where: { schoolId, ...(q.classId ? { classId: parseInt(q.classId) } : {}) } });
      const totalReviewed = await prisma.studentResultReview.count({ where });
      const readinessPct = totalStudents > 0 ? Math.round((totalReviewed / totalStudents) * 100) : 0;

      return reply.send({
        success: true,
        data: {
          byStatus: byStatus.map(b => ({ status: b.approvalStatus, count: b._count })),
          byPromotion: byPromotion.map(b => ({ recommendation: b.promotionRecommendation, count: b._count })),
          recentActivity: recentActivity.map(a => ({
            action: a.action, description: a.description,
            performedBy: a.performedBy.name,
            studentName: a.review.student.user.name,
            at: a.createdAt,
          })),
          readinessPct, totalStudents, totalReviewed,
        },
      });
    }
  );
}
