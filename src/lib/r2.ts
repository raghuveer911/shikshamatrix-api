import { S3Client } from "@aws-sdk/client-s3";
import { env, isR2Configured } from "../config/env.js";

// Cloudflare R2 is S3-API-compatible — same SDK as AWS S3, just a
// different endpoint. If R2 isn't configured yet, `r2Client` is null
// and upload routes will return a clear "not configured" error instead
// of crashing at boot.
export const r2Client: S3Client | null = isR2Configured
  ? new S3Client({
      region: "auto",
      endpoint: env.R2_ENDPOINT,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      },
    })
  : null;

export const R2_BUCKET = env.R2_BUCKET_NAME;
