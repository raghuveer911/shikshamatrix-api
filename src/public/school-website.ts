// apps/api/src/routes/public/school-website.ts
//
// These routes have NO authentication — anyone on the internet can hit
// them. That's the whole point (a public school website), but it means:
//   - Only ever return data explicitly meant to be public (isEnabled
//     websites, PUBLISHED+showOnWebsite notices, etc.) — never leak
//     internal-only fields.
//   - The enquiry POST is rate-limited harder than the platform default,
//     since it writes to the database and is the one endpoint spammers
//     would actually target.
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";

export async function publicSchoolWebsiteRoutes(app: FastifyInstance) {
  const P = "/public/school-website";

  // ── GET /public/school-website/:slug ───────────────────────
  app.get(`${P}/:slug`, async (req: FastifyRequest, rep: FastifyReply) => {
    const { slug } = req.params as { slug: string };

    const school = await prisma.school.findUnique({
      where: { slug },
      select: { id: true, name: true, logoUrl: true, address: true, city: true, state: true, phone: true, email: true },
    });
    if (!school) return rep.status(404).send({ success: false, message: "School not found." });

    const config = await prisma.websiteConfig.findUnique({
      where: { schoolId: school.id },
      include: {
        galleryImages: { orderBy: { sortOrder: "asc" } },
        testimonials: { orderBy: { sortOrder: "asc" } },
      },
    });

    if (!config || !config.isEnabled) {
      return rep.status(404).send({ success: false, message: "This school's website isn't available." });
    }

    const notices = config.showNotices
      ? await prisma.commNotice.findMany({
          where: { schoolId: school.id, showOnWebsite: true, status: "PUBLISHED" },
          select: { id: true, title: true, summary: true, publishAt: true, createdAt: true },
          orderBy: [{ isPinned: "desc" }, { publishAt: "desc" }],
          take: 10,
        })
      : [];

    return rep.send({
      success: true,
      data: {
        school,
        config: {
          theme: config.theme,
          primaryColor: config.primaryColor,
          heroTagline: config.heroTagline,
          heroImageUrl: config.heroImageUrl,
          aboutText: config.showAbout ? config.aboutText : null,
          aboutImageUrl: config.aboutImageUrl,
          admissionsText: config.showAdmissions ? config.admissionsText : null,
          admissionsPhone: config.admissionsPhone,
          admissionsEmail: config.admissionsEmail,
          showAbout: config.showAbout,
          showAdmissions: config.showAdmissions,
          showGallery: config.showGallery,
          showContact: config.showContact,
          showNotices: config.showNotices,
          showTestimonials: config.showTestimonials,
          enquiryEnabled: config.enquiryEnabled,
          metaTitle: config.metaTitle,
          metaDesc: config.metaDesc,
          galleryImages: config.showGallery ? config.galleryImages : [],
          testimonials: config.showTestimonials ? config.testimonials : [],
        },
        notices,
      },
    });
  });

  // ── POST /public/school-website/:slug/enquiry ──────────────
  app.post(
    `${P}/:slug/enquiry`,
    {
      config: {
        rateLimit: { max: 5, timeWindow: "10 minutes" },
      },
    },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { slug } = req.params as { slug: string };
      const b = req.body as {
        studentName?: string; parentName?: string; mobileNumber?: string; email?: string;
        interestedClass?: string; message?: string;
      };

      if (!b.studentName?.trim() || !b.mobileNumber?.trim()) {
        return rep.status(400).send({ success: false, message: "Student name and mobile number are required." });
      }
      if (!/^\+?\d{10,15}$/.test(b.mobileNumber.replace(/[\s-]/g, ""))) {
        return rep.status(400).send({ success: false, message: "Please enter a valid mobile number." });
      }

      const school = await prisma.school.findUnique({ where: { slug }, select: { id: true } });
      if (!school) return rep.status(404).send({ success: false, message: "School not found." });

      const config = await prisma.websiteConfig.findUnique({ where: { schoolId: school.id } });
      if (!config?.isEnabled || !config.enquiryEnabled) {
        return rep.status(404).send({ success: false, message: "Enquiries aren't open on this website." });
      }

      const enquiryNo = `WEB-${Date.now().toString(36).toUpperCase()}`;
      const admin = await prisma.user.findFirst({ where: { schoolId: school.id, role: "SCHOOL_ADMIN" }, select: { id: true } });
      if (!admin) return rep.status(500).send({ success: false, message: "Could not submit enquiry — please call the school directly." });

      await prisma.enquiry.create({
        data: {
          schoolId: school.id,
          enquiryNo,
          studentName: b.studentName.trim(),
          fatherName: b.parentName?.trim() ?? null,
          mobileNumber: b.mobileNumber.trim(),
          email: b.email?.trim() ?? null,
          interestedClass: b.interestedClass?.trim() ?? null,
          remarks: b.message?.trim() ?? null,
          source: "WEBSITE",
          createdById: admin.id,
        },
      });

      return rep.status(201).send({ success: true, message: "Thank you! The school will get back to you soon." });
    }
  );
}
