// apps/api/src/routes/admin/help/help-articles-api.ts
// Pure TypeScript — NO JSX, NO className
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 300);
}

function buildSearchVector(title: string, content: string, tags: string[]): string {
  const plain = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 2000);
  return `${title} ${tags.join(" ")} ${plain}`.toLowerCase();
}

export async function adminHelpArticlesRoutes(app: FastifyInstance) {
  const P = "/admin/help/articles";

  // ─── LIST ────────────────────────────────────────────────
  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const page  = Number(q.page  ?? 1);
    const limit = Number(q.limit ?? 30);

    const where: any = { schoolId };
    if (q.status)     where.status     = q.status;
    if (q.categoryId) where.categoryId = Number(q.categoryId);
    if (q.featured === "true") where.isFeatured = true;
    if (q.search) {
      where.OR = [
        { title:        { contains: q.search, mode: "insensitive" } },
        { searchVector: { contains: q.search.toLowerCase() } },
        { tags: { has: q.search.toLowerCase() } },
      ];
    }

    const [articles, total] = await Promise.all([
      prisma.helpArticle.findMany({
        where,
        include: {
          category: { select: { name: true, color: true, icon: true } },
          author:   { select: { name: true } },
          _count:   { select: { feedback: true, revisions: true } },
        },
        orderBy: [{ isFeatured: "desc" }, { updatedAt: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.helpArticle.count({ where }),
    ]);

    return rep.send({ articles, total, page, pages: Math.ceil(total / limit) });
  });

  // ─── GET ONE ────────────────────────────────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const article = await prisma.helpArticle.findFirst({
      where: { id, schoolId },
      include: {
        category: { select: { name: true, color: true } },
        author:   { select: { name: true, avatarUrl: true } },
        feedback: { orderBy: { createdAt: "desc" }, take: 10, include: { user: { select: { name: true } } } },
        revisions:{ orderBy: { version: "desc" }, take: 5, select: { id: true, version: true, changeNote: true, createdAt: true, changedById: true } },
      },
    });
    if (!article) return rep.code(404).send({ error: "Article not found" });
    // Increment view count
    await prisma.helpArticle.update({ where: { id }, data: { viewCount: { increment: 1 } } });
    // Related articles (same category, same tags)
    const related = await prisma.helpArticle.findMany({
      where: { schoolId, categoryId: article.categoryId, status: "PUBLISHED", id: { not: id } },
      select: { id: true, title: true, viewCount: true },
      take: 4,
    });
    return rep.send({ article, related });
  });

  // ─── CREATE ──────────────────────────────────────────────
  app.post(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const b = req.body as any;
    const tags: string[] = b.tags ?? [];
    const baseSlug = slugify(b.title ?? "untitled");
    const existing = await prisma.helpArticle.count({ where: { schoolId, slug: { startsWith: baseSlug } } });
    const slug     = existing > 0 ? `${baseSlug}-${existing + 1}` : baseSlug;
    const searchVector = buildSearchVector(b.title ?? "", b.content ?? "", tags);

    const article = await prisma.helpArticle.create({
      data: {
        schoolId, title: b.title, slug, content: b.content ?? "",
        excerpt: b.excerpt ?? (b.content ?? "").replace(/<[^>]+>/g, "").slice(0, 200),
        tags, searchVector,
        status: b.status as any ?? "DRAFT",
        categoryId:  b.categoryId  ? Number(b.categoryId)  : null,
        visibility:  b.visibility  as any ?? null,
        isFeatured:  b.isFeatured  ?? false,
        authorId:    Number(userId),
        publishedAt: b.status === "PUBLISHED" ? new Date() : null,
      },
    });

    // Update category article count
    if (b.categoryId) {
      await prisma.helpCategory.update({ where: { id: Number(b.categoryId) }, data: { articleCount: { increment: 1 } } });
    }

    // Create initial revision
    await prisma.helpArticleRevision.create({ data: { articleId: article.id, version: 1, title: article.title, content: article.content, changedById: Number(userId), changeNote: "Initial version" } });

    return rep.code(201).send({ article });
  });

  // ─── UPDATE ──────────────────────────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const tags: string[] = b.tags ?? [];
    const existing = await prisma.helpArticle.findFirst({ where: { id, schoolId } });
    if (!existing) return rep.code(404).send({ error: "Not found" });

    const searchVector = buildSearchVector(b.title ?? existing.title, b.content ?? existing.content, tags);

    const article = await prisma.helpArticle.update({
      where: { id },
      data: {
        title:      b.title,
        content:    b.content,
        excerpt:    b.excerpt ?? (b.content ?? "").replace(/<[^>]+>/g, "").slice(0, 200),
        tags, searchVector,
        status:     b.status as any,
        categoryId: b.categoryId  ? Number(b.categoryId)  : undefined,
        visibility: b.visibility  as any ?? undefined,
        isFeatured: b.isFeatured,
        publishedAt: b.status === "PUBLISHED" && !existing.publishedAt ? new Date() : undefined,
      },
    });

    // Save revision
    const lastRev = await prisma.helpArticleRevision.findFirst({ where: { articleId: id }, orderBy: { version: "desc" } });
    await prisma.helpArticleRevision.create({ data: { articleId: id, version: (lastRev?.version ?? 0) + 1, title: article.title, content: article.content, changedById: Number(userId), changeNote: b.changeNote ?? null } });

    return rep.send({ article });
  });

  // ─── PUBLISH / ARCHIVE quick actions ─────────────────────
  app.post(`${P}/:id/publish`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const article = await prisma.helpArticle.update({ where: { id, schoolId }, data: { status: "PUBLISHED", publishedAt: new Date() } });
    return rep.send({ article });
  });

  app.post(`${P}/:id/archive`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const article = await prisma.helpArticle.update({ where: { id, schoolId }, data: { status: "ARCHIVED" } });
    return rep.send({ article });
  });

  app.post(`${P}/:id/feature`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const existing = await prisma.helpArticle.findFirst({ where: { id, schoolId }, select: { isFeatured: true } });
    const article = await prisma.helpArticle.update({ where: { id, schoolId }, data: { isFeatured: !existing?.isFeatured } });
    return rep.send({ article });
  });

  // ─── FEEDBACK ────────────────────────────────────────────
  app.post(`${P}/:id/feedback`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { userId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const helpful = b.helpful === true;
    const fb = await prisma.helpArticleFeedback.create({ data: { articleId: id, userId: Number(userId), helpful, comment: b.comment ?? null } });
    // Update denormalised counts
    await prisma.helpArticle.update({ where: { id }, data: helpful ? { helpfulCount: { increment: 1 } } : { notHelpfulCount: { increment: 1 } } });
    return rep.code(201).send({ feedback: fb });
  });

  // ─── RESTORE REVISION ────────────────────────────────────
  app.post(`${P}/:id/restore/:revId`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const id    = Number((req.params as any).id);
    const revId = Number((req.params as any).revId);
    const rev   = await prisma.helpArticleRevision.findFirst({ where: { id: revId, articleId: id } });
    if (!rev) return rep.code(404).send({ error: "Revision not found" });
    const article = await prisma.helpArticle.update({ where: { id, schoolId }, data: { title: rev.title, content: rev.content, searchVector: buildSearchVector(rev.title, rev.content, []) } });
    const lastRev = await prisma.helpArticleRevision.findFirst({ where: { articleId: id }, orderBy: { version: "desc" } });
    await prisma.helpArticleRevision.create({ data: { articleId: id, version: (lastRev?.version ?? 0) + 1, title: rev.title, content: rev.content, changedById: Number(userId), changeNote: `Restored from v${rev.version}` } });
    return rep.send({ article });
  });

  // ─── SEARCH (public endpoint for users) ──────────────────
  app.get(`${P}/search`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = (req.query as any).q ?? "";
    if (!q.trim()) return rep.send({ articles: [] });
    const articles = await prisma.helpArticle.findMany({
      where: { schoolId, status: "PUBLISHED", OR: [
        { title: { contains: q, mode: "insensitive" } },
        { searchVector: { contains: q.toLowerCase() } },
        { tags: { hasSome: [q.toLowerCase()] } },
      ]},
      include: { category: { select: { name: true, color: true } } },
      orderBy: [{ isFeatured: "desc" }, { viewCount: "desc" }],
      take: 10,
    });
    return rep.send({ articles, query: q });
  });

  // ─── REPORTS ─────────────────────────────────────────────
  app.get(`${P}/reports/summary`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [byStatus, topViewed, leastViewed, featured, feedbackAgg] = await Promise.all([
      prisma.helpArticle.groupBy({ by: ["status"], where: { schoolId }, _count: { id: true }, _sum: { viewCount: true } }),
      prisma.helpArticle.findMany({ where: { schoolId, status: "PUBLISHED" }, orderBy: { viewCount: "desc" }, take: 5, select: { id: true, title: true, viewCount: true, helpfulCount: true, notHelpfulCount: true } }),
      prisma.helpArticle.findMany({ where: { schoolId, status: "PUBLISHED", viewCount: { lte: 5 } }, orderBy: { viewCount: "asc" }, take: 5, select: { id: true, title: true, viewCount: true } }),
      prisma.helpArticle.count({ where: { schoolId, isFeatured: true } }),
      prisma.helpArticle.aggregate({ where: { schoolId }, _sum: { helpfulCount: true, notHelpfulCount: true, viewCount: true } }),
    ]);
    const totalHelpful = Number(feedbackAgg._sum.helpfulCount ?? 0);
    const totalVotes   = totalHelpful + Number(feedbackAgg._sum.notHelpfulCount ?? 0);
    return rep.send({ byStatus, topViewed, leastViewed, featured, totalViews: feedbackAgg._sum.viewCount, helpfulnessPct: totalVotes > 0 ? Math.round((totalHelpful / totalVotes) * 100) : null });
  });
}
