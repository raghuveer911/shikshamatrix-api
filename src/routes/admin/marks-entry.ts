import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── Grade Calculator ──────────────────────────────────────────
async function calculateGrade(schoolId: number, examConfigId: number, percentage: number) {
  const gradeScale = await prisma.gradeScale.findMany({
    where: { schoolId, examConfigId },
    orderBy: { minPercent: "desc" },
  });

  for (const g of gradeScale) {
    if (percentage >= Number(g.minPercent) && percentage <= Number(g.maxPercent)) {
      return { grade: g.grade, gradePoint: g.gradePoint ? Number(g.gradePoint) : null };
    }
  }
  return { grade: "N/A", gradePoint: null };
}

export async function adminMarksEntryRoutes(app: FastifyInstance) {

  // ── GET /admin/marks-entry/meta ───────────────────────────
  app.get("/admin/marks-entry/meta",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const [examConfigs, currentYear] = await Promise.all([
        prisma.examConfig.findMany({
          where: { schoolId, status: { in: ["ACTIVE", "PUBLISHED"] } },
          orderBy: { createdAt: "desc" },
          select: {
            id: true, name: true, sessionName: true, category: true,
            passingMarks: true,
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
          },
        }),
        prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } }),
      ]);

      return reply.send({ success: true, data: { examConfigs, currentSession: currentYear?.name ?? "" } });
    }
  );

  // ── GET /admin/marks-entry/students ───────────────────────
  app.get("/admin/marks-entry/students",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as {
        examConfigId: string; classId: string; examSubjectId: string; search?: string;
      };

      if (!q.examConfigId || !q.classId || !q.examSubjectId) {
        return reply.status(400).send({ success: false, message: "examConfigId, classId, examSubjectId required." });
      }

      // Get exam subject config (for max marks, components)
      const examSubject = await prisma.examSubject.findFirst({
        where: { id: parseInt(q.examSubjectId), schoolId },
        include: {
          subject: { select: { id: true, name: true } },
          components: { orderBy: { serialNumber: "asc" } },
        },
      });
      if (!examSubject) return reply.status(404).send({ success: false, message: "Exam subject not found." });

      const examConfig = await prisma.examConfig.findFirst({
        where: { id: parseInt(q.examConfigId), schoolId },
        select: { passingMarks: true, passingType: true, gradingType: true },
      });

      // Get students
      const where: any = { schoolId, classId: parseInt(q.classId), isActive: true };
      if (q.search) {
        where.OR = [
          { user: { name: { contains: q.search, mode: "insensitive" } } },
          { rollNumber: { contains: q.search } },
          { admissionNumber: { contains: q.search } },
        ];
      }

      const students = await prisma.student.findMany({
        where,
        orderBy: { rollNumber: "asc" },
        include: {
          user: { select: { id: true, name: true, gender: true, avatarUrl: true } },
          parentDetail: { select: { fatherName: true } },
        },
      });

      // Get existing marks entries
      const existingEntries = await prisma.marksEntry.findMany({
        where: { schoolId, examSubjectId: parseInt(q.examSubjectId), studentId: { in: students.map(s => s.id) } },
        include: { componentMarks: true },
      });
      const entryMap: Record<number, typeof existingEntries[0]> = {};
      existingEntries.forEach(e => { entryMap[e.studentId] = e; });

      // Build response
      const studentsWithMarks = students.map(s => ({
        id: s.id,
        userId: s.userId,
        rollNumber: s.rollNumber,
        admissionNumber: s.admissionNumber,
        name: s.user.name,
        gender: s.user.gender,
        fatherName: s.parentDetail?.fatherName ?? "—",
        existing: entryMap[s.id] ? {
          id: entryMap[s.id].id,
          obtainedMarks: Number(entryMap[s.id].obtainedMarks ?? 0),
          finalMarks: Number(entryMap[s.id].finalMarks ?? 0),
          grade: entryMap[s.id].grade,
          gradePoint: entryMap[s.id].gradePoint ? Number(entryMap[s.id].gradePoint) : null,
          isPassed: entryMap[s.id].isPassed,
          marksStatus: entryMap[s.id].marksStatus,
          entryStatus: entryMap[s.id].entryStatus,
          isLocked: entryMap[s.id].isLocked,
          remarks: entryMap[s.id].remarks,
          componentMarks: entryMap[s.id].componentMarks.map(cm => ({
            componentId: cm.componentId, obtainedMarks: Number(cm.obtainedMarks ?? 0),
          })),
        } : null,
      }));

      // Stats
      const entered = existingEntries.length;
      const absent = existingEntries.filter(e => e.marksStatus === "ABSENT").length;
      const present = existingEntries.filter(e => e.marksStatus === "PRESENT");
      const marks = present.map(e => Number(e.obtainedMarks ?? 0)).filter(m => m > 0);
      const avg = marks.length > 0 ? Math.round(marks.reduce((a, b) => a + b, 0) / marks.length) : 0;
      const highest = marks.length > 0 ? Math.max(...marks) : 0;
      const lowest = marks.length > 0 ? Math.min(...marks) : 0;
      const passed = present.filter(e => e.isPassed === true).length;

      return reply.send({
        success: true,
        data: {
          students: studentsWithMarks,
          examSubject: {
            id: examSubject.id,
            subjectName: examSubject.subject.name,
            maxMarks: Number(examSubject.maxMarks),
            minMarks: Number(examSubject.minMarks),
            subjectType: examSubject.subjectType,
            components: examSubject.components.map(c => ({
              id: c.id, name: c.name,
              maxMarks: Number(c.maxMarks), minMarks: Number(c.minMarks),
              weightage: Number(c.weightage),
            })),
          },
          config: { passingMarks: Number(examConfig?.passingMarks ?? 33), gradingType: examConfig?.gradingType },
          stats: { total: students.length, entered, absent, avg, highest, lowest, passed, pending: students.length - entered },
        },
      });
    }
  );

  // ── POST /admin/marks-entry/save ──────────────────────────
  app.post("/admin/marks-entry/save",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        examConfigId: number;
        examSubjectId: number;
        classId: number;
        entries: {
          studentId: number;
          obtainedMarks?: number;
          marksStatus: string;
          remarks?: string;
          graceMarks?: number;
          componentMarks?: { componentId: number; obtainedMarks: number }[];
        }[];
        isDraft?: boolean;
      };

      const examSubject = await prisma.examSubject.findFirst({
        where: { id: body.examSubjectId, schoolId },
        include: { components: true },
      });
      if (!examSubject) return reply.status(404).send({ success: false, message: "Exam subject not found." });

      const examConfig = await prisma.examConfig.findFirst({
        where: { id: body.examConfigId, schoolId },
        select: { passingMarks: true },
      });

      const maxMarks = Number(examSubject.maxMarks);
      const minMarks = Number(examSubject.minMarks);
      const passingPct = Number(examConfig?.passingMarks ?? 33);

      const results = await prisma.$transaction(async (tx) => {
        const saved = [];
        for (const entry of body.entries) {
          // Validate marks
          if (entry.marksStatus === "PRESENT" && entry.obtainedMarks !== undefined) {
            if (entry.obtainedMarks > maxMarks) {
              throw new Error(`Student ${entry.studentId}: Marks ${entry.obtainedMarks} exceed max ${maxMarks}`);
            }
            if (entry.obtainedMarks < 0) {
              throw new Error(`Marks cannot be negative`);
            }
          }

          const isAbsent = entry.marksStatus === "ABSENT";
          const obtainedMarks = isAbsent ? null : (entry.obtainedMarks ?? null);
          const graceMarks = entry.graceMarks ?? 0;
          const finalMarks = obtainedMarks !== null ? obtainedMarks + graceMarks : null;

          // Calculate grade
          let grade: string | null = null;
          let gradePoint: number | null = null;
          let isPassed: boolean | null = null;

          if (finalMarks !== null && !isAbsent) {
            const pct = (finalMarks / maxMarks) * 100;
            const gradeResult = await calculateGrade(schoolId, body.examConfigId, pct);
            grade = gradeResult.grade;
            gradePoint = gradeResult.gradePoint;
            isPassed = pct >= passingPct;
          }

          const entryStatus = body.isDraft ? "DRAFT" : "SUBMITTED";

          const existing = await tx.marksEntry.findFirst({
            where: { examSubjectId: body.examSubjectId, studentId: entry.studentId },
          });

          if (existing) {
            if (existing.isLocked) continue; // Skip locked entries

            const updated = await tx.marksEntry.update({
              where: { id: existing.id },
              data: {
                obtainedMarks: obtainedMarks !== null ? obtainedMarks : undefined,
                maxMarks,
                graceMarks,
                finalMarks,
                grade,
                gradePoint,
                isPassed,
                marksStatus: entry.marksStatus as any,
                entryStatus: entryStatus as any,
                remarks: entry.remarks ?? null,
                lastEditedById: userId,
                lastEditedAt: new Date(),
              },
            });
            saved.push(updated);

            // Update component marks
            if (entry.componentMarks?.length) {
              for (const cm of entry.componentMarks) {
                await tx.componentMark.upsert({
                  where: { marksEntryId_componentId: { marksEntryId: existing.id, componentId: cm.componentId } },
                  create: { marksEntryId: existing.id, componentId: cm.componentId, obtainedMarks: cm.obtainedMarks, maxMarks: examSubject.components.find(c => c.id === cm.componentId)?.maxMarks ?? 0 },
                  update: { obtainedMarks: cm.obtainedMarks },
                });
              }
            }
          } else {
            const created = await tx.marksEntry.create({
              data: {
                schoolId, examConfigId: body.examConfigId,
                examSubjectId: body.examSubjectId, studentId: entry.studentId,
                classId: body.classId, maxMarks,
                obtainedMarks: obtainedMarks !== null ? obtainedMarks : undefined,
                graceMarks, finalMarks, grade, gradePoint, isPassed,
                marksStatus: entry.marksStatus as any,
                entryStatus: entryStatus as any,
                remarks: entry.remarks ?? null,
                enteredById: userId,
              },
            });
            saved.push(created);

            if (entry.componentMarks?.length) {
              await tx.componentMark.createMany({
                data: entry.componentMarks.map(cm => ({
                  marksEntryId: created.id, componentId: cm.componentId,
                  obtainedMarks: cm.obtainedMarks,
                  maxMarks: examSubject.components.find(c => c.id === cm.componentId)?.maxMarks ?? 0,
                })),
              });
            }
          }
        }
        return saved;
      });

      return reply.send({
        success: true,
        message: body.isDraft ? `${results.length} marks saved as draft.` : `${results.length} marks submitted.`,
        data: { saved: results.length },
      });
    }
  );

  // ── POST /admin/marks-entry/lock ──────────────────────────
  app.post("/admin/marks-entry/lock",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as { examSubjectId: number; classId: number; lock: boolean };

      const updated = await prisma.marksEntry.updateMany({
        where: { schoolId, examSubjectId: body.examSubjectId, classId: body.classId },
        data: { isLocked: body.lock, entryStatus: body.lock ? "LOCKED" : "SUBMITTED" },
      });

      return reply.send({ success: true, message: `${updated.count} entries ${body.lock ? "locked" : "unlocked"}.` });
    }
  );

  // ── GET /admin/marks-entry/analytics ─────────────────────
  app.get("/admin/marks-entry/analytics",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { examSubjectId: string; classId?: string };

      const where: any = { schoolId, examSubjectId: parseInt(q.examSubjectId) };
      if (q.classId) where.classId = parseInt(q.classId);

      const entries = await prisma.marksEntry.findMany({
        where,
        include: {
          student: { include: { user: { select: { name: true } } } },
        },
      });

      const present = entries.filter(e => e.marksStatus === "PRESENT" && e.finalMarks !== null);
      const marks = present.map(e => Number(e.finalMarks));
      const max = marks.length > 0 ? Math.max(...marks) : 0;
      const min = marks.length > 0 ? Math.min(...marks) : 0;
      const avg = marks.length > 0 ? Math.round(marks.reduce((a, b) => a + b, 0) / marks.length * 10) / 10 : 0;
      const passed = present.filter(e => e.isPassed === true).length;
      const failed = present.filter(e => e.isPassed === false).length;

      // Grade distribution
      const gradeDist: Record<string, number> = {};
      entries.forEach(e => { if (e.grade) gradeDist[e.grade] = (gradeDist[e.grade] ?? 0) + 1; });

      // Topper
      const topper = entries.find(e => Number(e.finalMarks) === max);

      // Rank list (sorted by marks desc)
      const ranked = [...present]
        .sort((a, b) => Number(b.finalMarks) - Number(a.finalMarks))
        .map((e, i) => ({ rank: i + 1, name: e.student.user.name, marks: Number(e.finalMarks), grade: e.grade }));

      return reply.send({
        success: true,
        data: {
          total: entries.length,
          present: present.length,
          absent: entries.filter(e => e.marksStatus === "ABSENT").length,
          highest: max, lowest: min, average: avg,
          passed, failed,
          passPercent: present.length > 0 ? Math.round((passed / present.length) * 100) : 0,
          gradeDist,
          topper: topper ? { name: topper.student.user.name, marks: max } : null,
          ranked: ranked.slice(0, 10),
        },
      });
    }
  );

  // ── GET /admin/marks-entry/result-sheet ──────────────────
  app.get("/admin/marks-entry/result-sheet",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as { examConfigId: string; classId: string };

      // Get all subjects for this exam + class
      const examClass = await prisma.examClass.findFirst({
        where: { examConfigId: parseInt(q.examConfigId), classId: parseInt(q.classId) },
        include: {
          subjects: {
            include: {
              subject: { select: { id: true, name: true } },
            },
          },
        },
      });
      if (!examClass) return reply.status(404).send({ success: false, message: "Exam class not found." });

      // Get all marks for this class
      const allEntries = await prisma.marksEntry.findMany({
        where: { schoolId, examConfigId: parseInt(q.examConfigId), classId: parseInt(q.classId) },
        include: {
          student: { include: { user: { select: { name: true } } } },
          examSubject: { include: { subject: { select: { id: true, name: true } } } },
        },
      });

      // Group by student
      const byStudent: Record<number, { name: string; subjects: Record<string, any> }> = {};
      allEntries.forEach(e => {
        if (!byStudent[e.studentId]) byStudent[e.studentId] = { name: e.student.user.name, subjects: {} };
        byStudent[e.studentId].subjects[e.examSubject.subject.name] = {
          obtained: Number(e.finalMarks ?? 0), max: Number(e.maxMarks),
          grade: e.grade, isPassed: e.isPassed, status: e.marksStatus,
        };
      });

      return reply.send({ success: true, data: { resultSheet: Object.entries(byStudent).map(([id, data]) => ({ studentId: parseInt(id), ...data })) } });
    }
  );
}
