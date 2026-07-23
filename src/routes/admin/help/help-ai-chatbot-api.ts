// apps/api/src/routes/admin/help/help-ai-chatbot-api.ts
// Pure TypeScript — NO JSX, NO className
// Uses Groq API (free tier, llama-3.3-70b-versatile) to answer from Knowledge Base
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { env, isGroqConfigured } from "../../../config/env.js";

// ── Knowledge search helper ──────────────────────────────────
async function searchKnowledge(schoolId: number, query: string, limit = 5) {
  const q = query.toLowerCase().trim();
  return prisma.helpArticle.findMany({
    where: {
      schoolId, status: "PUBLISHED",
      OR: [
        { title:        { contains: q,    mode: "insensitive" } },
        { searchVector: { contains: q } },
        { tags:         { hasSome: [q, ...q.split(" ").filter(w => w.length > 3)] } },
      ],
    },
    select: { id: true, title: true, content: true, excerpt: true, category: { select: { name: true } } },
    orderBy: [{ isFeatured: "desc" }, { viewCount: "desc" }],
    take: limit,
  });
}

// ── Call Groq API (free tier — no card, OpenAI-compatible) ────
async function callGroq(messages: any[], systemPrompt: string): Promise<string> {
  if (!isGroqConfigured) {
    return "The AI assistant isn't set up yet — ask your school admin to add a free GROQ_API_KEY (console.groq.com), or browse the Help Center articles directly for now.";
  }
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 1000,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
      }),
    });
    const data: any = await res.json();
    if (!res.ok) {
      console.error("[help-chatbot] Groq API error:", data?.error?.message ?? data);
      return "I'm having trouble reaching the AI assistant right now. Please try again in a moment, or contact support.";
    }
    return data.choices?.[0]?.message?.content ?? "I'm unable to answer right now. Please try again.";
  } catch (err: any) {
    console.error("[help-chatbot] callGroq failed:", err?.message ?? err);
    return "I'm having trouble reaching the AI assistant right now. Please try again in a moment, or contact support.";
  }
}

