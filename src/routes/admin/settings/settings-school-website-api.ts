// apps/api/src/routes/admin/settings/settings-school-website-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

export async function adminSchoolWebsiteRoutes(app: FastifyInstance) {
  const P = "/admin/settings/website";

  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    let config = await prisma.websiteConfig.findUnique({ where: { schoolId }, include: { pages: { orderBy: { sortOrder: "asc" } } } });
    if (!config) {
      config = await prisma.websiteConfig.create({ data: { schoolId }, include: { pages: true } });
    }
    return rep.send({ config });
  });

  app.put(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const config = await prisma.websiteConfig.upsert({
      where: { schoolId },
      create: { schoolId, ...b },
      update: { isEnabled: b.isEnabled, domain: b.domain, theme: b.theme, primaryColor: b.primaryColor, showAbout: b.showAbout, showAdmissions: b.showAdmissions, showGallery: b.showGallery, showContact: b.showContact, showNotices: b.showNotices, showTestimonials: b.showTestimonials, enquiryEnabled: b.enquiryEnabled, enquiryEmail: b.enquiryEmail, metaTitle: b.metaTitle, metaDesc: b.metaDesc },
    });
    return rep.send({ config });
  });

  // Pages
  app.get(`${P}/pages`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const config = await prisma.websiteConfig.findUnique({ where: { schoolId } });
    if (!config) return rep.send({ pages: [] });
    const pages = await prisma.websitePage.findMany({ where: { configId: config.id }, orderBy: { sortOrder: "asc" } });
    return rep.send({ pages });
  });

  app.post(`${P}/pages`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    let config = await prisma.websiteConfig.findUnique({ where: { schoolId } });
    if (!config) config = await prisma.websiteConfig.create({ data: { schoolId } });
    const page = await prisma.websitePage.upsert({
      where: { configId_slug: { configId: config.id, slug: b.slug } },
      create: { configId: config.id, slug: b.slug, title: b.title, content: b.content ?? null, isPublished: b.isPublished ?? false, sortOrder: b.sortOrder ?? 0 },
      update: { title: b.title, content: b.content, isPublished: b.isPublished, sortOrder: b.sortOrder },
    });
    return rep.code(201).send({ page });
  });

  app.put(`${P}/pages/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const page = await prisma.websitePage.update({ where: { id }, data: { title: b.title, content: b.content, isPublished: b.isPublished, sortOrder: b.sortOrder } });
    return rep.send({ page });
  });

  // Preview URL
  app.get(`${P}/preview-url`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const config = await prisma.websiteConfig.findUnique({ where: { schoolId } });
    return rep.send({ url: config?.domain ?? `https://${schoolId}.shikshamatrix.in`, isEnabled: config?.isEnabled ?? false });
  });
}
