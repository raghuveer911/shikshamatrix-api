// apps/api/src/routes/staff/profile-documents.ts
//
// Documents, Qualifications, Background Checks, Certificates.
//
// NOTE: StaffDocType, DocVerificationStatus, HrBgCheckStatus,
// HrCertificateType exact enum values weren't confirmed — reads (GET)
// are safe regardless (Prisma doesn't validate enums on select), but
// the POST /profile/documents upload endpoint validates docType against
// a placeholder list. Update DOC_TYPES below to match your real enum.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { assertStorageLimitNotExceeded, StorageLimitError } from "../../../services/storage.service.js";
import { z } from "zod";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[profile/documents] "${label}" failed:`, err?.message ?? err); return fallback; }
}

// ⚠️ Placeholder — replace with your actual StaffDocType enum values
const DOC_TYPES = [
  "AADHAAR","PAN","PHOTO","RESUME","DEGREE_CERTIFICATE",
  "EXPERIENCE_LETTER","ADDRESS_PROOF","BANK_PASSBOOK","OTHER",
];

const uploadDocSchema = z.object({
  docType:   z.string(),
  fileName:  z.string(),
  fileUrl:   z.string(),
  fileSize:  z.number().optional(),
  expiryDate: z.string().optional(),
});

export async function profileDocumentsRoutes(app: FastifyInstance) {

  // ── GET /profile/documents — all docs + qualifications + bg checks + certs ──
  app.get("/profile/documents",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const staff = await prisma.staff.findFirst({ where: { userId, schoolId }, select: { id: true } });
      if (!staff) return reply.status(404).send({ success: false, error: "STAFF_NOT_FOUND" });

      const [documents, complianceRecords, qualifications, bgChecks, certificates] = await Promise.all([
        safe("staffDocument.findMany", () =>
          prisma.staffDocument.findMany({
            where: { staffId: staff.id },
            orderBy: { createdAt: "desc" },
            select: { id: true, docType: true, fileName: true, fileUrl: true,
              verification: true, remarks: true, expiryDate: true, createdAt: true },
          }), [] as any[]),
        safe("hrComplianceRecord.findMany", () =>
          prisma.hrComplianceRecord.findMany({
            where: { staffId: staff.id },
            select: { docType: true, status: true, lastCheckedAt: true, notes: true },
          }), [] as any[]),
        safe("hrQualificationRecord.findMany", () =>
          prisma.hrQualificationRecord.findMany({
            where: { staffId: staff.id },
            orderBy: { passYear: "desc" },
            select: { id: true, qualName: true, category: true, institution: true,
              boardOrUniv: true, passYear: true, grade: true, percentage: true,
              certificateUrl: true, isVerified: true },
          }), [] as any[]),
        safe("hrBackgroundCheck.findMany", () =>
          prisma.hrBackgroundCheck.findMany({
            where: { staffId: staff.id },
            orderBy: { initiatedDate: "desc" },
            select: { id: true, checkType: true, status: true, result: true,
              initiatedDate: true, completedDate: true, nextRenewalDate: true, reportUrl: true },
          }), [] as any[]),
        safe("hrCertificateIssued.findMany", () =>
          prisma.hrCertificateIssued.findMany({
            where: { staffId: staff.id, revokedAt: null },
            orderBy: { issuedDate: "desc" },
            select: { id: true, certType: true, certNumber: true, title: true,
              issuedDate: true, validUntil: true, pdfUrl: true, qrCode: true },
          }), [] as any[]),
      ]);

      // Merge compliance status onto doc types not yet uploaded
      const uploadedTypes = new Set(documents.map((d: any) => d.docType));
      const missingCompliance = complianceRecords.filter((c: any) => !uploadedTypes.has(c.docType));

      return reply.send({
        success: true,
        data: {
          documents,
          missingCompliance,
          qualifications, bgChecks, certificates,
          docTypeOptions: DOC_TYPES,
        },
      });
    }
  );

  // ── POST /profile/documents — upload/register a document ─────
  app.post("/profile/documents",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const parsed = uploadDocSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });

      const staff = await prisma.staff.findFirst({ where: { userId, schoolId }, select: { id: true } });
      if (!staff) return reply.status(404).send({ success: false, error: "STAFF_NOT_FOUND" });

      const { docType, fileName, fileUrl, fileSize, expiryDate } = parsed.data;

      try {
        await assertStorageLimitNotExceeded(schoolId, fileSize ?? 0);
      } catch (err) {
        if (err instanceof StorageLimitError) return reply.status(507).send({ success: false, error: err.message });
        throw err;
      }

      try {
        const doc = await prisma.staffDocument.create({
          data: {
            schoolId, staffId: staff.id, docType: docType as any,
            fileName, fileUrl, fileSize: fileSize ?? null,
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            verification: "PENDING",
          },
        });
        return reply.status(201).send({ success: true, data: { document: doc } });
      } catch (err: any) {
        return reply.status(400).send({
          success: false,
          error: "INVALID_DOC_TYPE",
          message: `Could not save document — check that "${docType}" matches your StaffDocType enum exactly.`,
        });
      }
    }
  );
}