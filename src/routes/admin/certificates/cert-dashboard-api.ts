// apps/api/src/routes/admin/certificates/cert-dashboard-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminCertDashboardRoutes(app: FastifyInstance) {
  const P = "/admin/certificates";

  // ─── MAIN DASHBOARD ───────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now   = new Date();
      const mFrom = new Date(now.getFullYear(), now.getMonth(), 1);
      const today = new Date(now); today.setHours(0, 0, 0, 0);

      const [
        totalTemplates, totalIssued, issuedThisMonth,
        pendingRequests, valid, revoked,
      ] = await Promise.all([
        prisma.certTemplate.count({ where: { schoolId, isActive: true } }),
        prisma.certIssued.count({ where: { schoolId } }),
        prisma.certIssued.count({ where: { schoolId, createdAt: { gte: mFrom } } }),
        prisma.certRequest.count({ where: { schoolId, status: "PENDING" } }),
        prisma.certIssued.count({ where: { schoolId, status: "VALID" } }),
        prisma.certIssued.count({ where: { schoolId, status: "REVOKED" } }),
      ]);

      // Category breakdown
      const categoryBreakdown = await prisma.certIssued.groupBy({
        by: ["category"],
        where: { schoolId },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      });

      // Type breakdown (top 8)
      const typeBreakdown = await prisma.certIssued.groupBy({
        by: ["certType"],
        where: { schoolId },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 8,
      });

      // Monthly trend (last 6 months)
      const monthlyTrend: { month: string; count: number }[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const dEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
        const count = await prisma.certIssued.count({
          where: { schoolId, createdAt: { gte: d, lte: dEnd } },
        });
        monthlyTrend.push({
          month: d.toLocaleString("default", { month: "short", year: "2-digit" }),
          count,
        });
      }

      // Recent activity (last 10)
      const recentActivity = await prisma.certIssued.findMany({
        where: { schoolId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true, certNumber: true, certType: true, category: true,
          recipientName: true, issuedDate: true, status: true, createdAt: true,
        },
      });

      // Recent requests
      const recentRequests = await prisma.certRequest.findMany({
        where: { schoolId, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: {
          student: { include: { user: { select: { name: true } } } },
          requestedBy: { select: { name: true } },
        },
      });

      // Top templates by usage
      const topTemplates = await prisma.certTemplate.findMany({
        where: { schoolId, isActive: true },
        orderBy: { usageCount: "desc" },
        take: 5,
        select: { id: true, name: true, certType: true, category: true, usageCount: true },
      });

      // Source module breakdown
      const moduleBreakdown = await prisma.certIssued.groupBy({
        by: ["sourceModule"],
        where: { schoolId, sourceModule: { not: null } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      });

      return rep.send({
        kpis: { totalTemplates, totalIssued, issuedThisMonth, pendingRequests, valid, revoked },
        categoryBreakdown, typeBreakdown, monthlyTrend,
        recentActivity, recentRequests, topTemplates, moduleBreakdown,
      });
    }
  );

  // ─── QUICK STATS (lightweight — for widget use) ────────────
  app.get(`${P}/quick-stats`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const [issuedToday, pendingRequests, expiringSoon] = await Promise.all([
        prisma.certIssued.count({ where: { schoolId, createdAt: { gte: today } } }),
        prisma.certRequest.count({ where: { schoolId, status: "PENDING" } }),
        prisma.certIssued.count({
          where: {
            schoolId,
            status: "VALID",
            validUntil: {
              gte: today,
              lte: new Date(Date.now() + 30 * 86400000),
            },
          },
        }),
      ]);
      return rep.send({ issuedToday, pendingRequests, expiringSoon });
    }
  );

  // ─── CERTIFICATE REQUESTS (Dashboard manages requests) ────
  app.get(`${P}/requests`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const requests = await prisma.certRequest.findMany({
        where: {
          schoolId,
          ...(q.status ? { status: q.status as any } : {}),
        },
        include: {
          student: {
            include: {
              user: { select: { name: true, avatarUrl: true } },
              class: { select: { name: true } },
            },
          },
          requestedBy: { select: { name: true } },
          approvedBy:  { select: { name: true } },
          certIssued:  { select: { certNumber: true, pdfUrl: true } },
        },
        orderBy: { createdAt: "desc" },
        take: Number(q.limit ?? 50),
      });
      return rep.send({ requests });
    }
  );

  // Create request (student / parent portal)
  app.post(`${P}/requests`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const request = await prisma.certRequest.create({
        data: {
          schoolId,
          studentId:    b.studentId ? Number(b.studentId) : null,
          requestedById: Number(userId),
          certType:     b.certType as any,
          purpose:      b.purpose ?? null,
          urgency:      b.urgency ?? "NORMAL",
          copies:       Number(b.copies ?? 1),
          notes:        b.notes ?? null,
        },
      });
      return rep.code(201).send({ request });
    }
  );

  // Approve request
  app.post(`${P}/requests/:id/approve`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const id = Number((req.params as any).id);
      const request = await prisma.certRequest.update({
        where: { id, schoolId },
        data: { status: "APPROVED", approvedById: Number(userId), approvedAt: new Date() },
      });
      return rep.send({ request });
    }
  );

  // Reject request
  app.post(`${P}/requests/:id/reject`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const { reason } = req.body as any;
      const request = await prisma.certRequest.update({
        where: { id, schoolId },
        data: { status: "REJECTED", rejectedAt: new Date(), rejectionReason: reason },
      });
      return rep.send({ request });
    }
  );

  // ─── ISSUED CERTS — list & detail ─────────────────────────
  app.get(`${P}/issued`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId };
      if (q.category)  where.category = q.category;
      if (q.certType)  where.certType = q.certType;
      if (q.status)    where.status = q.status;
      if (q.targetType) where.targetType = q.targetType;
      if (q.studentId) where.studentId = Number(q.studentId);
      if (q.staffId)   where.staffId   = Number(q.staffId);
      if (q.search)    where.recipientName = { contains: q.search, mode: "insensitive" };

      const [certs, total] = await Promise.all([
        prisma.certIssued.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            template: { select: { name: true } },
            issuedBy: { select: { name: true } },
          },
        }),
        prisma.certIssued.count({ where }),
      ]);
      return rep.send({ certs, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // Revoke
  app.post(`${P}/issued/:id/revoke`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const { reason } = req.body as any;
      const cert = await prisma.certIssued.update({
        where: { id, schoolId },
        data: { status: "REVOKED", revokedAt: new Date(), revokeReason: reason },
      });
      return rep.send({ cert });
    }
  );

  // Track print / download
  app.patch(`${P}/issued/:id/access`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id   = Number((req.params as any).id);
      const type = ((req.body as any).type ?? "print") as "print" | "download";
      const data: any = { lastAccessedAt: new Date() };
      if (type === "print")    data.printCount    = { increment: 1 };
      if (type === "download") data.downloadCount = { increment: 1 };
      await prisma.certIssued.update({ where: { id, schoolId }, data });
      return rep.send({ ok: true });
    }
  );

  // ─── PUBLIC VERIFY (no auth) ──────────────────────────────
  app.get(`${P}/verify/:certNumber`, async (req: FastifyRequest, rep: FastifyReply) => {
    const { certNumber } = req.params as any;
    const cert = await prisma.certIssued.findFirst({
      where: { certNumber },
      include: { school: { select: { name: true, logoUrl: true } } },
    });
    if (!cert) return rep.code(404).send({ valid: false, message: "Certificate not found" });
    if (cert.status === "REVOKED")  return rep.send({ valid: false, message: "This certificate has been revoked", revokeReason: cert.revokeReason });
    const expired = cert.validUntil && new Date(cert.validUntil) < new Date();
    return rep.send({
      valid: !expired,
      status: cert.status,
      certNumber: cert.certNumber,
      certType: cert.certType,
      category: cert.category,
      title: cert.title,
      recipientName: cert.recipientName,
      issuedDate: cert.issuedDate,
      validUntil: cert.validUntil,
      schoolName: cert.school?.name,
      message: expired ? "Certificate has expired" : "Certificate is valid and authentic",
    });
  });

  // ─── SETTINGS ─────────────────────────────────────────────
  app.get(`${P}/settings`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      let s = await prisma.certSettings.findUnique({ where: { schoolId } });
      if (!s) s = await prisma.certSettings.create({ data: { schoolId } });
      return rep.send({ settings: s });
    }
  );

  app.put(`${P}/settings`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const s = await prisma.certSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          certNumberFormat: b.certNumberFormat,
          certNumberStartSeq: b.certNumberStartSeq ? Number(b.certNumberStartSeq) : undefined,
          qrVerificationEnabled: b.qrVerificationEnabled,
          digitalSignatureEnabled: b.digitalSignatureEnabled,
          publicVerifyEnabled: b.publicVerifyEnabled,
          approvalRules: b.approvalRules,
          expiryRules: b.expiryRules,
          autoGenOnExamResult: b.autoGenOnExamResult,
          autoGenTopN: b.autoGenTopN ? Number(b.autoGenTopN) : undefined,
          autoGenOnSportsWin: b.autoGenOnSportsWin,
          emailOnGenerate: b.emailOnGenerate,
          watermarkDefault: b.watermarkDefault,
          defaultSignatureLabel: b.defaultSignatureLabel,
        },
      });
      return rep.send({ settings: s });
    }
  );
}
