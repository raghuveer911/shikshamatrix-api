import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";

// Default templates
const DEFAULT_TEMPLATES = [
  {
    name: "Holiday Notice",
    category: "Holiday",
    title: "School Holiday Notice - {date}",
    content: "Dear Parents and Students,\n\nPlease be informed that the school will remain closed on {date} on account of {reason}.\n\nClasses will resume on {next_date}.\n\nRegards,\nSchool Administration",
  },
  {
    name: "PTM Reminder",
    category: "Meeting",
    title: "Parent-Teacher Meeting - {date}",
    content: "Dear Parents,\n\nThis is a reminder that the Parent-Teacher Meeting is scheduled on {date} from {time}.\n\nYour presence is important for your child's progress. Please make it a priority to attend.\n\nVenue: School Premises\n\nRegards,\nSchool Administration",
  },
  {
    name: "Exam Schedule",
    category: "Exam",
    title: "Upcoming Examination Schedule",
    content: "Dear Students and Parents,\n\nThe upcoming examinations are scheduled as follows:\n\nStart Date: {start_date}\nEnd Date: {end_date}\n\nPlease ensure students are well-prepared. All the best!\n\nRegards,\nSchool Administration",
  },
  {
    name: "Fee Reminder",
    category: "Fee",
    title: "Fee Payment Reminder - Due {date}",
    content: "Dear Parents,\n\nThis is a reminder that school fees for the current term are due by {date}.\n\nKindly clear the dues to avoid any inconvenience. For any queries, please contact the school office.\n\nRegards,\nAccounts Department",
  },
  {
    name: "Event Announcement",
    category: "Event",
    title: "{event_name} - {date}",
    content: "Dear Students and Parents,\n\nWe are pleased to announce {event_name} on {date} at {time}.\n\n{event_details}\n\nAll students are encouraged to participate. Looking forward to your enthusiastic involvement!\n\nRegards,\nSchool Administration",
  },
  {
    name: "Emergency Closure",
    category: "Emergency",
    title: "🚨 URGENT: School Closure Notice",
    content: "Dear Parents,\n\nDue to {reason}, the school will remain closed on {date}. This decision has been taken for the safety of all students and staff.\n\nWe will update you on further developments. Please stay safe.\n\nRegards,\nSchool Administration",
  },
];

