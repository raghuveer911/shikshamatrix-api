import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authenticate } from "../middleware/authenticate.js";
import {
  validateUpload,
  buildObjectKey,
  uploadBufferToR2,
  getObjectFromR2,
  UploadValidationError,
} from "../services/upload.service.js";
import { assertStorageLimitNotExceeded, StorageLimitError } from "../services/storage.service.js";

export async function uploadRoutes(app: FastifyInstance) {
  // ── POST /uploads — multipart file upload, returns a URL to use
  // as fileUrl/attachment.url in any message/document/material record.
  // category is a free-form folder name (e.g. "chat", "study-materials",
  // "hr-docs") purely for organizing objects in the bucket.
  app.post(
    "/uploads",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const data = await (request as any).file();

      if (!data) {
        return reply.status(400).send({ success: false, message: "No file provided." });
      }

      const category = (data.fields?.category?.value as string) || "misc";
      const buffer = await data.toBuffer();

      try {
        validateUpload(data.mimetype, buffer.length);
        await assertStorageLimitNotExceeded(schoolId, buffer.length);
      } catch (err) {
        if (err instanceof UploadValidationError || err instanceof StorageLimitError) {
          return reply.status(400).send({ success: false, message: err.message });
        }
        throw err;
      }

      const key = buildObjectKey(schoolId, category, data.filename);
      await uploadBufferToR2(key, buffer, data.mimetype);

      // school-website images AND the school's own logo/branding (used on
      // the public site's navbar) need to load for anonymous visitors —
      // everything else stays behind the authenticated /files/ route.
      const PUBLIC_CATEGORIES = ["school-website", "school-branding"];
      const urlPrefix = PUBLIC_CATEGORIES.includes(category) ? "/public/files/" : "/files/";

      return reply.send({
        success: true,
        data: {
          url: `${urlPrefix}${key}`,
          name: data.filename,
          size: buffer.length,
          mimeType: data.mimetype,
        },
      });
    }
  );

  // ── GET /files/* — authenticated proxy to R2. Files stay private in
  // the bucket; anyone hitting this URL must have a valid login token
  // for THIS school, so student/staff/parent documents aren't publicly
  // exposed just because someone guesses/shares a link.
  app.get(
    "/files/*",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const key = (request.params as any)["*"] as string;

      // Object keys are always "schools/<schoolId>/...": block cross-school access.
      if (!key.startsWith(`schools/${schoolId}/`)) {
        return reply.status(403).send({ success: false, message: "Forbidden." });
      }

      try {
        const object = await getObjectFromR2(key);
        reply.header("Content-Type", object.ContentType ?? "application/octet-stream");
        reply.header("Cache-Control", "private, max-age=3600");
        return reply.send(object.Body);
      } catch (err) {
        return reply.status(404).send({ success: false, message: "File not found." });
      }
    }
  );

  // ── GET /public/files/* — NO auth. Public school-website images
  // (logo, hero/about, gallery, testimonials) need to load for anyone
  // visiting the public site — they're never logged in. Scoped so ONLY
  // objects uploaded under the "school-website" category are reachable
  // this way; every other category (documents, chat, HR files, etc.)
  // still requires the authenticated /files/* route above.
  app.get(
    "/public/files/*",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const key = (request.params as any)["*"] as string;

      if (!/^schools\/\d+\/(school-website|school-branding)\//.test(key)) {
        return reply.status(403).send({ success: false, message: "Forbidden." });
      }

      try {
        const object = await getObjectFromR2(key);
        reply.header("Content-Type", object.ContentType ?? "application/octet-stream");
        reply.header("Cache-Control", "public, max-age=86400"); // public assets can cache harder — a whole day
        return reply.send(object.Body);
      } catch (err) {
        return reply.status(404).send({ success: false, message: "File not found." });
      }
    }
  );
}
