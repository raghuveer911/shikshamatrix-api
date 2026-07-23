import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { requireCapability } from "../../middleware/checkCapability.js";
import { getMemberBorrowingProfile, issueBook, returnBook, LibraryError } from "../../services/library-circulation.service.js";

export async function staffLibraryRoutes(app: FastifyInstance) {
  const P = "/staff/library";

  // ── GET /staff/library/overview ─────────────────────────
  app.get(`${P}/overview`, { preHandler: [appAuth, requireCapability("library.issueReturn")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const today = new Date(); today.setHours(0, 0, 0, 0);

      const [totalBooks, availableCopies, issuedCopies, overdueCount] = await Promise.all([
        prisma.libBook.count({ where: { schoolId, isActive: true } }),
        prisma.libBookCopy.count({ where: { schoolId, status: "AVAILABLE" } }),
        prisma.libBookCopy.count({ where: { schoolId, status: "ISSUED" } }),
        prisma.libIssue.count({ where: { schoolId, status: "ACTIVE", dueDate: { lt: today } } }),
      ]);

      return reply.send({ success: true, data: { totalBooks, availableCopies, issuedCopies, overdueCount } });
    }
  );

  // ── GET /staff/library/books?search= ────────────────────
  app.get(`${P}/books`, { preHandler: [appAuth, requireCapability("library.issueReturn")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = req.query as any;
      const page = Number(q.page ?? 1);
      const limit = Number(q.limit ?? 30);

      const where: any = { schoolId, isActive: true };
      if (q.search) {
        where.OR = [
          { title: { contains: q.search, mode: "insensitive" } },
          { isbn: { contains: q.search, mode: "insensitive" } },
          { author: { name: { contains: q.search, mode: "insensitive" } } },
        ];
      }

      const [books, total] = await Promise.all([
        prisma.libBook.findMany({
          where, orderBy: { title: "asc" }, skip: (page - 1) * limit, take: limit,
          include: { category: { select: { name: true, color: true } }, author: { select: { name: true } } },
        }),
        prisma.libBook.count({ where }),
      ]);

      const enriched = await Promise.all(books.map(async (b) => {
        const available = await prisma.libBookCopy.count({ where: { bookId: b.id, status: "AVAILABLE" } });
        return { ...b, availableCopies: available };
      }));

      return reply.send({ success: true, data: { books: enriched, total, pages: Math.ceil(total / limit) } });
    }
  );

  // ── GET /staff/library/books/:id ─────────────────────────
  app.get(`${P}/books/:id`, { preHandler: [appAuth, requireCapability("library.issueReturn")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };

      const book = await prisma.libBook.findFirst({
        where: { id: Number(id), schoolId },
        include: {
          category: { select: { name: true, color: true } }, author: { select: { name: true } }, publisher: { select: { name: true } },
          copies: {
            orderBy: { copyCode: "asc" },
            include: { issues: { where: { status: { in: ["ACTIVE", "OVERDUE"] } }, take: 1, include: { student: { include: { user: { select: { name: true } } } } } } },
          },
        },
      });
      if (!book) return reply.status(404).send({ success: false, message: "Book not found." });
      return reply.send({ success: true, data: { book } });
    }
  );

  // ── GET /staff/library/members/search?q= ────────────────
  app.get(`${P}/members/search`, { preHandler: [appAuth, requireCapability("library.issueReturn")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = (req.query as any).q as string;
      if (!q || q.trim().length < 2) return reply.send({ success: true, data: { members: [] } });

      const [students, staff] = await Promise.all([
        prisma.student.findMany({
          where: { schoolId, isActive: true, user: { name: { contains: q, mode: "insensitive" } } },
          include: { user: { select: { id: true, name: true, avatarUrl: true } }, class: { select: { name: true } } },
          take: 8,
        }),
        prisma.staff.findMany({
          where: { schoolId, isActive: true, user: { name: { contains: q, mode: "insensitive" } } },
          include: { user: { select: { id: true, name: true, avatarUrl: true, role: true } } },
          take: 5,
        }),
      ]);

      const members = [
        ...students.map((s) => ({ id: s.id, type: "STUDENT", name: s.user?.name, avatarUrl: s.user?.avatarUrl, subtitle: `Student · ${s.class?.name ?? ""}` })),
        ...staff.map((st) => ({ id: st.id, type: st.user?.role === "TEACHER" ? "TEACHER" : "STAFF", name: st.user?.name, avatarUrl: st.user?.avatarUrl, subtitle: st.user?.role ?? "Staff" })),
      ];
      return reply.send({ success: true, data: { members } });
    }
  );

  // ── GET /staff/library/members/:type/:id/profile ────────
  app.get(`${P}/members/:type/:id/profile`, { preHandler: [appAuth, requireCapability("library.issueReturn")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { type, id } = req.params as { type: string; id: string };
      const profile = await getMemberBorrowingProfile(schoolId, type, Number(id));
      return reply.send({ success: true, data: profile });
    }
  );

  // ── POST /staff/library/issue ────────────────────────────
  app.post(`${P}/issue`, { preHandler: [appAuth, requireCapability("library.issueReturn")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const b = req.body as { copyId: number; memberId: number; memberType: string };
      try {
        const issue = await issueBook(schoolId, { copyId: Number(b.copyId), memberId: Number(b.memberId), memberType: b.memberType, issuedByStaffId: staffId ?? null });
        return reply.status(201).send({ success: true, message: "Book issued successfully.", data: { issue } });
      } catch (err) {
        if (err instanceof LibraryError) return reply.status(err.status).send({ success: false, message: err.message });
        console.error("[staff/library] issue failed:", err);
        return reply.status(500).send({ success: false, message: "Couldn't issue the book. Please try again." });
      }
    }
  );

  // ── POST /staff/library/return ───────────────────────────
  app.post(`${P}/return`, { preHandler: [appAuth, requireCapability("library.issueReturn")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const b = req.body as { issueId: number; condition?: string; notes?: string };
      try {
        const result = await returnBook(schoolId, { issueId: Number(b.issueId), condition: b.condition, notes: b.notes, returnedByStaffId: staffId ?? null });
        return reply.send({ success: true, message: "Book returned successfully.", data: result });
      } catch (err) {
        if (err instanceof LibraryError) return reply.status(err.status).send({ success: false, message: err.message });
        console.error("[staff/library] return failed:", err);
        return reply.status(500).send({ success: false, message: "Couldn't process the return. Please try again." });
      }
    }
  );

  // ── GET /staff/library/issues?status=active|overdue ─────
  app.get(`${P}/issues`, { preHandler: [appAuth, requireCapability("library.issueReturn")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const q = req.query as { status?: string; search?: string };
      const today = new Date(); today.setHours(0, 0, 0, 0);

      const where: any = { schoolId, status: { in: ["ACTIVE", "OVERDUE"] } };
      if (q.status === "overdue") where.dueDate = { lt: today };
      if (q.search) {
        where.OR = [
          { copy: { book: { title: { contains: q.search, mode: "insensitive" } } } },
          { student: { user: { name: { contains: q.search, mode: "insensitive" } } } },
          { staff: { user: { name: { contains: q.search, mode: "insensitive" } } } },
        ];
      }

      const issues = await prisma.libIssue.findMany({
        where, orderBy: { dueDate: "asc" },
        include: {
          copy: { include: { book: { select: { title: true } } } },
          student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } },
          staff: { include: { user: { select: { name: true, avatarUrl: true, role: true } } } },
        },
      });

      const enriched = issues.map((i) => {
        const isOverdue = new Date(i.dueDate) < today;
        const overdueDays = isOverdue ? Math.floor((today.getTime() - new Date(i.dueDate).getTime()) / 86400000) : 0;
        return {
          id: i.id, bookTitle: i.copy.book.title,
          memberName: i.student?.user?.name ?? i.staff?.user?.name ?? "—",
          memberSubtitle: i.student ? `Student · ${i.student.class?.name ?? ""}` : (i.staff?.user?.role ?? "Staff"),
          issueDate: i.issueDate, dueDate: i.dueDate, isOverdue, overdueDays,
        };
      });

      return reply.send({ success: true, data: { issues: enriched, total: enriched.length } });
    }
  );
}