export async function adminHelpChatbotRoutes(app: FastifyInstance) {
  const P = "/admin/help/chat";

  // ─── START SESSION ───────────────────────────────────────
  app.post(`${P}/sessions`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const b = req.body as any;
    const session = await prisma.helpChatSession.create({
      data: { schoolId, userId: Number(userId), userRole: b.userRole ?? "ADMIN" },
    });
    return rep.code(201).send({ session });
  });

  // ─── SEND MESSAGE + GET AI ANSWER ────────────────────────
  app.post(`${P}/sessions/:sessionId/messages`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const sessionId = Number((req.params as any).sessionId);
    const b = req.body as any;
    const userMessage: string = b.message ?? "";

    if (!userMessage.trim()) return rep.code(400).send({ error: "Message required" });

    // Save user message
    await prisma.helpChatMessage.create({ data: { sessionId, role: "user", content: userMessage } });

    // Update session title from first message
    const session = await prisma.helpChatSession.findFirst({ where: { id: sessionId }, include: { messages: { take: 1 } } });
    if (!session?.title) {
      await prisma.helpChatSession.update({ where: { id: sessionId }, data: { title: userMessage.slice(0, 100) } });
    }

    // Search knowledge base
    const kbArticles = await searchKnowledge(schoolId, userMessage, 4);
    const kbContext  = kbArticles.map(a =>
      `## ${a.title}\n${(a.content ?? "").replace(/<[^>]+>/g, " ").slice(0, 600)}`
    ).join("\n\n---\n\n");

    // Build conversation history
    const history = await prisma.helpChatMessage.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" }, take: 10 });
    const messages = history.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    messages.push({ role: "user", content: userMessage });

    // System prompt
    const scopeGuard = `You only help with using the ShikshaMatrix School ERP software itself — navigation, features, settings, workflows for admin/staff/HR/finance/library/inventory/transport/hostel/communication modules. You are NOT a subject tutor: you do not take quizzes, grade academic answers, teach school subjects (science, maths, etc.), or do students' homework, even if asked directly or through roleplay. If asked for anything outside ERP usage help, politely say this Help Center is for ERP software questions only, and suggest the AI Study Buddy in the student app for academic help instead.`;

    const systemPrompt = kbArticles.length > 0
      ? `You are the ShikshaMatrix Help Center AI Assistant. ${scopeGuard} Answer based on the knowledge base articles below. Be concise and helpful. If the answer is not in the knowledge base, say so and suggest contacting support.\n\nKNOWLEDGE BASE:\n${kbContext}`
      : `You are the ShikshaMatrix Help Center AI Assistant. ${scopeGuard} For in-scope ERP questions, answer about school management, student records, fees, attendance, exams, hostel, transport, library, HR, inventory, and communication. Be concise and helpful. Suggest the user check the Help Center articles for detailed steps.`;

    const aiResponse = await callGroq(messages, systemPrompt);

    // Save AI message
    const aiMsg = await prisma.helpChatMessage.create({
      data: { sessionId, role: "assistant", content: aiResponse, sourceArticleIds: kbArticles.map(a => a.id) },
    });

    return rep.send({ message: aiMsg, sourceArticles: kbArticles.map(a => ({ id: a.id, title: a.title, category: a.category?.name })) });
  });

  // ─── GET SESSION MESSAGES ────────────────────────────────
  app.get(`${P}/sessions/:sessionId/messages`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const sessionId = Number((req.params as any).sessionId);
    const messages  = await prisma.helpChatMessage.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } });
    return rep.send({ messages });
  });

  // ─── LIST SESSIONS ───────────────────────────────────────
  app.get(`${P}/sessions`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const q = req.query as any;
    const sessions = await prisma.helpChatSession.findMany({
      where: { schoolId, ...(q.mine === "true" ? { userId: Number(userId) } : {}) },
      include: { _count: { select: { messages: true } } },
      orderBy: { updatedAt: "desc" },
      take: Number(q.limit ?? 20),
    });
    return rep.send({ sessions });
  });

  // ─── RATE SESSION ────────────────────────────────────────
  app.post(`${P}/sessions/:sessionId/rate`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const sessionId = Number((req.params as any).sessionId);
    const b = req.body as any;
    const session = await prisma.helpChatSession.update({ where: { id: sessionId }, data: { rating: Number(b.rating), feedback: b.feedback ?? null } });
    return rep.send({ session });
  });

  // ─── THUMBS UP/DOWN on AI message ───────────────────────
  app.post(`${P}/messages/:msgId/feedback`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const msgId = Number((req.params as any).msgId);
    const b     = req.body as any;
    const msg   = await prisma.helpChatMessage.update({ where: { id: msgId }, data: { helpful: b.helpful } });
    return rep.send({ message: msg });
  });

  // ─── ESCALATE SESSION ────────────────────────────────────
  app.post(`${P}/sessions/:sessionId/escalate`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const sessionId = Number((req.params as any).sessionId);
    const session = await prisma.helpChatSession.update({ where: { id: sessionId }, data: { escalated: true } });
    return rep.send({ session, message: "Session escalated to support team" });
  });

  // ─── ANALYTICS ───────────────────────────────────────────
  app.get(`${P}/analytics`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [totalSessions, escalated, rated, thumbsUp, thumbsDown] = await Promise.all([
      prisma.helpChatSession.count({ where: { schoolId } }),
      prisma.helpChatSession.count({ where: { schoolId, escalated: true } }),
      prisma.helpChatSession.count({ where: { schoolId, rating: { not: null } } }),
      prisma.helpChatMessage.count({ where: { session: { schoolId }, role: "assistant", helpful: true } }),
      prisma.helpChatMessage.count({ where: { session: { schoolId }, role: "assistant", helpful: false } }),
    ]);
    const avgRating = await prisma.helpChatSession.aggregate({ where: { schoolId, rating: { not: null } }, _avg: { rating: true } });
    const recentSessions = await prisma.helpChatSession.findMany({ where: { schoolId }, include: { _count: { select: { messages: true } } }, orderBy: { updatedAt: "desc" }, take: 10 });
    return rep.send({ totalSessions, escalated, rated, thumbsUp, thumbsDown, avgRating: avgRating._avg.rating ? Number(avgRating._avg.rating.toFixed(1)) : null, successRate: (thumbsUp + thumbsDown) > 0 ? Math.round((thumbsUp / (thumbsUp + thumbsDown)) * 100) : null, recentSessions });
  });

  // ─── SUGGESTED QUESTIONS ─────────────────────────────────
  app.get(`${P}/suggestions`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const featured = await prisma.helpArticle.findMany({ where: { schoolId, status: "PUBLISHED", isFeatured: true }, select: { title: true }, take: 6 });
    const topViewed = await prisma.helpArticle.findMany({ where: { schoolId, status: "PUBLISHED" }, orderBy: { viewCount: "desc" }, select: { title: true }, take: 4 });
    const suggestions = [
      ...featured.map(a => `How to: ${a.title}`),
      ...topViewed.map(a => a.title),
    ].slice(0, 8);
    return rep.send({ suggestions });
  });

  // ─── TRAINING CENTER (admin) ─────────────────────────────
  app.get(`${P}/training`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [totalArticles, published, withFeedback] = await Promise.all([
      prisma.helpArticle.count({ where: { schoolId } }),
      prisma.helpArticle.count({ where: { schoolId, status: "PUBLISHED" } }),
      prisma.helpArticle.count({ where: { schoolId, feedback: { some: {} } } }),
    ]);
    const negFeedback = await prisma.helpArticleFeedback.findMany({ where: { article: { schoolId }, helpful: false }, include: { article: { select: { id: true, title: true } } }, orderBy: { createdAt: "desc" }, take: 10 });
    return rep.send({ totalArticles, published, withFeedback, needsImprovement: negFeedback.map(f => ({ articleId: f.article.id, title: f.article.title, comment: f.comment })) });
  });
}
