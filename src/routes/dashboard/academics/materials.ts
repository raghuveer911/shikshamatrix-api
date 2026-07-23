// apps/api/src/routes/dashboard/academics/materials.ts
//
// NEW MODULE — Study Materials.
//
// ⚠️ File upload is a PLACEHOLDER — same pattern as the Messages
// module's attachments: mobile sends a local file URI (or an
// external URL for LINK-type materials) directly. Wire fileUrl to
// your actual file-storage endpoint (S3/Cloudinary/etc.) once available.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { z } from "zod";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[academics/materials] "${label}" failed:`, err?.message ?? err); return fallback; }
}

const MATERIAL_TYPES = ["PDF","NOTES","PPT","VIDEO","IMAGE","WORKSHEET","QUESTION_BANK","REFERENCE","AUDIO","LINK"] as const;
const VISIBILITY_OPTIONS = ["TEACHER_ONLY","STUDENT_VISIBLE","PARENT_VISIBLE","PUBLIC"] as const;

const createSchema = z.object({
  title:        z.string().min(1),
  description:  z.string().optional(),
  classId:      z.number().optional(),
  subjectId:    z.number().optional(),
  chapterId:    z.number().optional(),
  topicId:      z.number().optional(),
  type:         z.enum(MATERIAL_TYPES),
  visibility:   z.enum(VISIBILITY_OPTIONS).default("STUDENT_VISIBLE"),
  fileUrl:      z.string().optional(),
  fileName:     z.string().optional(),
  mimeType:     z.string().optional(),
  externalUrl:  z.string().optional(),
  tags:         z.array(z.string()).optional(),
});

const updateSchema = z.object({
  title:       z.string().min(1).optional(),
  description: z.string().optional(),
  visibility:  z.enum(VISIBILITY_OPTIONS).optional(),
  tags:        z.array(z.string()).optional(),
});

export async function academicsMaterialsRoutes(app: FastifyInstance) {

  // ── GET /academics/materials?classId=&subjectId=&chapterId= ────
  app.get("/academics/materials",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { classId, subjectId, chapterId } = req.query as Record<string, string>;

      const materials = await safe("materials fetch", () =>
        prisma.studyMaterial.findMany({
          where: {
            schoolId, isArchived: false,
            ...(classId ? { classId: parseInt(classId) } : {}),
            ...(subjectId ? { subjectId: parseInt(subjectId) } : {}),
            ...(chapterId ? { chapterId: parseInt(chapterId) } : {}),
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true, title: true, description: true, type: true, visibility: true,
            fileUrl: true, fileName: true, fileSizeKb: true, mimeType: true, thumbnailUrl: true,
            externalUrl: true, tags: true, viewCount: true, downloadCount: true, createdAt: true,
            uploadedById: true,
            uploadedBy: { select: { user: { select: { name: true } } } },
            chapter: { select: { id: true, name: true, chapterNumber: true } },
            topic: { select: { id: true, name: true } },
          },
        }), [] as any[]);

      return reply.send({
        success: true,
        data: {
          materials: materials.map((m: any) => ({ ...m, isMine: m.uploadedById === staffId })),
        },
      });
    }
  );

  // ── POST /academics/materials — Upload/Create ───────────────
  app.post("/academics/materials",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;

      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });

      const { title, description, classId, subjectId, chapterId, topicId, type, visibility, fileUrl, fileName, mimeType, externalUrl, tags } = parsed.data;

      if (type !== "LINK" && !fileUrl) {
        return reply.status(400).send({ success: false, error: "FILE_REQUIRED", message: "Attach a file, or choose type LINK with a URL." });
      }
      if (type === "LINK" && !externalUrl) {
        return reply.status(400).send({ success: false, error: "URL_REQUIRED", message: "Enter a link URL." });
      }

      const material = await prisma.studyMaterial.create({
        data: {
          schoolId, uploadedById: staffId,
          classId: classId ?? null, subjectId: subjectId ?? null,
          chapterId: chapterId ?? null, topicId: topicId ?? null,
          title, description: description ?? null, type, visibility,
          fileUrl: fileUrl ?? null, fileName: fileName ?? null, mimeType: mimeType ?? null,
          externalUrl: externalUrl ?? null, tags: tags ?? [],
        },
      });

      return reply.status(201).send({ success: true, message: "Material uploaded", data: { id: material.id } });
    }
  );

  // ── PATCH /academics/materials/:id — Edit metadata ──────────
  app.patch("/academics/materials/:id",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { id } = req.params as { id: string };

      const existing = await prisma.studyMaterial.findFirst({ where: { id: parseInt(id), schoolId }, select: { uploadedById: true } });
      if (!existing) return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      if (existing.uploadedById !== staffId) {
        return reply.status(403).send({ success: false, error: "NOT_ALLOWED", message: "Only the uploader can edit this material." });
      }

      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });

      await prisma.studyMaterial.update({ where: { id: parseInt(id) }, data: parsed.data });
      return reply.send({ success: true, message: "Material updated" });
    }
  );

  // ── DELETE /academics/materials/:id — Archive (soft delete) ─
  app.delete("/academics/materials/:id",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { id } = req.params as { id: string };

      const existing = await prisma.studyMaterial.findFirst({ where: { id: parseInt(id), schoolId }, select: { uploadedById: true } });
      if (!existing) return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      if (existing.uploadedById !== staffId) {
        return reply.status(403).send({ success: false, error: "NOT_ALLOWED", message: "Only the uploader can remove this material." });
      }

      await prisma.studyMaterial.update({ where: { id: parseInt(id) }, data: { isArchived: true } });
      return reply.send({ success: true, message: "Material removed" });
    }
  );

  // ── PATCH /academics/materials/:id/view — Increment view count ──
  app.patch("/academics/materials/:id/view",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };

      await safe("view increment", () =>
        prisma.studyMaterial.update({
          where: { id: parseInt(id) },
          data: { viewCount: { increment: 1 } },
        }), null);

      return reply.send({ success: true });
    }
  );
}