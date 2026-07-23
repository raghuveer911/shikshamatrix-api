// apps/api/src/routes/student/library.ts
//
// My Issued Books + Book History — both from confirmed LibIssue/
// LibBookCopy/LibBook/LibAuthor/LibFine models. Book Reservation
// endpoint deliberately NOT included yet — pending LibReservationStatus
// enum confirmation.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/library] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function getStudentId(userId: number, schoolId: number): Promise<number | null> {
  const s = await safe("student lookup", () =>
    prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true } }), null);
  return s?.id ?? null;
}

export async function studentLibraryRoutes(app: FastifyInstance) {

  // ── GET /student/library/issued — currently active issues ────
  app.get("/student/library/issued",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const issues = await safe("issued books", () =>
        prisma.libIssue.findMany({
          where: { studentId: sid, schoolId, status: "ACTIVE" },
          orderBy: { dueDate: "asc" },
          select: {
            id: true, issueDate: true, dueDate: true, renewalCount: true,
            copy: { select: { copyCode: true, book: { select: { title: true, coverUrl: true, author: { select: { name: true } } } } } },
            fine: { select: { totalAmount: true, status: true } },
          },
        }), [] as any[]);

      const now = new Date();
      return reply.send({
        success: true,
        data: {
          books: issues.map((i: any) => ({
            id: i.id, title: i.copy?.book?.title ?? "—", author: i.copy?.book?.author?.name ?? "Unknown",
            coverUrl: i.copy?.book?.coverUrl, copyCode: i.copy?.copyCode,
            issueDate: i.issueDate, dueDate: i.dueDate, renewalCount: i.renewalCount,
            isOverdue: new Date(i.dueDate) < now,
            daysLeft: Math.ceil((new Date(i.dueDate).getTime() - now.getTime()) / 86400000),
            fine: i.fine ? { amount: i.fine.totalAmount, status: i.fine.status } : null,
          })),
        },
      });
    }
  );

  // ── GET /student/library/history — full past history ─────────
  app.get("/student/library/history",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const issues = await safe("history", () =>
        prisma.libIssue.findMany({
          where: { studentId: sid, schoolId },
          orderBy: { issueDate: "desc" }, take: 50,
          select: {
            id: true, issueDate: true, dueDate: true, returnDate: true, status: true, returnCondition: true,
            copy: { select: { book: { select: { title: true, author: { select: { name: true } } } } } },
            fine: { select: { totalAmount: true, status: true } },
          },
        }), [] as any[]);

      return reply.send({
        success: true,
        data: {
          history: issues.map((i: any) => ({
            id: i.id, title: i.copy?.book?.title ?? "—", author: i.copy?.book?.author?.name ?? "Unknown",
            issueDate: i.issueDate, dueDate: i.dueDate, returnDate: i.returnDate,
            status: i.status, returnCondition: i.returnCondition,
            fine: i.fine ? { amount: i.fine.totalAmount, status: i.fine.status } : null,
          })),
        },
      });
    }
  );
}