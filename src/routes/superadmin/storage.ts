// apps/api/src/routes/superadmin/storage.ts
//
// Real Cloudflare R2 bucket usage — reads actual object sizes directly
// from R2 via the S3 API (ListObjectsV2), not the per-school database
// tracking in storage.service.ts. This is the true safety net: chat
// attachments deliberately don't count against any school's plan limit,
// but they DO occupy real space in the bucket, so this is the only
// number that reflects what Cloudflare is actually billing/limiting on.
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET } from "../../lib/r2.js";
import { authenticateSuperAdmin } from "../../middleware/authenticate.js";

// R2's free tier — update this if/when the account moves to a paid tier.
const R2_FREE_TIER_GB = 10;

export async function superAdminStorageRoutes(app: FastifyInstance) {
  app.get(
    "/superadmin/storage/r2-usage",
    { preHandler: [authenticateSuperAdmin] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      if (!r2Client) {
        return rep.status(503).send({ success: false, message: "R2 is not configured on this server." });
      }

      try {
        let totalBytes = 0;
        let objectCount = 0;
        let continuationToken: string | undefined;

        // Paginate through the whole bucket — R2/S3 only returns up to
        // 1000 keys per call. Fine at current scale; if this ever grows
        // into the tens of thousands of objects, consider caching this
        // result for a few minutes instead of recomputing on every hit.
        do {
          const result = await r2Client.send(
            new ListObjectsV2Command({
              Bucket: R2_BUCKET,
              ContinuationToken: continuationToken,
            })
          );
          for (const obj of result.Contents ?? []) {
            totalBytes += obj.Size ?? 0;
            objectCount += 1;
          }
          continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
        } while (continuationToken);

        const usedGB = Math.round((totalBytes / (1024 * 1024 * 1024)) * 100) / 100;
        const pctUsed = Math.round((usedGB / R2_FREE_TIER_GB) * 1000) / 10;

        return rep.send({
          success: true,
          data: {
            usedGB,
            limitGB: R2_FREE_TIER_GB,
            pctUsed,
            objectCount,
            nearingLimit: pctUsed >= 80,
          },
        });
      } catch (err: any) {
        req.log.error({ err }, "Failed to fetch R2 usage");
        return rep.status(500).send({ success: false, message: "Could not fetch storage usage from R2." });
      }
    }
  );
}
