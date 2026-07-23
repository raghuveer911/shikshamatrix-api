import { prisma } from "../lib/prisma.js";
import { env, isGroqConfigured } from "../config/env.js";

export class StudyBuddyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

async function callGroqRaw(body: any): Promise<any> {
  if (!isGroqConfigured) {
    throw new StudyBuddyError(503, "The AI Study Buddy isn't set up yet — ask your school admin to add a free GROQ_API_KEY (console.groq.com).");
  }
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify(body),
  });
  const data: any = await res.json();
  if (!res.ok) {
    console.error("[study-buddy] Groq API error:", data?.error?.message ?? data);
    throw new StudyBuddyError(502, "I'm having trouble reaching the AI right now. Please try again in a moment.");
  }
  return data;
}

// ── Chat (doubt-clearing / homework help) ──────────────────
export async function studyBuddyChat(messages: any[], studentContext: { classLevel?: string; board?: string }): Promise<string> {
  const systemPrompt = `You are the ShikshaMatrix AI Study Buddy — a friendly, patient academic tutor for a school student${studentContext.classLevel ? ` in class ${studentContext.classLevel}` : ""}${studentContext.board ? ` (${studentContext.board} board)` : ""}. Help with homework, explain concepts step by step, and encourage the student to think rather than just giving answers outright when it's a problem they should work through. Keep answers age-appropriate and encouraging. You can discuss any school subject (science, maths, social studies, languages, etc.). If asked something unrelated to studies, gently steer back to academics.`;

  const data = await callGroqRaw({
    model: "llama-3.3-70b-versatile",
    max_tokens: 1000,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
  });
  return data.choices?.[0]?.message?.content ?? "I'm not sure how to answer that — could you rephrase your question?";
}

// ── Quiz generation (structured, ground-truth stored) ───────
export interface GeneratedQuestion {
  questionText: string;
  optionA: string; optionB: string; optionC: string; optionD: string;
  correctOption: "A" | "B" | "C" | "D";
  explanation: string;
}

async function requestQuizJSON(subject: string, topic: string | undefined, board: string | undefined, classLevel: string | undefined, count: number): Promise<GeneratedQuestion[]> {
  const scope = [subject, topic, board ? `${board} board` : null, classLevel ? `class ${classLevel}` : null].filter(Boolean).join(", ");
  const systemPrompt = `You are a quiz-question generator for a school exam-prep app. Generate exactly ${count} multiple-choice questions for: ${scope}. Respond with ONLY a raw JSON array (no markdown fences, no commentary, no extra text before or after) matching exactly this shape:
[{"questionText": "...", "optionA": "...", "optionB": "...", "optionC": "...", "optionD": "...", "correctOption": "A", "explanation": "..."}]
Each "correctOption" must be exactly one of "A", "B", "C", "D". Keep questions accurate to the specified board/class syllabus where known. Keep each option under 15 words.`;

  const data = await callGroqRaw({
    model: "llama-3.3-70b-versatile",
    max_tokens: 2500,
    temperature: 0.5,
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Generate the quiz now.` }],
  });

  const raw: string = data.choices?.[0]?.message?.content ?? "";
  // Defensive parsing — strip markdown fences if the model added them
  // despite instructions, since smaller/free models don't always follow
  // "no fences" perfectly.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new StudyBuddyError(502, "Couldn't generate a valid quiz this time. Please try again.");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new StudyBuddyError(502, "Couldn't generate a valid quiz this time. Please try again.");
  }

  const valid = parsed.filter((q: any) =>
    q && typeof q.questionText === "string" &&
    typeof q.optionA === "string" && typeof q.optionB === "string" && typeof q.optionC === "string" && typeof q.optionD === "string" &&
    ["A", "B", "C", "D"].includes(q.correctOption)
  );

  if (valid.length === 0) {
    throw new StudyBuddyError(502, "Couldn't generate a valid quiz this time. Please try again.");
  }

  return valid.map((q: any) => ({
    questionText: q.questionText, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD,
    correctOption: q.correctOption, explanation: typeof q.explanation === "string" ? q.explanation : "",
  }));
}

export async function generateQuiz(schoolId: number, studentId: number, input: { subject: string; topic?: string; board?: string; classLevel?: string; count?: number }) {
  const count = Math.min(20, Math.max(3, input.count ?? 10));
  const questions = await requestQuizJSON(input.subject, input.topic, input.board, input.classLevel, count);

  const session = await prisma.studyQuizSession.create({
    data: {
      schoolId, studentId, subject: input.subject, topic: input.topic ?? null,
      board: input.board ?? null, classLevel: input.classLevel ?? null,
      totalQuestions: questions.length, status: "IN_PROGRESS",
      questions: {
        create: questions.map((q, i) => ({
          questionNo: i + 1, questionText: q.questionText,
          optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD,
          correctOption: q.correctOption, explanation: q.explanation,
        })),
      },
    },
    include: { questions: true },
  });

  return session;
}

export async function submitQuizAnswers(schoolId: number, studentId: number, sessionId: number, answers: Record<number, string>) {
  const session = await prisma.studyQuizSession.findFirst({ where: { id: sessionId, schoolId, studentId }, include: { questions: true } });
  if (!session) throw new StudyBuddyError(404, "Quiz not found.");
  if (session.status === "COMPLETED") throw new StudyBuddyError(409, "This quiz has already been submitted.");

  let score = 0;
  for (const q of session.questions) {
    const studentAnswer = answers[q.id] ?? null;
    const isCorrect = !!studentAnswer && studentAnswer.toUpperCase() === q.correctOption;
    if (isCorrect) score++;
    await prisma.studyQuizQuestion.update({
      where: { id: q.id },
      data: { studentAnswer: studentAnswer ? studentAnswer.toUpperCase() : null, isCorrect },
    });
  }

  const updated = await prisma.studyQuizSession.update({
    where: { id: sessionId },
    data: { status: "COMPLETED", score, completedAt: new Date() },
    include: { questions: true },
  });

  return updated;
}
