// apps/api/src/routes/admin/library/lib-digital-library-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { assertStorageLimitNotExceeded, StorageLimitError } from "../../../services/storage.service.js";

export async function adminLibDigitalLibraryRoutes(app: FastifyInstance) {
  const P = "/admin/library/digital";

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('library.digital')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [total, byType, totalViews, totalDownloads, totalBookmarks] = await Promise.all([
        prisma.libDigitalResource.count({ where: { schoolId, isActive: true } }),
        prisma.libDigitalResource.groupBy({
          by: ["resourceType"],
          where: { schoolId, isActive: true },
          _count: { id: true },
          orderBy: { _count: { id: "desc" } },
        }),
        prisma.libResourceView.count({ where: { resource: { schoolId } } }),
        prisma.libResourceView.count({ where: { resource: { schoolId }, viewType: "DOWNLOAD" } }),
        prisma.libResourceBookmark.count({ where: { resource: { schoolId } } }),
      ]);

      // Top viewed
      const topViewed = await prisma.libDigitalResource.findMany({
        where: { schoolId, isActive: true },
        orderBy: { viewCount: "desc" },
        take: 6,
        select: { id: true, title: true, resourceType: true, viewCount: true, downloadCount: true, thumbnailUrl: true, author: true },
      });

      // Recently added
      const recentlyAdded = await prisma.libDigitalResource.findMany({
        where: { schoolId, isActive: true },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { id: true, title: true, resourceType: true, createdAt: true, thumbnailUrl: true, author: true, class: { select: { name: true } } },
      });

      // Featured
      const featured = await prisma.libDigitalResource.findMany({
        where: { schoolId, isActive: true, isFeatured: true },
        take: 4,
        select: { id: true, title: true, resourceType: true, thumbnailUrl: true, viewCount: true },
      });

      return rep.send({
        kpis: { total, byType, totalViews, totalDownloads, totalBookmarks },
        topViewed, recentlyAdded, featured,
      });
    }
  );

  // ─── LIST RESOURCES ───────────────────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('library.digital')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 30);

      const where: any = { schoolId, isActive: true };
      if (q.resourceType) where.resourceType = q.resourceType;
      if (q.classId)      where.classId      = Number(q.classId);
      if (q.subjectName)  where.subjectName  = q.subjectName;
      if (q.classNumber)  where.classNumber  = q.classNumber;
      if (q.language)     where.language     = q.language;
      if (q.featured === "true") where.isFeatured = true;
      if (q.search) {
        where.OR = [
          { title:       { contains: q.search, mode: "insensitive" } },
          { description: { contains: q.search, mode: "insensitive" } },
          { author:      { contains: q.search, mode: "insensitive" } },
          { tags:        { has: q.search } },
        ];
      }

      const [resources, total] = await Promise.all([
        prisma.libDigitalResource.findMany({
          where,
          include: {
            class:   { select: { name: true } },
          },
          orderBy: q.sortBy === "popular" ? { viewCount: "desc" } : { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.libDigitalResource.count({ where }),
      ]);

      return rep.send({ resources, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── GET ONE ──────────────────────────────────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability('library.digital')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const resource = await prisma.libDigitalResource.findFirst({
        where: { id, schoolId },
        include: {
          class:   { select: { name: true } },
          _count:  { select: { bookmarks: true, views: true } },
        },
      });
      if (!resource) return rep.code(404).send({ error: "Not found" });
      return rep.send({ resource });
    }
  );

  // ─── CREATE ───────────────────────────────────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('library.digital')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      try {
        await assertStorageLimitNotExceeded(schoolId, b.fileSizeKb ? Number(b.fileSizeKb) * 1024 : 0);
      } catch (err) {
        if (err instanceof StorageLimitError) return rep.status(507).send({ success: false, message: err.message });
        throw err;
      }

      const resource = await prisma.libDigitalResource.create({
        data: {
          schoolId,
          studyMaterialId: b.studyMaterialId ? Number(b.studyMaterialId) : null,
          title:           b.title,
          description:     b.description ?? null,
          resourceType:    b.resourceType as any ?? "EBOOK",
          author:          b.author ?? null,
          publisher:       b.publisher ?? null,
          isbn:            b.isbn ?? null,
          edition:         b.edition ?? null,
          language:        b.language ?? "English",
          classId:         b.classId   ? Number(b.classId)   : null,
          subjectName:     b.subjectName ?? null,
          classNumber:     b.classNumber ?? null,
          fileUrl:         b.fileUrl   ?? null,
          thumbnailUrl:    b.thumbnailUrl ?? null,
          externalUrl:     b.externalUrl ?? null,
          fileSizeKb:      b.fileSizeKb ? Number(b.fileSizeKb) : null,
          totalPages:      b.totalPages ? Number(b.totalPages) : null,
          tags:            b.tags ?? [],
          accessRoles:     b.accessRoles ?? ["STUDENT","TEACHER","STAFF"],
          isFeatured:      b.isFeatured ?? false,
          createdById:     Number(userId),
        },
      });

      return rep.code(201).send({ resource });
    }
  );

  // ─── UPDATE ───────────────────────────────────────────────
  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('library.digital')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;

      const resource = await prisma.libDigitalResource.update({
        where: { id, schoolId },
        data: {
          title:        b.title,
          description:  b.description,
          resourceType: b.resourceType as any,
          author:       b.author, publisher: b.publisher, isbn: b.isbn, edition: b.edition,
          language:     b.language,
          classId:      b.classId   ? Number(b.classId)   : undefined,
          subjectName:  b.subjectName ?? undefined,
          classNumber:  b.classNumber ?? undefined,
          fileUrl:      b.fileUrl, thumbnailUrl: b.thumbnailUrl, externalUrl: b.externalUrl,
          fileSizeKb:   b.fileSizeKb ? Number(b.fileSizeKb) : undefined,
          totalPages:   b.totalPages ? Number(b.totalPages) : undefined,
          tags:         b.tags, accessRoles: b.accessRoles,
          isActive:     b.isActive, isFeatured: b.isFeatured,
        },
      });

      return rep.send({ resource });
    }
  );

  // ─── DELETE ───────────────────────────────────────────────
  app.delete(`${P}/:id`, { preHandler: [authenticate, requireCapability('library.digital')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.libDigitalResource.update({ where: { id, schoolId }, data: { isActive: false } });
      return rep.send({ ok: true });
    }
  );

  // ─── TRACK ACCESS (view / download) ──────────────────────
  app.post(`${P}/:id/access`, { preHandler: [authenticate, requireCapability('library.digital')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const id       = Number((req.params as any).id);
      const viewType = ((req.body as any).type ?? "VIEW") as string;

      // Increment counters
      await prisma.libDigitalResource.update({
        where: { id },
        data: {
          viewCount:     viewType === "VIEW"     ? { increment: 1 } : undefined,
          downloadCount: viewType === "DOWNLOAD" ? { increment: 1 } : undefined,
        },
      });

      // Find student/staff by userId
      const [student, staff] = await Promise.all([
        prisma.student.findFirst({ where: { userId: Number(userId) }, select: { id: true } }),
        prisma.staff.findFirst(  { where: { userId: Number(userId) }, select: { id: true } }),
      ]);

      await prisma.libResourceView.create({
        data: { resourceId: id, studentId: student?.id ?? null, staffId: staff?.id ?? null, viewType },
      });

      return rep.send({ ok: true });
    }
  );

  // ─── BOOKMARK TOGGLE ──────────────────────────────────────
  app.post(`${P}/:id/bookmark`, { preHandler: [authenticate, requireCapability('library.digital')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { userId } = req.user as any;
      const id = Number((req.params as any).id);

      const [student, staff] = await Promise.all([
        prisma.student.findFirst({ where: { userId: Number(userId) }, select: { id: true } }),
        prisma.staff.findFirst(  { where: { userId: Number(userId) }, select: { id: true } }),
      ]);

      const existsWhere: any = { resourceId: id };
      if (student) existsWhere.studentId = student.id;
      else if (staff) existsWhere.staffId = staff.id;

      const exists = await prisma.libResourceBookmark.findFirst({ where: existsWhere });
      if (exists) {
        await prisma.libResourceBookmark.delete({ where: { id: exists.id } });
        await prisma.libDigitalResource.update({ where: { id }, data: { bookmarkCount: { decrement: 1 } } });
        return rep.send({ bookmarked: false });
      } else {
        await prisma.libResourceBookmark.create({
          data: { resourceId: id, studentId: student?.id ?? null, staffId: staff?.id ?? null, pageNo: (req.body as any).pageNo ?? null },
        });
        await prisma.libDigitalResource.update({ where: { id }, data: { bookmarkCount: { increment: 1 } } });
        return rep.send({ bookmarked: true });
      }
    }
  );

  // ─── USAGE ANALYTICS ──────────────────────────────────────
  app.get(`${P}/analytics/usage`, { preHandler: [authenticate, requireCapability('library.digital')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [byType, topViewed, topDownloaded, byAccess] = await Promise.all([
        prisma.libDigitalResource.groupBy({
          by: ["resourceType"],
          where: { schoolId, isActive: true },
          _count: { id: true },
          _sum:   { viewCount: true, downloadCount: true },
          orderBy: { _sum: { viewCount: "desc" } },
        }),
        prisma.libDigitalResource.findMany({
          where: { schoolId, isActive: true },
          orderBy: { viewCount: "desc" }, take: 8,
          select: { id: true, title: true, resourceType: true, viewCount: true, thumbnailUrl: true },
        }),
        prisma.libDigitalResource.findMany({
          where: { schoolId, isActive: true },
          orderBy: { downloadCount: "desc" }, take: 8,
          select: { id: true, title: true, resourceType: true, downloadCount: true, thumbnailUrl: true },
        }),
        prisma.libResourceView.groupBy({
          by: ["viewType"],
          where: { resource: { schoolId } },
          _count: { id: true },
        }),
      ]);

      return rep.send({ byType, topViewed, topDownloaded, byAccess });
    }
  );

  // ─── IMPORT FROM STUDY CENTER ─────────────────────────────
  // Pull StudyMaterials from Study Center into Digital Library
  app.post(`${P}/import-from-study-center`, { preHandler: [authenticate, requireCapability('library.digital')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      const materialIds = b.materialIds as number[];
      if (!materialIds?.length) return rep.code(400).send({ error: "Provide materialIds" });

      const materials = await prisma.studyMaterial.findMany({
        where: { schoolId, id: { in: materialIds } },
      });

      try {
        const totalIncomingKb = materials.reduce((sum, m) => sum + (m.fileSizeKb ?? 0), 0);
        await assertStorageLimitNotExceeded(schoolId, totalIncomingKb * 1024);
      } catch (err) {
        if (err instanceof StorageLimitError) return rep.status(507).send({ success: false, message: err.message });
        throw err;
      }

      let imported = 0;
      for (const m of materials) {
        const exists = await prisma.libDigitalResource.findFirst({ where: { schoolId, studyMaterialId: m.id } });
        if (!exists) {
          // Map StudyMaterial type to LibDigitalResourceType
          const rtype = m.type === "VIDEO" ? "VIDEO"
            : m.type === "PDF" || m.type === "NOTES" ? "EBOOK"
            : m.type === "QUESTION_BANK" ? "QUESTION_BANK"
            : "STUDY_RESOURCE";

          await prisma.libDigitalResource.create({
            data: {
              schoolId, studyMaterialId: m.id,
              title: m.title, description: m.description,
              resourceType: rtype as any,
              classId:  m.classId,  classNumber: m.classNumber, subjectName: m.subjectName,
              fileUrl:  m.fileUrl ?? null, thumbnailUrl: m.thumbnailUrl ?? null,
              externalUrl: m.externalUrl ?? null, fileSizeKb: m.fileSizeKb,
              tags: m.tags, createdById: Number(userId),
            },
          });
          imported++;
        }
      }

      return rep.send({ imported, total: materials.length });
    }
  );

  // ─── ACCESS CONTROL UPDATE ────────────────────────────────
  app.patch(`${P}/:id/access-control`, { preHandler: [authenticate, requireCapability('library.digital')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const { accessRoles } = req.body as any;
      const resource = await prisma.libDigitalResource.update({
        where: { id, schoolId }, data: { accessRoles },
      });
      return rep.send({ resource });
    }
  );
}
