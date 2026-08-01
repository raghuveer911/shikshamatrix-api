import { prisma } from "../lib/prisma.js";

// Every table that stores an uploaded file's size, and how to read it.
// Some store bytes (`fileSize`), some store kilobytes (`fileSizeKb`) —
// normalized to bytes here so callers never have to think about units.
//
// Chat/messaging attachments (Message.fileSize, CommMessage.attachment)
// are deliberately EXCLUDED — casual chat photos shouldn't eat into a
// school's document storage plan. They still count toward the real R2
// bucket usage (see getRealR2UsageBytes for the superadmin-facing total),
// just not against any individual school's plan limit.
async function sumBytes(schoolId: number) {
  const [
    examDocs, savedReports, financialDocs, staffDocs,
    hrSavedReports, studyMaterials, libDigitalResources,
  ] = await Promise.all([
    prisma.examDocument.aggregate({ where: { schoolId }, _sum: { fileSize: true } }),
    prisma.savedReport.aggregate({ where: { schoolId }, _sum: { fileSize: true } }),
    prisma.financialDocument.aggregate({ where: { schoolId }, _sum: { fileSizeKb: true } }),
    prisma.staffDocument.aggregate({ where: { schoolId }, _sum: { fileSize: true } }),
    prisma.hrSavedReport.aggregate({ where: { schoolId }, _sum: { fileSizeKb: true } }),
    prisma.studyMaterial.aggregate({ where: { schoolId }, _sum: { fileSizeKb: true } }),
    prisma.libDigitalResource.aggregate({ where: { schoolId }, _sum: { fileSizeKb: true } }),
  ]);

  const bytesFields = [examDocs._sum.fileSize, staffDocs._sum.fileSize, savedReports._sum.fileSize];
  const kbFields = [financialDocs._sum.fileSizeKb, hrSavedReports._sum.fileSizeKb, studyMaterials._sum.fileSizeKb, libDigitalResources._sum.fileSizeKb];

  const totalBytes = bytesFields.reduce((sum: number, v) => sum + (v ?? 0), 0);
  const totalFromKb = kbFields.reduce((sum: number, v) => sum + (v ?? 0), 0) * 1024;

  return totalBytes + totalFromKb;
}

// Returns storage usage in GB, rounded to 2 decimal places — small schools
// will show 0.01GB etc. rather than a misleading flat 0.
export async function getStorageUsageGB(schoolId: number): Promise<number> {
  const bytes = await sumBytes(schoolId);
  return Math.round((bytes / (1024 * 1024 * 1024)) * 100) / 100;
}

// NOTE: this covers the file-upload tables that exist today. Any NEW
// upload feature added later (a new document/attachment table) should
// register its fileSize/fileSizeKb field here too, or storage usage will
// silently under-count it.

export class StorageLimitError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// Call this BEFORE accepting/saving a new file upload. Throws if the
// school is already at or over its plan's storage limit — existing files
// stay untouched (nothing gets deleted), this only blocks NEW uploads.
export async function assertStorageLimitNotExceeded(schoolId: number, incomingFileSizeBytes = 0) {
  const sub = await prisma.schoolSubscription.findUnique({
    where: { schoolId },
    include: { plan: { select: { storageGB: true, name: true } } },
  });

  // No active plan at all is handled by the normal subscription lock
  // (NO_SUBSCRIPTION / SUBSCRIPTION_INACTIVE) elsewhere — this check only
  // applies once a plan exists.
  if (!sub || sub.status !== "ACTIVE") return;

  const limitGB = sub.plan.storageGB;
  if (!limitGB || limitGB <= 0) return; // 0 = unlimited (Enterprise)

  const usedGB = await getStorageUsageGB(schoolId);
  const incomingGB = incomingFileSizeBytes / (1024 * 1024 * 1024);

  if (usedGB + incomingGB > limitGB) {
    throw new StorageLimitError(
      `Storage limit reached — you're using ${usedGB.toFixed(2)}GB of your ${sub.plan.name} plan's ${limitGB}GB limit. Delete some files or upgrade your plan to upload more.`
    );
  }
}
