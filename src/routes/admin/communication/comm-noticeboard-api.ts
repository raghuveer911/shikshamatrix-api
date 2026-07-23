// apps/api/src/routes/admin/communication/comm-noticeboard-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { fanOutNotification } from "../../../services/notification-fanout.service.js";

export async function adminCommNoticeBoardRoutes(app: FastifyInstance) {
  const P = "/admin/comm/notices";

  // ─── LIST NOTICES ─────────────────────────────────────────
  app.get(P, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 30);
      const now   = new Date();

      const where: any = { schoolId };
      if (q.status)   where.status   = q.status;
      if (q.category) where.category = q.category;
      if (q.priority) where.priority = q.priority;
      if (q.pinned === "true") where.isPinned = true;
      if (q.search) {
        where.OR = [
          { title: { contains: q.search, mode: "insensitive" } },
          { summary: { contains: q.search, mode: "insensitive" } },
        ];
      }
      // Active-only filter
      if (q.active === "true") {
        where.status = "PUBLISHED";
        where.OR = [{ expiresAt: null }, { expiresAt: { gt: now } }];
      }

      const [notices, total] = await Promise.all([
        prisma.commNotice.findMany({
          where,
          include: {
            createdBy: { select: { name: true, avatarUrl: true, role: true } },
            approvedBy: { select: { name: true } },
            _count: { select: { seenBy: true } },
          },
          orderBy: [{ isPinned: "desc" }, { publishAt: "desc" }, { createdAt: "desc" }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.commNotice.count({ where }),
      ]);

      return rep.send({ notices, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── GET ONE ──────────────────────────────────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const notice = await prisma.commNotice.findFirst({
        where: { id, schoolId },
        include: {
          createdBy:  { select: { name: true, role: true } },
          approvedBy: { select: { name: true } },
          _count: { select: { seenBy: true } },
        },
      });
      if (!notice) return rep.code(404).send({ error: "Not found" });
      return rep.send({ notice });
    }
  );

  // ─── CREATE NOTICE ────────────────────────────────────────
  const VALID_CATEGORIES = ["GENERAL", "ACADEMIC", "EXAMINATION", "FEE", "TRANSPORT", "HOSTEL", "EVENTS", "EMERGENCY"];
  const VALID_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];
  const VALID_AUDIENCE_TYPES = ["ALL", "ALL_STUDENTS", "ALL_PARENTS", "ALL_TEACHERS", "ALL_STAFF", "CLASS_WISE", "SECTION_WISE", "TRANSPORT_ROUTE", "HOSTEL", "CUSTOM_SEGMENT", "FEE_DEFAULTERS"];

  function validateNoticeFields(b: any): string | null {
    if (b.category !== undefined && !VALID_CATEGORIES.includes(b.category)) {
      return `Invalid category "${b.category}". Must be one of: ${VALID_CATEGORIES.join(", ")}.`;
    }
    if (b.priority !== undefined && !VALID_PRIORITIES.includes(b.priority)) {
      return `Invalid priority "${b.priority}". Must be one of: ${VALID_PRIORITIES.join(", ")}.`;
    }
    if (b.audienceType !== undefined && !VALID_AUDIENCE_TYPES.includes(b.audienceType)) {
      return `Invalid target audience "${b.audienceType}". Must be one of: ${VALID_AUDIENCE_TYPES.join(", ")}.`;
    }
    return null;
  }

  app.post(P, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      if (!b.title?.trim()) {
        return rep.status(400).send({ success: false, message: "Title is required." });
      }
      const validationError = validateNoticeFields(b);
      if (validationError) {
        return rep.status(400).send({ success: false, message: validationError });
      }

      try {
        // Auto-generate notice number
        const count = await prisma.commNotice.count({ where: { schoolId } });
        const year  = new Date().getFullYear();
        const noticeNumber = `NOTICE-${year}-${String(count + 1).padStart(4, "0")}`;

        const notice = await prisma.commNotice.create({
          data: {
            schoolId,
            noticeNumber,
            title:         b.title,
            category:      b.category as any ?? "GENERAL",
            priority:      b.priority as any ?? "NORMAL",
            status:        b.submitForApproval ? "PENDING_APPROVAL" : (b.publishNow ? "PUBLISHED" : "DRAFT"),
            content:       b.content ?? "",
            summary:       b.summary ?? null,
            attachments:   b.attachments ?? [],
            audienceType:  b.audienceType as any ?? "ALL",
            targetClassIds: b.targetClassIds ?? [],
            targetUserIds:  b.targetUserIds ?? [],
            isPinned:      b.isPinned ?? false,
            publishAt:     b.publishAt   ? new Date(b.publishAt) : (b.publishNow ? new Date() : null),
            expiresAt:     b.expiresAt   ? new Date(b.expiresAt) : null,
            createdById:   Number(userId),
          },
        });

        let notifiedCount = 0;
        if (notice.status === "PUBLISHED") {
          notifiedCount = await fanOutNotification({
            schoolId,
            sourceType: "NOTICE",
            sourceId: notice.id,
            category: notice.category,
            priority: notice.priority,
            title: notice.title,
            body: notice.summary ?? notice.content.slice(0, 300),
            audienceType: notice.audienceType,
            targetClassIds: notice.targetClassIds,
            targetUserIds: notice.targetUserIds,
          });
        }

        return rep.code(201).send({ notice, notifiedCount });
      } catch (err: any) {
        console.error("[comm-notices] create failed:", err?.message ?? err);
        return rep.status(500).send({ success: false, message: "Couldn't create the notice. Please check the form and try again." });
      }
    }
  );

  // ─── UPDATE NOTICE ────────────────────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const validationError = validateNoticeFields(b);
      if (validationError) {
        return rep.status(400).send({ success: false, message: validationError });
      }

      try {
        const existing = await prisma.commNotice.findFirst({ where: { id, schoolId } });
        if (!existing) return rep.status(404).send({ success: false, message: "Notice not found." });

        // Same status logic as create: publishNow/submitForApproval checkboxes
        // take priority when present, otherwise fall back to an explicit
        // status field (used by internal calls that don't go through the form).
        const wasAlreadyPublished = existing.status === "PUBLISHED";
        const newStatus =
          b.submitForApproval !== undefined || b.publishNow !== undefined
            ? (b.submitForApproval ? "PENDING_APPROVAL" : (b.publishNow ? "PUBLISHED" : existing.status))
            : (b.status ?? existing.status);

        const notice = await prisma.commNotice.update({
          where: { id, schoolId },
          data: {
            title:          b.title,
            category:       b.category as any,
            priority:       b.priority as any,
            status:         newStatus as any,
            content:        b.content,
            summary:        b.summary,
            attachments:    b.attachments,
            audienceType:   b.audienceType as any,
            targetClassIds: b.targetClassIds,
            targetUserIds:  b.targetUserIds,
            isPinned:       b.isPinned,
            publishAt:      b.publishAt ? new Date(b.publishAt) : (newStatus === "PUBLISHED" && !existing.publishAt ? new Date() : undefined),
            expiresAt:      b.expiresAt  ? new Date(b.expiresAt)  : undefined,
          },
        });

        let notifiedCount = 0;
        if (notice.status === "PUBLISHED" && !wasAlreadyPublished) {
          notifiedCount = await fanOutNotification({
            schoolId,
            sourceType: "NOTICE",
            sourceId: notice.id,
            category: notice.category,
            priority: notice.priority,
            title: notice.title,
            body: notice.summary ?? notice.content.slice(0, 300),
            audienceType: notice.audienceType,
            targetClassIds: notice.targetClassIds,
            targetUserIds: notice.targetUserIds,
          });
        }

        return rep.send({ notice, notifiedCount });
      } catch (err: any) {
        console.error("[comm-notices] update failed:", err?.message ?? err);
        return rep.status(500).send({ success: false, message: "Couldn't update the notice. Please check the form and try again." });
      }
    }
  );

  // ─── PUBLISH ──────────────────────────────────────────────
  app.post(`${P}/:id/publish`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const notice = await prisma.commNotice.update({
        where: { id, schoolId },
        data: { status: "PUBLISHED", publishAt: new Date() },
      });

      const notifiedCount = await fanOutNotification({
        schoolId,
        sourceType: "NOTICE",
        sourceId: notice.id,
        category: notice.category,
        priority: notice.priority,
        title: notice.title,
        body: notice.summary ?? notice.content.slice(0, 300),
        audienceType: notice.audienceType,
        targetClassIds: notice.targetClassIds,
        targetUserIds: notice.targetUserIds,
      });

      return rep.send({ notice, notifiedCount });
    }
  );

  // ─── APPROVE ──────────────────────────────────────────────
  app.post(`${P}/:id/approve`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const notice = await prisma.commNotice.update({
        where: { id, schoolId },
        data: {
          status:      "PUBLISHED",
          publishAt:   new Date(),
          approvedById: Number(userId),
          approvedAt:  new Date(),
        },
      });

      const notifiedCount = await fanOutNotification({
        schoolId,
        sourceType: "NOTICE",
        sourceId: notice.id,
        category: notice.category,
        priority: notice.priority,
        title: notice.title,
        body: notice.summary ?? notice.content.slice(0, 300),
        audienceType: notice.audienceType,
        targetClassIds: notice.targetClassIds,
        targetUserIds: notice.targetUserIds,
      });

      return rep.send({ notice, notifiedCount });
    }
  );

  // ─── REJECT ───────────────────────────────────────────────
  app.post(`${P}/:id/reject`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const { reason } = req.body as any;
      const notice = await prisma.commNotice.update({
        where: { id, schoolId },
        data: { status: "DRAFT", rejectionNote: reason ?? null },
      });
      return rep.send({ notice });
    }
  );

  // ─── ARCHIVE ──────────────────────────────────────────────
  app.post(`${P}/:id/archive`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const notice = await prisma.commNotice.update({
        where: { id, schoolId },
        data: { status: "ARCHIVED" },
      });
      return rep.send({ notice });
    }
  );

  // ─── PIN / UNPIN ──────────────────────────────────────────
  app.post(`${P}/:id/pin`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const existing = await prisma.commNotice.findFirst({ where: { id, schoolId } });
      if (!existing) return rep.code(404).send({ error: "Not found" });
      const notice = await prisma.commNotice.update({
        where: { id },
        data: { isPinned: !existing.isPinned },
      });
      return rep.send({ notice, pinned: notice.isPinned });
    }
  );

  // ─── DELETE ───────────────────────────────────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.commNotice.delete({ where: { id, schoolId } });
      return rep.send({ ok: true });
    }
  );

  // ─── MARK AS SEEN ─────────────────────────────────────────
  app.post(`${P}/:id/seen`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const noticeId = Number((req.params as any).id);
      const { downloaded } = req.body as any;

      // Increment view count
      await prisma.commNotice.update({
        where: { id: noticeId },
        data: {
          viewCount:     { increment: 1 },
          downloadCount: downloaded ? { increment: 1 } : undefined,
        },
      });

      await prisma.commNoticeSeen.upsert({
        where: { noticeId_userId: { noticeId, userId: Number(userId) } },
        create: { noticeId, userId: Number(userId), downloaded: downloaded ?? false },
        update: { seenAt: new Date(), downloaded: downloaded ?? false },
      });

      return rep.send({ ok: true });
    }
  );

  // ─── READ TRACKING ────────────────────────────────────────
  app.get(`${P}/:id/readers`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const readers = await prisma.commNoticeSeen.findMany({
        where: { noticeId: id },
        include: { user: { select: { name: true, role: true, avatarUrl: true } } },
        orderBy: { seenAt: "desc" },
      });
      return rep.send({ readers, total: readers.length });
    }
  );

  // ─── STATS SUMMARY ────────────────────────────────────────
  app.get(`${P}/stats/summary`, { preHandler: [authenticate] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();

      const [draft, pendingApproval, published, expired, archived] = await Promise.all([
        prisma.commNotice.count({ where: { schoolId, status: "DRAFT" } }),
        prisma.commNotice.count({ where: { schoolId, status: "PENDING_APPROVAL" } }),
        prisma.commNotice.count({ where: { schoolId, status: "PUBLISHED" } }),
        prisma.commNotice.count({ where: { schoolId, status: "PUBLISHED", expiresAt: { lt: now } } }),
        prisma.commNotice.count({ where: { schoolId, status: "ARCHIVED" } }),
      ]);

      const byCategory = await prisma.commNotice.groupBy({
        by: ["category"],
        where: { schoolId },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      });

      return rep.send({ draft, pendingApproval, published, expired, archived, byCategory });
    }
  );
}
