// apps/api/src/routes/student/academics-assignments.ts
//
// Shared handler for Homework / Assignments / Projects — all use the
// SAME StudyAssignment model, partitioned by `type`:
//   Homework    -> type: HOMEWORK
//   Projects    -> type: PROJECT
//   Assignments -> everything else (WORKSHEET, PRACTICAL, PRESENTATION,
//                  RESEARCH_WORK, CLASSWORK) — no literal "ASSIGNMENT"
//                  enum value exists, so this partitions the remainder.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/assignments] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function getStudent(userId: number, schoolId: number) {
  return safe("student lookup", () =>
    prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true, classId: true } }), null);
}

const ASSIGNMENT_OTHER_TYPES = ["WORKSHEET", "PRACTICAL", "PRESENTATION", "RESEARCH_WORK", "CLASSWORK"];

export async function studentAssignmentsRoutes(app: FastifyInstance) {

  // ── GET /student/academics/assignments?category=homework|assignments|projects ──
  app.get("/student/academics/assignments",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { category = "homework" } = req.query as { category?: string };

      const student = await getStudent(userId, schoolId);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const typeFilter =
        category === "projects" ? { type: "PROJECT" } :
        category === "assignments" ? { type: { in: ASSIGNMENT_OTHER_TYPES } } :
        { type: "HOMEWORK" };

      const assignments = await safe("assignments", () =>
        prisma.studyAssignment.findMany({
          where: { schoolId, classId: student.classId, isActive: true, ...typeFilter },
          orderBy: { dueDate: "asc" },
          select: {
            id: true, title: true, instructions: true, totalMarks: true, dueDate: true, type: true,
            subject: { select: { id: true, name: true } },
            chapter: { select: { name: true } },
            submissions: { where: { studentId: student.id }, select: { id: true, status: true, marks: true, submittedAt: true, isLate: true } },
          },
        }), [] as any[]);

      const now = new Date();
      const mapped = assignments.map((a: any) => {
        const sub = a.submissions[0] ?? null;
        return {
          id: a.id, title: a.title, totalMarks: a.totalMarks, dueDate: a.dueDate, type: a.type,
          subjectName: a.subject?.name ?? "—", chapterName: a.chapter?.name ?? null,
          isOverdue: a.dueDate ? new Date(a.dueDate) < now && !sub : false,
          submission: sub ? { id: sub.id, status: sub.status, marks: sub.marks, submittedAt: sub.submittedAt, isLate: sub.isLate } : null,
        };
      });

      return reply.send({ success: true, data: { assignments: mapped } });
    }
  );

  // ── GET /student/academics/assignments/:id — detail + own submission ──
  app.get("/student/academics/assignments/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { id } = req.params as { id: string };
      const aid = parseInt(id);

      const student = await getStudent(userId, schoolId);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const assignment = await safe("assignment detail", () =>
        prisma.studyAssignment.findFirst({
          where: { id: aid, schoolId, classId: student.classId },
          select: {
            id: true, title: true, instructions: true, totalMarks: true, dueDate: true, type: true,
            subject: { select: { name: true } }, chapter: { select: { name: true } }, topic: { select: { name: true } },
            createdBy: { select: { user: { select: { id: true, name: true } } } }, // ← added id: true
            materials: { select: { material: { select: { id: true, title: true, fileUrl: true, type: true } } } },
        },
        }), null);
      if (!assignment) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      const submission = await safe("own submission", () =>
        prisma.studyAssignmentSubmission.findFirst({
          where: { assignmentId: aid, studentId: student.id },
          select: {
            id: true, fileUrl: true, fileName: true, notes: true, status: true,
            marks: true, feedback: true, isLate: true, submittedAt: true,
          },
        }), null);

      return reply.send({
        success: true,
        data: {
          assignment: {
            id: assignment.id, title: assignment.title, instructions: assignment.instructions,
            totalMarks: assignment.totalMarks, dueDate: assignment.dueDate, type: assignment.type,
            subjectName: assignment.subject?.name, chapterName: assignment.chapter?.name, topicName: assignment.topic?.name,
            teacherName: assignment.createdBy?.user?.name,
            teacherUserId: assignment.createdBy?.user?.id,
            materials: assignment.materials.map((m: any) => m.material),
          },
          submission,
        },
      });
    }
  );

  // ── POST /student/academics/assignments/:id/submit ──────────
  app.post("/student/academics/assignments/:id/submit",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { id } = req.params as { id: string };
      const aid = parseInt(id);
      const body = req.body as { fileUrl?: string; fileName?: string; notes?: string };

      const student = await getStudent(userId, schoolId);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const assignment = await prisma.studyAssignment.findFirst({ where: { id: aid, schoolId }, select: { dueDate: true } });
      if (!assignment) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      const isLate = assignment.dueDate ? new Date() > new Date(assignment.dueDate) : false;

      await prisma.studyAssignmentSubmission.upsert({
        where: { assignmentId_studentId: { assignmentId: aid, studentId: student.id } },
        update: {
          fileUrl: body.fileUrl ?? null, fileName: body.fileName ?? null, notes: body.notes ?? null,
          status: "SUBMITTED", isLate, submittedAt: new Date(),
        },
        create: {
          assignmentId: aid, studentId: student.id,
          fileUrl: body.fileUrl ?? null, fileName: body.fileName ?? null, notes: body.notes ?? null,
          status: "SUBMITTED", isLate, submittedAt: new Date(),
        },
      });

      return reply.status(201).send({ success: true, message: "Submitted successfully" });
    }
  );
}