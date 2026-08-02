// apps/api/src/routes/admin/settings/settings-school-website-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

export async function adminSchoolWebsiteRoutes(app: FastifyInstance) {
  const P = "/admin/settings/website";

  // ── Config (create-if-missing, single row per school) ─────
  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    let config = await prisma.websiteConfig.findUnique({
      where: { schoolId },
      include: {
        galleryImages: { orderBy: { sortOrder: "asc" } },
        testimonials: { orderBy: { sortOrder: "asc" } },
      },
    });
    if (!config) {
      config = await prisma.websiteConfig.create({
        data: { schoolId },
        include: { galleryImages: true, testimonials: true },
      });
    }
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { slug: true } });
    return rep.send({ config, publicSlug: school?.slug ?? null });
  });

  app.put(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const config = await prisma.websiteConfig.upsert({
      where: { schoolId },
      create: {
        schoolId,
        isEnabled: b.isEnabled, theme: b.theme, primaryColor: b.primaryColor,
        heroTagline: b.heroTagline, heroImageUrl: b.heroImageUrl,
        aboutText: b.aboutText, aboutImageUrl: b.aboutImageUrl,
        admissionsText: b.admissionsText, admissionsPhone: b.admissionsPhone, admissionsEmail: b.admissionsEmail,
        showAbout: b.showAbout, showAdmissions: b.showAdmissions, showGallery: b.showGallery,
        showContact: b.showContact, showNotices: b.showNotices, showTestimonials: b.showTestimonials,
        enquiryEnabled: b.enquiryEnabled, enquiryEmail: b.enquiryEmail,
        metaTitle: b.metaTitle, metaDesc: b.metaDesc,
      },
      update: {
        isEnabled: b.isEnabled, theme: b.theme, primaryColor: b.primaryColor,
        heroTagline: b.heroTagline, heroImageUrl: b.heroImageUrl,
        aboutText: b.aboutText, aboutImageUrl: b.aboutImageUrl,
        admissionsText: b.admissionsText, admissionsPhone: b.admissionsPhone, admissionsEmail: b.admissionsEmail,
        showAbout: b.showAbout, showAdmissions: b.showAdmissions, showGallery: b.showGallery,
        showContact: b.showContact, showNotices: b.showNotices, showTestimonials: b.showTestimonials,
        enquiryEnabled: b.enquiryEnabled, enquiryEmail: b.enquiryEmail,
        metaTitle: b.metaTitle, metaDesc: b.metaDesc,
      },
    });
    return rep.send({ config });
  });

  // ── Gallery ─────────────────────────────────────────────
  app.post(`${P}/gallery`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { imageUrl: string; caption?: string };
    let config = await prisma.websiteConfig.findUnique({ where: { schoolId } });
    if (!config) config = await prisma.websiteConfig.create({ data: { schoolId } });
    const count = await prisma.websiteGalleryImage.count({ where: { configId: config.id } });
    const img = await prisma.websiteGalleryImage.create({
      data: { configId: config.id, imageUrl: b.imageUrl, caption: b.caption ?? null, sortOrder: count },
    });
    return rep.code(201).send({ image: img });
  });

  app.delete(`${P}/gallery/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    // Ownership check via the config relation, so one school can't delete another's image
    const img = await prisma.websiteGalleryImage.findFirst({ where: { id, config: { schoolId } } });
    if (!img) return rep.status(404).send({ success: false, message: "Not found." });
    await prisma.websiteGalleryImage.delete({ where: { id } });
    return rep.send({ success: true });
  });

  // ── Testimonials ────────────────────────────────────────
  app.post(`${P}/testimonials`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as { authorName: string; role?: string; quote: string; photoUrl?: string };
    if (!b.authorName?.trim() || !b.quote?.trim()) {
      return rep.status(400).send({ success: false, message: "Author name and quote are required." });
    }
    let config = await prisma.websiteConfig.findUnique({ where: { schoolId } });
    if (!config) config = await prisma.websiteConfig.create({ data: { schoolId } });
    const count = await prisma.websiteTestimonial.count({ where: { configId: config.id } });
    const t = await prisma.websiteTestimonial.create({
      data: { configId: config.id, authorName: b.authorName.trim(), role: b.role ?? null, quote: b.quote.trim(), photoUrl: b.photoUrl ?? null, sortOrder: count },
    });
    return rep.code(201).send({ testimonial: t });
  });

  app.delete(`${P}/testimonials/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const t = await prisma.websiteTestimonial.findFirst({ where: { id, config: { schoolId } } });
    if (!t) return rep.status(404).send({ success: false, message: "Not found." });
    await prisma.websiteTestimonial.delete({ where: { id } });
    return rep.send({ success: true });
  });
}
