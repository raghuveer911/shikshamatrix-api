import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { studyBuddyChat, generateQuiz, submitQuizAnswers, StudyBuddyError } from "../../services/study-buddy.service.js";

async function resolveStudentId(userId: number, schoolId: number): Promise<number> {
  const student = await prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true } });
  if (!student) throw new StudyBuddyError(403, "This feature is only available to student accounts.");
  return student.id;
}

export async function studentStudyBuddyRoutes(app: FastifyInstance) {
  const P = "/student/study-buddy";

  // ── POST /chat/sessions ──────────────────────────────────
  app.post(`${P}/chat/sessions`, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req as any;
      try {
        const studentId = await resolveStudentId(userId, schoolId);
        const session = await prisma.studyBuddySession.create({ data: { schoolId, studentId } });
        return reply.status(201).send({ success: true, data: { session } });
      } catch (err) {
        if (err instanceof StudyBuddyError) return reply.status(err.status).send({ success: false, message: err.message });
        throw err;
      }
    }
  );

  // ── POST /chat/sessions/:id/messages ─────────────────────
  app.post(`${P}/chat/sessions/:id/messages`, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req as any;
      const { id } = req.params as { id: string };
      const b = req.body as { message?: string; classLevel?: string; board?: string };
      const userMessage = b.message?.trim() ?? "";
      if (!userMessage) return reply.status(400).send({ success: false, message: "Message is required." });

      try {
        const studentId = await resolveStudentId(userId, schoolId);
        const session = await prisma.studyBuddySession.findFirst({ where: { id: Number(id), schoolId, studentId } });
        if (!session) return reply.status(404).send({ success: false, message: "Chat session not found." });

        await prisma.studyBuddyMessage.create({ data: { sessionId: session.id, role: "user", content: userMessage } });
        if (!session.title) {
          await prisma.studyBuddySession.update({ where: { id: session.id }, data: { title: userMessage.slice(0, 100) } });
        }

        const history = await prisma.studyBuddyMessage.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: "asc" }, take: 12 });
        const messages = history.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
        messages.push({ role: "user", content: userMessage });

        const aiResponse = await studyBuddyChat(messages, { classLevel: b.classLevel, board: b.board });
        const aiMsg = await prisma.studyBuddyMessage.create({ data: { sessionId: session.id, role: "assistant", content: aiResponse } });

        return reply.send({ success: true, data: { message: aiMsg } });
      } catch (err) {
        if (err instanceof StudyBuddyError) return reply.status(err.status).send({ success: false, message: err.message });
        console.error("[student/study-buddy] chat failed:", err);
        return reply.status(500).send({ success: false, message: "Something went wrong. Please try again." });
      }
    }
  );

  // ── GET /chat/sessions/:id/messages ──────────────────────
  app.get(`${P}/chat/sessions/:id/messages`, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const messages = await prisma.studyBuddyMessage.findMany({ where: { sessionId: Number(id) }, orderBy: { createdAt: "asc" } });
      return reply.send({ success: true, data: { messages } });
    }
  );

  // ── GET /chat/sessions ────────────────────────────────────
  app.get(`${P}/chat/sessions`, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req as any;
      try {
        const studentId = await resolveStudentId(userId, schoolId);
        const sessions = await prisma.studyBuddySession.findMany({
          where: { schoolId, studentId }, orderBy: { updatedAt: "desc" }, take: 20,
          include: { _count: { select: { messages: true } } },
        });
        return reply.send({ success: true, data: { sessions } });
      } catch (err) {
        if (err instanceof StudyBuddyError) return reply.status(err.status).send({ success: false, message: err.message });
        throw err;
      }
    }
  );

  // ── POST /quiz ────────────────────────────────────────────
  app.post(`${P}/quiz`, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req as any;
      const b = req.body as { subject?: string; topic?: string; board?: string; classLevel?: string; count?: number };
      if (!b.subject?.trim()) return reply.status(400).send({ success: false, message: "subject is required." });

      try {
        const studentId = await resolveStudentId(userId, schoolId);
        const session = await generateQuiz(schoolId, studentId, b as any);
        // Never send correctOption/explanation to the client before submission.
        const safeQuestions = session.questions.map((q) => ({
          id: q.id, questionNo: q.questionNo, questionText: q.questionText,
          optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD,
        }));
        return reply.status(201).send({ success: true, data: { session: { ...session, questions: safeQuestions } } });
      } catch (err) {
        if (err instanceof StudyBuddyError) return reply.status(err.status).send({ success: false, message: err.message });
        console.error("[student/study-buddy] quiz generation failed:", err);
        return reply.status(500).send({ success: false, message: "Couldn't generate the quiz. Please try again." });
      }
    }
  );

  // ── GET /quiz/:id ──────────────────────────────────────────
  app.get(`${P}/quiz/:id`, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req as any;
      const { id } = req.params as { id: string };
      try {
        const studentId = await resolveStudentId(userId, schoolId);
        const session = await prisma.studyQuizSession.findFirst({
          where: { id: Number(id), schoolId, studentId },
          include: { questions: { orderBy: { questionNo: "asc" } } },
        });
        if (!session) return reply.status(404).send({ success: false, message: "Quiz not found." });

        // Hide correct answers/explanations until the quiz is completed.
        const questions = session.questions.map((q) =>
          session.status === "COMPLETED"
            ? q
            : { id: q.id, questionNo: q.questionNo, questionText: q.questionText, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD }
        );
        return reply.send({ success: true, data: { session: { ...session, questions } } });
      } catch (err) {
        if (err instanceof StudyBuddyError) return reply.status(err.status).send({ success: false, message: err.message });
        throw err;
      }
    }
  );

  // ── POST /quiz/:id/submit ──────────────────────────────────
  app.post(`${P}/quiz/:id/submit`, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req as any;
      const { id } = req.params as { id: string };
      const b = req.body as { answers?: Record<string, string> }; // { questionId: "A"|"B"|"C"|"D" }

      try {
        const studentId = await resolveStudentId(userId, schoolId);
        const answersById: Record<number, string> = {};
        for (const [qid, ans] of Object.entries(b.answers ?? {})) answersById[Number(qid)] = ans;

        const result = await submitQuizAnswers(schoolId, studentId, Number(id), answersById);
        return reply.send({ success: true, data: { session: result } });
      } catch (err) {
        if (err instanceof StudyBuddyError) return reply.status(err.status).send({ success: false, message: err.message });
        console.error("[student/study-buddy] quiz submit failed:", err);
        return reply.status(500).send({ success: false, message: "Couldn't submit the quiz. Please try again." });
      }
    }
  );

  // ── GET /quiz/history ───────────────────────────────────────
  app.get(`${P}/quiz/history`, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req as any;
      try {
        const studentId = await resolveStudentId(userId, schoolId);
        const sessions = await prisma.studyQuizSession.findMany({
          where: { schoolId, studentId }, orderBy: { createdAt: "desc" }, take: 20,
          select: { id: true, subject: true, topic: true, board: true, classLevel: true, status: true, totalQuestions: true, score: true, createdAt: true, completedAt: true },
        });
        return reply.send({ success: true, data: { sessions } });
      } catch (err) {
        if (err instanceof StudyBuddyError) return reply.status(err.status).send({ success: false, message: err.message });
        throw err;
      }
    }
  );
}
