// apps/api/src/routes/admin/library/lib-book-catalog-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ── Utility: generate next copy code ─────────────────────────
async function nextCopyCode(schoolId: number, bookId: number): Promise<string> {
  const settings = await prisma.libSettings.findUnique({ where: { schoolId } });
  const prefix   = settings?.bookCodePrefix ?? "LIB";
  const copyCount = await prisma.libBookCopy.count({ where: { bookId } });
  const bookSeq  = String(bookId).padStart(4, "0");
  const copySeq  = String(copyCount + 1).padStart(2, "0");
  return `${prefix}-${bookSeq}-C${copySeq}`;
}

export async function adminLibBookCatalogRoutes(app: FastifyInstance) {
  const P = "/admin/library/catalog";

  // ─── REFERENCE DATA — Categories ──────────────────────────
  app.get(`${P}/categories`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const categories = await prisma.libBookCategory.findMany({
        where: { schoolId, isActive: true },
        orderBy: { name: "asc" },
      });
      return rep.send({ categories });
    }
  );

  app.post(`${P}/categories`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const cat = await prisma.libBookCategory.create({
        data: { schoolId, name: b.name, code: b.code ?? null, description: b.description ?? null, color: b.color ?? "#6366f1" },
      });
      return rep.code(201).send({ category: cat });
    }
  );

  app.put(`${P}/categories/:id`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const cat = await prisma.libBookCategory.update({
        where: { id, schoolId },
        data: { name: b.name, code: b.code, description: b.description, color: b.color, isActive: b.isActive },
      });
      return rep.send({ category: cat });
    }
  );

  // ─── REFERENCE DATA — Authors ─────────────────────────────
  app.get(`${P}/authors`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const authors = await prisma.libAuthor.findMany({
        where: { schoolId, isActive: true, ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}) },
        orderBy: { name: "asc" },
        take: Number(q.limit ?? 50),
      });
      return rep.send({ authors });
    }
  );

  app.post(`${P}/authors`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const author = await prisma.libAuthor.upsert({
        where: { schoolId_name: { schoolId, name: b.name } },
        create: { schoolId, name: b.name, bio: b.bio ?? null },
        update: { bio: b.bio ?? undefined },
      });
      return rep.code(201).send({ author });
    }
  );

  // ─── REFERENCE DATA — Publishers ─────────────────────────
  app.get(`${P}/publishers`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const publishers = await prisma.libPublisher.findMany({
        where: { schoolId, isActive: true, ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}) },
        orderBy: { name: "asc" },
        take: Number(q.limit ?? 50),
      });
      return rep.send({ publishers });
    }
  );

  app.post(`${P}/publishers`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const pub = await prisma.libPublisher.upsert({
        where: { schoolId_name: { schoolId, name: b.name } },
        create: { schoolId, name: b.name, city: b.city ?? null, website: b.website ?? null },
        update: { city: b.city ?? undefined, website: b.website ?? undefined },
      });
      return rep.code(201).send({ publisher: pub });
    }
  );

  // ─── BOOK CATALOG — List & Search ─────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 30);

      const where: any = { schoolId, isActive: true };
      if (q.categoryId) where.categoryId = Number(q.categoryId);
      if (q.authorId)   where.authorId   = Number(q.authorId);
      if (q.classId)    where.classId    = Number(q.classId);
      if (q.language)   where.language   = q.language;
      if (q.search) {
        where.OR = [
          { title:  { contains: q.search, mode: "insensitive" } },
          { isbn:   { contains: q.search, mode: "insensitive" } },
          { author: { name: { contains: q.search, mode: "insensitive" } } },
          { tags:   { has: q.search } },
        ];
      }

      const [books, total] = await Promise.all([
        prisma.libBook.findMany({
          where,
          include: {
            category:  { select: { name: true, color: true } },
            author:    { select: { name: true } },
            publisher: { select: { name: true } },
            class:     { select: { name: true } },
            _count:    { select: { copies: true } },
          },
          orderBy: { title: "asc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.libBook.count({ where }),
      ]);

      // Enrich with available copy count
      const enriched = await Promise.all(books.map(async b => {
        const available = await prisma.libBookCopy.count({ where: { bookId: b.id, status: "AVAILABLE" } });
        return { ...b, availableCopies: available };
      }));

      return rep.send({ books: enriched, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── GET ONE BOOK WITH COPIES ─────────────────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);

      const book = await prisma.libBook.findFirst({
        where: { id, schoolId },
        include: {
          category:  { select: { name: true, color: true } },
          author:    { select: { name: true } },
          publisher: { select: { name: true } },
          class:     { select: { name: true } },
          copies: {
            orderBy: { copyCode: "asc" },
            include: {
              issues: { where: { status: { in: ["ACTIVE","OVERDUE"] } }, take: 1,
                include: { student: { include: { user: { select: { name: true } } } } },
              },
            },
          },
        },
      });
      if (!book) return rep.code(404).send({ error: "Book not found" });
      return rep.send({ book });
    }
  );

  // ─── CREATE BOOK ──────────────────────────────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      // Duplicate ISBN check
      if (b.isbn) {
        const existing = await prisma.libBook.findFirst({ where: { schoolId, isbn: b.isbn } });
        if (existing) return rep.code(409).send({ error: `ISBN ${b.isbn} already exists`, existingBookId: existing.id });
      }

      // Auto-create author / publisher if provided as string
      let authorId   = b.authorId   ? Number(b.authorId)    : null;
      let publisherId = b.publisherId ? Number(b.publisherId) : null;

      if (b.authorName && !authorId) {
        const a = await prisma.libAuthor.upsert({
          where: { schoolId_name: { schoolId, name: b.authorName } },
          create: { schoolId, name: b.authorName },
          update: {},
        });
        authorId = a.id;
      }
      if (b.publisherName && !publisherId) {
        const p = await prisma.libPublisher.upsert({
          where: { schoolId_name: { schoolId, name: b.publisherName } },
          create: { schoolId, name: b.publisherName },
          update: {},
        });
        publisherId = p.id;
      }

      const book = await prisma.libBook.create({
        data: {
          schoolId,
          isbn:        b.isbn ?? null,
          title:       b.title,
          categoryId:  b.categoryId  ? Number(b.categoryId)  : null,
          authorId,
          publisherId,
          classId:     b.classId     ? Number(b.classId)     : null,
          subjectName: b.subjectName ?? null,
          classNumber: b.classNumber ?? null,
          edition:     b.edition     ?? null,
          language:    b.language    as any ?? "ENGLISH",
          pages:       b.pages       ? Number(b.pages)       : null,
          description: b.description ?? null,
          coverUrl:    b.coverUrl    ?? null,
          tags:        b.tags        ?? [],
          totalCopies: Number(b.totalCopies ?? 1),
          costPrice:   b.costPrice   ? Number(b.costPrice)   : null,
          purchaseDate: b.purchaseDate ? new Date(b.purchaseDate) : null,
          createdById: Number(userId),
        },
      });

      // Auto-create copies
      const numCopies = Number(b.totalCopies ?? 1);
      for (let i = 0; i < numCopies; i++) {
        const copyCode = await nextCopyCode(schoolId, book.id);
        await prisma.libBookCopy.create({
          data: { schoolId, bookId: book.id, copyCode, location: b.location ?? null },
        });
      }

      // Update category book count
      if (b.categoryId) {
        await prisma.libBookCategory.update({
          where: { id: Number(b.categoryId) },
          data: { bookCount: { increment: 1 } },
        });
      }

      return rep.code(201).send({ book });
    }
  );

  // ─── UPDATE BOOK ──────────────────────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const book = await prisma.libBook.update({
        where: { id, schoolId },
        data: {
          isbn:        b.isbn,
          title:       b.title,
          categoryId:  b.categoryId  ? Number(b.categoryId)  : undefined,
          authorId:    b.authorId    ? Number(b.authorId)    : undefined,
          publisherId: b.publisherId ? Number(b.publisherId) : undefined,
          classId:     b.classId     ? Number(b.classId)     : undefined,
          subjectName: b.subjectName ?? undefined,
          classNumber: b.classNumber ?? undefined,
          edition: b.edition, language: b.language as any,
          pages: b.pages ? Number(b.pages) : undefined,
          description: b.description, coverUrl: b.coverUrl, tags: b.tags,
          costPrice: b.costPrice ? Number(b.costPrice) : undefined,
          purchaseDate: b.purchaseDate ? new Date(b.purchaseDate) : undefined,
          isActive: b.isActive,
        },
      });

      return rep.send({ book });
    }
  );

  // ─── SOFT DELETE ──────────────────────────────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      // Check no active issues
      const activeIssues = await prisma.libIssue.count({ where: { copy: { bookId: id }, status: "ACTIVE" } });
      if (activeIssues > 0) return rep.code(409).send({ error: `Cannot delete — ${activeIssues} copies currently issued` });
      await prisma.libBook.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─── COPY MANAGEMENT ──────────────────────────────────────
  app.post(`${P}/:bookId/copies`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const bookId = Number((req.params as any).bookId);
      const b = req.body as any;
      const count = Number(b.count ?? 1);

      const copies = [];
      for (let i = 0; i < count; i++) {
        const copyCode = await nextCopyCode(schoolId, bookId);
        const copy = await prisma.libBookCopy.create({
          data: { schoolId, bookId, copyCode, location: b.location ?? null },
        });
        copies.push(copy);
      }

      await prisma.libBook.update({ where: { id: bookId }, data: { totalCopies: { increment: count } } });
      return rep.code(201).send({ copies });
    }
  );

  app.put(`${P}/copies/:copyId`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const copyId = Number((req.params as any).copyId);
      const b = req.body as any;
      const copy = await prisma.libBookCopy.update({
        where: { id: copyId, schoolId },
        data: {
          status:    b.status as any,
          location:  b.location,
          condition: b.condition,
          barcode:   b.barcode,
          notes:     b.notes,
          lostAt:    b.status === "LOST"    ? new Date() : undefined,
          damagedAt: b.status === "DAMAGED" ? new Date() : undefined,
        },
      });
      return rep.send({ copy });
    }
  );

  // ─── ISBN LOOKUP (duplicate check) ────────────────────────
  app.get(`${P}/check-isbn/:isbn`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const isbn = (req.params as any).isbn;
      const book = await prisma.libBook.findFirst({ where: { schoolId, isbn }, select: { id: true, title: true, isbn: true } });
      return rep.send({ exists: !!book, book });
    }
  );

  // ─── CATALOG STATS ────────────────────────────────────────
  app.get(`${P}/stats`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [totalBooks, totalCopies, byCategory, byLanguage, byStatus] = await Promise.all([
        prisma.libBook.count({ where: { schoolId, isActive: true } }),
        prisma.libBookCopy.count({ where: { schoolId } }),
        prisma.libBook.groupBy({
          by: ["categoryId"],
          where: { schoolId, isActive: true },
          _count: { id: true },
          orderBy: { _count: { id: "desc" } },
          take: 8,
        }),
        prisma.libBook.groupBy({
          by: ["language"],
          where: { schoolId, isActive: true },
          _count: { id: true },
        }),
        prisma.libBookCopy.groupBy({
          by: ["status"],
          where: { schoolId },
          _count: { id: true },
        }),
      ]);

      return rep.send({ totalBooks, totalCopies, byCategory, byLanguage, byStatus });
    }
  );
}
