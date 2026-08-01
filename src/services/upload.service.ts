import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET } from "../lib/r2.js";
import { randomUUID } from "crypto";

// ── What's allowed for now ──────────────────────────────────
// Photos and small documents only — this keeps the free 10GB R2
// tier from filling up fast. Video and large/HD files are
// intentionally rejected with a friendly message; the UI should
// show those as "available soon" rather than letting the picker
// even try. Raise these limits later once a paid storage tier
// is in place.
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;   // 5MB — plenty for a compressed phone photo
const MAX_DOC_BYTES = 10 * 1024 * 1024;    // 10MB — small PDFs/docs

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function validateUpload(mimeType: string, sizeBytes: number) {
  if (mimeType.startsWith("video/")) {
    throw new UploadValidationError(
      "Video uploads are coming soon — not supported yet on the current plan."
    );
  }

  const isImage = ALLOWED_IMAGE_TYPES.includes(mimeType);
  const isDoc = mimeType === "application/pdf" || mimeType === "application/msword" || mimeType === DOCX_MIME;

  if (!isImage && !isDoc) {
    throw new UploadValidationError(
      "Unsupported file type. Only images (JPG/PNG/WEBP) and documents (PDF/DOC/DOCX) are supported right now."
    );
  }

  const maxBytes = isImage ? MAX_IMAGE_BYTES : MAX_DOC_BYTES;
  if (sizeBytes > maxBytes) {
    const maxMB = maxBytes / (1024 * 1024);
    throw new UploadValidationError(
      `File is too large — max ${maxMB}MB for ${isImage ? "images" : "documents"} right now. HD photos and large files are coming soon.`
    );
  }

  return { isImage, isDoc };
}

// Object key layout: schools/<schoolId>/<category>/<uuid>-<safeName>
// Keeping schoolId in the path means R2 storage can later be audited
// or cleaned up per-school without touching a database.
export function buildObjectKey(schoolId: number, category: string, originalName: string) {
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
  return `schools/${schoolId}/${category}/${randomUUID()}-${safeName}`;
}

export async function uploadBufferToR2(key: string, buffer: Buffer, contentType: string) {
  if (!r2Client) {
    throw new Error("R2 is not configured — set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME / R2_ENDPOINT in .env");
  }
  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
}

export async function getObjectFromR2(key: string) {
  if (!r2Client) {
    throw new Error("R2 is not configured");
  }
  const result = await r2Client.send(
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key })
  );
  return result;
}