export async function adminAnnouncementRoutes(app: FastifyInstance) {

  // ── GET /admin/announcements ──────────────────────────────
  app.get("/admin/announcements",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as {
        status?: string; target?: string;
        page?: string; limit?: string; search?: string;
      };

      const page = parseInt(q.page ?? "1");
      const limit = parseInt(q.limit ?? "12");
      const skip = (page - 1) * limit;

      const where: any = { schoolId };
      if (q.status && q.status !== "ALL") where.status = q.status;
      if (q.target && q.target !== "ALL") where.targetType = q.target;
      if (q.search) where.title = { contains: q.search, mode: "insensitive" };

      const [announcements, total] = await Promise.all([
        prisma.announcement.findMany({
          where, skip, take: limit,
          orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }],
          include: {
            createdBy: { select: { id: true, name: true, avatarUrl: true } },
            targetClass: { select: { id: true, name: true } },
            _count: { select: { reads: true } },
          },
        }),
        prisma.announcement.count({ where }),
      ]);

      // Stats
      const [total_ann, published, scheduled, drafts] = await Promise.all([
        prisma.announcement.count({ where: { schoolId } }),
        prisma.announcement.count({ where: { schoolId, status: "PUBLISHED" } }),
        prisma.announcement.count({ where: { schoolId, status: "SCHEDULED" } }),
        prisma.announcement.count({ where: { schoolId, status: "DRAFT" } }),
      ]);

      return reply.send({
        success: true,
        data: { announcements, total, page, limit, totalPages: Math.ceil(total / limit), stats: { total: total_ann, published, scheduled, drafts } },
      });
    }
  );

  // ── GET /admin/announcements/:id ──────────────────────────
  app.get("/admin/announcements/:id",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const ann = await prisma.announcement.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          createdBy: { select: { id: true, name: true, avatarUrl: true } },
          targetClass: { select: { id: true, name: true } },
          reads: {
            include: { user: { select: { id: true, name: true, role: true } } },
            orderBy: { readAt: "desc" },
            take: 20,
          },
          _count: { select: { reads: true } },
        },
      });

      if (!ann) return reply.status(404).send({ success: false, message: "Announcement not found." });
      return reply.send({ success: true, data: { announcement: ann } });
    }
  );

  // ── POST /admin/announcements ─────────────────────────────
  app.post("/admin/announcements",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        title: string;
        content: string;
        targetType: string;
        targetClassId?: number;
        targetGrade?: string;
        channels: string[];
        isUrgent?: boolean;
        isPinned?: boolean;
        status?: "DRAFT" | "PUBLISHED" | "SCHEDULED";
        scheduledAt?: string;
        imageUrl?: string;
        attachmentUrl?: string;
        attachmentName?: string;
      };

      if (!body.title?.trim() || !body.content?.trim()) {
        return reply.status(400).send({ success: false, message: "Title and content are required." });
      }

      const status = body.status ?? "DRAFT";
      const ann = await prisma.announcement.create({
        data: {
          schoolId,
          createdById: userId,
          title: body.title.trim(),
          content: body.content.trim(),
          targetType: body.targetType as any ?? "ALL",
          targetClassId: body.targetClassId ?? null,
          targetGrade: body.targetGrade ?? null,
          channels: body.channels ?? ["IN_APP"],
          isUrgent: body.isUrgent ?? false,
          isPinned: body.isPinned ?? false,
          status,
          scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
          publishedAt: status === "PUBLISHED" ? new Date() : null,
          imageUrl: body.imageUrl ?? null,
          attachmentUrl: body.attachmentUrl ?? null,
          attachmentName: body.attachmentName ?? null,
        },
        include: {
          createdBy: { select: { id: true, name: true } },
          _count: { select: { reads: true } },
        },
      });

      return reply.status(201).send({ success: true, message: `Announcement ${status.toLowerCase()}.`, data: { announcement: ann } });
    }
  );

  // ── PUT /admin/announcements/:id ──────────────────────────
  app.put("/admin/announcements/:id",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as any;

      const existing = await prisma.announcement.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return reply.status(404).send({ success: false, message: "Not found." });

      const ann = await prisma.announcement.update({
        where: { id: parseInt(id) },
        data: {
          title: body.title?.trim() ?? existing.title,
          content: body.content?.trim() ?? existing.content,
          targetType: body.targetType ?? existing.targetType,
          targetClassId: body.targetClassId ?? existing.targetClassId,
          targetGrade: body.targetGrade ?? existing.targetGrade,
          channels: body.channels ?? existing.channels,
          isUrgent: body.isUrgent ?? existing.isUrgent,
          isPinned: body.isPinned ?? existing.isPinned,
          status: body.status ?? existing.status,
          scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : existing.scheduledAt,
          publishedAt: body.status === "PUBLISHED" && !existing.publishedAt ? new Date() : existing.publishedAt,
          imageUrl: body.imageUrl ?? existing.imageUrl,
        },
      });

      return reply.send({ success: true, data: { announcement: ann } });
    }
  );

  // ── PATCH /admin/announcements/:id/publish ────────────────
  app.patch("/admin/announcements/:id/publish",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const ann = await prisma.announcement.update({
        where: { id: parseInt(id) },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });

      return reply.send({ success: true, message: "Announcement published!", data: { announcement: ann } });
    }
  );

  // ── PATCH /admin/announcements/:id/archive ────────────────
  app.patch("/admin/announcements/:id/archive",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      await prisma.announcement.update({
        where: { id: parseInt(id) },
        data: { status: "ARCHIVED" },
      });

      return reply.send({ success: true, message: "Archived." });
    }
  );

  // ── DELETE /admin/announcements/:id ──────────────────────
  app.delete("/admin/announcements/:id",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      await prisma.announcement.deleteMany({ where: { id: parseInt(id), schoolId } });
      return reply.send({ success: true, message: "Deleted." });
    }
  );

  // ── GET /admin/announcements/templates ────────────────────
  app.get("/admin/announcements/templates",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      let templates = await prisma.announcementTemplate.findMany({
        where: { schoolId }, orderBy: { createdAt: "desc" },
      });

      // Seed defaults if none exist
      if (templates.length === 0) {
        await prisma.announcementTemplate.createMany({
          data: DEFAULT_TEMPLATES.map(t => ({ ...t, schoolId })),
        });
        templates = await prisma.announcementTemplate.findMany({ where: { schoolId } });
      }

      return reply.send({ success: true, data: { templates } });
    }
  );

  // ── POST /admin/announcements/templates ───────────────────
  app.post("/admin/announcements/templates",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as { name: string; title: string; content: string; category: string; };

      const template = await prisma.announcementTemplate.create({
        data: { schoolId, ...body },
      });

      return reply.status(201).send({ success: true, data: { template } });
    }
  );

  // ── DELETE /admin/announcements/templates/:id ─────────────
  app.delete("/admin/announcements/templates/:id",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      await prisma.announcementTemplate.deleteMany({ where: { id: parseInt(id), schoolId } });
      return reply.send({ success: true });
    }
  );

  // ── GET /admin/announcements/stats ────────────────────────
  app.get("/admin/announcements/stats",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const recentPublished = await prisma.announcement.findMany({
        where: { schoolId, status: "PUBLISHED" },
        orderBy: { publishedAt: "desc" },
        take: 5,
        include: { _count: { select: { reads: true } } },
      });

      return reply.send({ success: true, data: { recentPublished } });
    }
  );
}