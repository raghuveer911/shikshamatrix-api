import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { z } from "zod";

const saveMarksSchema = z.object({
  examSubjectId: z.number(),
  classId:       z.number(),
  entries: z.array(z.object({
    studentId:     z.number(),
    obtainedMarks: z.number().nullable(),
    marksStatus:   z.enum(["PRESENT", "ABSENT", "EXEMPTED"]).default("PRESENT"),
    remarks:       z.string().optional(),
  })),
});

export async function academicsMarksRoutes(app: FastifyInstance) {

  // ── GET /academics/exams — Active exams for teacher ────────
  app.get("/academics/exams",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;

      const exams = await prisma.examConfig.findMany({
        where: {
          schoolId,
          status: { in: ["ACTIVE", "MARKS_ENTRY", "PUBLISHED"] },
        },
        orderBy: { startDate: "desc" },
        select: {
          id:          true,
          name:        true,
          examCode:    true,
          category:    true,
          sessionName: true,
          startDate:   true,
          endDate:     true,
          status:      true,
        },
      });

      return reply.send({ success: true, data: { exams } });
    }
  );

  // ── GET /academics/exams/:examId/classes — Classes in exam ─
  app.get("/academics/exams/:examId/classes",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { examId } = req.params as { examId: string };

      // Teacher ke assigned classes jo is exam mein hain
      const examClasses = await prisma.examClass.findMany({
        where: {
          examConfigId: parseInt(examId),
          schoolId,
        },
        select: {
          id:    true,
          class: {
            select: {
              id:          true,
              name:        true,
              section:     true,
              classNumber: true,
            },
          },
          subjects: {
            select: {
              id:      true,
              subject: { select: { id: true, name: true, code: true } },
              maxMarks: true,
              minMarks: true,
            },
          },
        },
      });

      return reply.send({ success: true, data: { classes: examClasses } });
    }
  );

  // ── GET /academics/marks/entry — Students for marks entry ──
  app.get("/academics/marks/entry",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { examSubjectId, classId } =
        req.query as { examSubjectId: string; classId: string };

      // Exam subject info
      const examSubject = await prisma.examSubject.findUnique({
        where: { id: parseInt(examSubjectId) },
        select: {
          id:      true,
          maxMarks: true,
          minMarks: true,
          subject: { select: { name: true, code: true } },
          examClass: {
            select: {
              examConfig: { select: { name: true, isLocked: true } },
            },
          },
        },
      });
      if (!examSubject) {
        return reply.status(404).send({ success: false, error: "EXAM_SUBJECT_NOT_FOUND" });
      }

      // Students of the class
      const students = await prisma.student.findMany({
        where:   { schoolId, classId: parseInt(classId), isActive: true },
        orderBy: { rollNumber: "asc" },
        select: {
          id:         true,
          rollNumber: true,
          user:       { select: { name: true } },
        },
      });

      // Existing marks entries
      const existing = await prisma.marksEntry.findMany({
        where: {
          examSubjectId: parseInt(examSubjectId),
          classId:       parseInt(classId),
          schoolId,
        },
        select: {
          studentId:     true,
          obtainedMarks: true,
          marksStatus:   true,
          remarks:       true,
          isLocked:      true,
        },
      });

      const marksMap = new Map(existing.map((e) => [e.studentId, e]));

      return reply.send({
        success: true,
        data: {
          examSubject,
          isLocked: examSubject.examClass.examConfig.isLocked,
          students: students.map((s) => {
            const entry = marksMap.get(s.id);
            return {
              id:           s.id,
              name:         s.user.name,
              rollNumber:   s.rollNumber,
              obtainedMarks: entry?.obtainedMarks ?? null,
              marksStatus:   entry?.marksStatus   ?? "PRESENT",
              remarks:       entry?.remarks        ?? null,
              isLocked:      entry?.isLocked       ?? false,
            };
          }),
        },
      });
    }
  );

  // ── POST /academics/marks/save — Save marks ─────────────────
  app.post("/academics/marks/save",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req as any;

      const parsed = saveMarksSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.errors[0]?.message,
        });
      }

      const { examSubjectId, classId, entries } = parsed.data;

      // Get examConfigId from examSubject
      const examSubject = await prisma.examSubject.findUnique({
        where:  { id: examSubjectId },
        select: {
          id:       true,
          maxMarks: true,
          isLocked: false,
          examClass: { select: { examConfigId: true, examConfig: { select: { isLocked: true } } } },
        },
      });

      if (!examSubject) {
        return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      }
      if (examSubject.examClass.examConfig.isLocked) {
        return reply.status(403).send({ success: false, error: "EXAM_LOCKED" });
      }

      const examConfigId = examSubject.examClass.examConfigId;

      await Promise.all(
        entries.map((e) =>
          prisma.marksEntry.upsert({
            where: { examSubjectId_studentId: { examSubjectId, studentId: e.studentId } },
            update: {
              obtainedMarks: e.obtainedMarks,
              finalMarks:    e.obtainedMarks,
              marksStatus:   e.marksStatus,
              remarks:       e.remarks ?? null,
              maxMarks:      examSubject.maxMarks,
              entryStatus:   "DRAFT",
              lastEditedById: userId,
              lastEditedAt:  new Date(),
            },
            create: {
              schoolId,
              examConfigId,
              examSubjectId,
              studentId:     e.studentId,
              classId,
              obtainedMarks: e.obtainedMarks,
              finalMarks:    e.obtainedMarks,
              marksStatus:   e.marksStatus,
              remarks:       e.remarks ?? null,
              maxMarks:      examSubject.maxMarks,
              entryStatus:   "DRAFT",
              enteredById:   userId,
            },
          })
        )
      );

      return reply.send({
        success: true,
        message: `Marks saved for ${entries.length} students`,
      });
    }
  );
}
