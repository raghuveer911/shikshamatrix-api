// apps/api/src/routes/admin/help/help-categories-api.ts
// Pure TypeScript — NO JSX, NO className
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export async function adminHelpCategoriesRoutes(app: FastifyInstance) {
  const P = "/admin/help/categories";

  // ─── LIST (with children) ────────────────────────────────
  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    // Top-level by default; pass ?all=true to include sub-categories flat
    const where: any = { schoolId };
    if (q.all !== "true") where.parentId = null;
    if (q.visibility) where.visibility = q.visibility;
    if (q.isActive !== undefined) where.isActive = q.isActive === "true";

    const categories = await prisma.helpCategory.findMany({
      where,
      include: {
        children: {
          where: { isActive: true },
          orderBy: { sortOrder: "asc" },
          include: { _count: { select: { articles: true } } },
        },
        _count: { select: { articles: true } },
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    return rep.send({ categories });
  });

  // ─── GET ONE ─────────────────────────────────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const cat = await prisma.helpCategory.findFirst({
      where: { id, schoolId },
      include: {
        parent:   { select: { id: true, name: true } },
        children: { orderBy: { sortOrder: "asc" }, include: { _count: { select: { articles: true } } } },
        _count:   { select: { articles: true } },
      },
    });
    if (!cat) return rep.code(404).send({ error: "Category not found" });
    return rep.send({ category: cat });
  });

  // ─── CREATE ───────────────────────────────────────────────
  app.post(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const baseSlug = slugify(b.name);
    // Ensure unique slug
    const existing = await prisma.helpCategory.count({ where: { schoolId, slug: { startsWith: baseSlug } } });
    const slug = existing > 0 ? `${baseSlug}-${existing + 1}` : baseSlug;
    const cat = await prisma.helpCategory.create({
      data: {
        schoolId, name: b.name, slug, icon: b.icon ?? "HelpCircle", color: b.color ?? "#6366f1",
        description: b.description ?? null, visibility: b.visibility as any ?? "EVERYONE",
        parentId: b.parentId ? Number(b.parentId) : null, sortOrder: Number(b.sortOrder ?? 0),
      },
    });
    return rep.code(201).send({ category: cat });
  });

  // ─── UPDATE ───────────────────────────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const cat = await prisma.helpCategory.update({
      where: { id, schoolId },
      data: {
        name: b.name, icon: b.icon, color: b.color, description: b.description,
        visibility: b.visibility as any, parentId: b.parentId ? Number(b.parentId) : null,
        sortOrder: b.sortOrder !== undefined ? Number(b.sortOrder) : undefined,
        isActive: b.isActive,
      },
    });
    return rep.send({ category: cat });
  });

  // ─── REORDER (drag-drop) ──────────────────────────────────
  app.put(`${P}/reorder`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any; // { orders: [{ id, sortOrder }] }
    await Promise.all((b.orders ?? []).map((o: any) =>
      prisma.helpCategory.update({ where: { id: Number(o.id), schoolId }, data: { sortOrder: Number(o.sortOrder) } })
    ));
    return rep.send({ ok: true });
  });

  // ─── DELETE (soft) ────────────────────────────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const articleCount = await prisma.helpArticle.count({ where: { categoryId: id } });
    const childCount   = await prisma.helpCategory.count({ where: { parentId: id } });
    if (articleCount > 0 || childCount > 0)
      return rep.code(409).send({ error: `Cannot delete — has ${articleCount} articles and ${childCount} sub-categories` });
    await prisma.helpCategory.update({ where: { id, schoolId }, data: { isActive: false } });
    return rep.send({ ok: true });
  });

  // ─── SEED DEFAULTS ────────────────────────────────────────
  app.post(`${P}/seed`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const defaults = [
      { name:"Admissions",        icon:"UserPlus",   color:"#10b981" },
      { name:"Students",          icon:"Users",      color:"#6366f1" },
      { name:"Academics",         icon:"BookOpen",   color:"#f59e0b" },
      { name:"Exams",             icon:"ClipboardCheck", color:"#ef4444" },
      { name:"Finance & Fees",    icon:"Banknote",   color:"#22c55e" },
      { name:"Attendance",        icon:"Calendar",   color:"#0ea5e9" },
      { name:"Transport",         icon:"Bus",        color:"#8b5cf6" },
      { name:"Hostel",            icon:"Building2",  color:"#d97706" },
      { name:"Library",           icon:"Library",    color:"#0d9488" },
      { name:"HR & Staff",        icon:"Briefcase",  color:"#ec4899" },
      { name:"Communication",     icon:"MessageSquare", color:"#6366f1" },
      { name:"Inventory",         icon:"Package",    color:"#f97316" },
      { name:"Technical Support", icon:"Settings",   color:"#9ca3af" },
    ];
    let created = 0;
    for (let i = 0; i < defaults.length; i++) {
      const d = defaults[i];
      const slug = slugify(d.name);
      const exists = await prisma.helpCategory.findFirst({ where: { schoolId, slug } });
      if (!exists) {
        await prisma.helpCategory.create({ data: { schoolId, name: d.name, slug, icon: d.icon, color: d.color, sortOrder: i } });
        created++;
      }
    }
    return rep.send({ created, message: `${created} default categories created` });
  });

  // ─── ANALYTICS ────────────────────────────────────────────
  app.get(`${P}/analytics`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [totalCats, totalSubs, byVisibility] = await Promise.all([
      prisma.helpCategory.count({ where: { schoolId, parentId: null, isActive: true } }),
      prisma.helpCategory.count({ where: { schoolId, parentId: { not: null }, isActive: true } }),
      prisma.helpCategory.groupBy({ by: ["visibility"], where: { schoolId, isActive: true }, _count: { id: true } }),
    ]);
    const topViewed = await prisma.helpCategory.findMany({ where: { schoolId, isActive: true }, orderBy: { viewCount: "desc" }, take: 5, select: { id: true, name: true, color: true, viewCount: true, articleCount: true } });
    return rep.send({ totalCats, totalSubs, byVisibility, topViewed });
  });
}
