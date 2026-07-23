import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ── Default config ────────────────────────────────────────────
const DEFAULTS = {
  defaultTimeZone:"Asia/Kolkata", defaultLanguage:"ENGLISH",
  examNamingPattern:"{CODE}-{YEAR}-{SEQ}",
  defaultDurationMins:60, defaultPassingPercent:33,
  defaultNegativeMarking:false, defaultAttemptsAllowed:1,
  defaultResultVisibility:"AFTER_SUBMISSION",
  defaultRandomizeQns:false, defaultShuffleOptions:false, defaultMarkForReview:true,
  defaultDifficulty:"MEDIUM", questionApprovalRequired:false,
  duplicateDetection:true, questionVersioning:false,
  autoEvalEnabled:true, manualReviewRequired:true, allowReEvalRequests:true,
  gradeCalcMethod:"PERCENTAGE", autoPublishAfterEval:false, lockAfterPublish:true,
  showRank:true, showGrade:true, showPercentage:true,
  showCorrectAnswers:"AFTER_EXAM", showExplanations:true,
  resultPdfLogo:true, resultPdfSignature:false, resultPdfQrCode:false,
  secFullScreenDefault:false, secTabSwitchPolicy:"WARN", secRefreshPolicy:"WARN",
  secMultiLoginPolicy:"PREVENT", secDeviceRestriction:"ANY",
  secIpRestriction:false, secSessionTimeoutMins:15, secAuditLogging:true,
  uiTheme:"SYSTEM", uiNavigationMode:"FREE", uiQuestionPalette:true,
  uiProgressBar:true, uiTimerPosition:"TOP", uiAutoSaveIntervalSecs:30, uiAllowResume:false,
  notifyOnExamCreated:true, notifyOnExamScheduled:true,
  notifyReminder1Day:true, notifyReminder1Hour:true, notifyReminder15Min:false,
  notifyOnResultPublished:true, notifyParentsOnResult:false,
  notifyViaEmail:true, notifyViaPush:false,
  certAutoGenerate:false, certMinScorePercent:70,
  certQrVerification:true, certDigitalSignature:false,
  dataRetentionYears:5, autoArchiveOldExams:true, backupFrequency:"DAILY",
  featureQuestionBank:true, featureReports:true, featureLiveMonitoring:true,
  featureSecurity:true, featureCertificates:false, featureAIInsights:false,
};

export async function adminExamSettingsRoutes(app: FastifyInstance) {

  // ── GET /admin/exam-settings ──────────────────────────────
  app.get("/admin/exam-settings",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      let settings = await prisma.onlineExamSettings.findFirst({
        where: { schoolId },
        include: { updatedBy: { select: { name: true } } },
      });

      // Auto-create with defaults if not found
      if (!settings) {
        settings = await prisma.onlineExamSettings.create({
          data: { schoolId, ...DEFAULTS },
          include: { updatedBy: { select: { name: true } } },
        });
      }

      // Dashboard stat cards
      const [activePolicies, notifRules, featureCount] = await Promise.all([
        prisma.examSecurityPolicy.count({ where: { schoolId } }).catch(()=>0),
        // Count active notification toggles
        Promise.resolve(
          Object.entries(settings)
            .filter(([k,v]) => k.startsWith("notify") && v === true).length
        ),
        Promise.resolve(
          Object.entries(settings)
            .filter(([k,v]) => k.startsWith("feature") && v === true).length
        ),
      ]);

      return reply.send({
        success: true,
        data: {
          settings,
          stats: {
            activeSettings: Object.keys(DEFAULTS).length,
            securityPolicies: activePolicies,
            notificationRules: notifRules,
            featuresEnabled: featureCount,
          },
        },
      });
    }
  );

  // ── PUT /admin/exam-settings ──────────────────────────────
  // Full update (all sections at once, or partial)
  app.put("/admin/exam-settings",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as Partial<typeof DEFAULTS> & {
        schoolLogoUrl?: string; schoolWatermarkUrl?: string;
        examHeaderText?: string; certTemplateId?: number;
      };

      // Build update data (only provided keys)
      const data: any = { updatedById: userId };
      const allowed = Object.keys({ ...DEFAULTS, schoolLogoUrl:"", schoolWatermarkUrl:"", examHeaderText:"", certTemplateId:0 });
      allowed.forEach(k => { if (body[k as keyof typeof body] !== undefined) data[k] = body[k as keyof typeof body]; });

      const settings = await prisma.onlineExamSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...DEFAULTS, ...data },
        update: data,
        include: { updatedBy: { select: { name: true } } },
      });

      // Audit log
      await prisma.auditLog.create({
        data: {
          schoolId, userId,
          action: "SECURITY_SETTINGS_CHANGED",
          entityType: "OnlineExamSettings",
          description: `Online exam settings updated (${Object.keys(data).filter(k=>k!=="updatedById").join(", ")})`,
        },
      }).catch(() => null);

      return reply.send({ success: true, message: "Settings saved.", data: { settings } });
    }
  );

  // ── PATCH /admin/exam-settings/section ───────────────────
  // Update a single section only
  app.patch("/admin/exam-settings/section",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { section, data } = req.body as { section: string; data: Record<string, any> };

      if (!section || !data || typeof data !== "object") {
        return reply.status(400).send({ success: false, message: "section and data required." });
      }

      const updateData: any = { updatedById: userId };
      Object.entries(data).forEach(([k, v]) => { updateData[k] = v; });

      await prisma.onlineExamSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...DEFAULTS, ...updateData },
        update: updateData,
      });

      await prisma.auditLog.create({
        data: {
          schoolId, userId,
          action: "SECURITY_SETTINGS_CHANGED",
          entityType: "OnlineExamSettings",
          description: `Section "${section}" updated: ${Object.keys(data).join(", ")}`,
        },
      }).catch(() => null);

      return reply.send({ success: true, message: `${section} settings saved.` });
    }
  );

  // ── POST /admin/exam-settings/reset ──────────────────────
  app.post("/admin/exam-settings/reset",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { section } = req.body as { section?: string };

      if (section) {
        // Reset only specific section keys
        const sectionPrefixes: Record<string, string[]> = {
          general:    ["defaultTimeZone","defaultLanguage","examNamingPattern","examHeaderText"],
          defaults:   ["defaultDurationMins","defaultPassingPercent","defaultNegativeMarking","defaultAttemptsAllowed","defaultResultVisibility","defaultRandomizeQns","defaultShuffleOptions","defaultMarkForReview"],
          questions:  ["defaultDifficulty","questionApprovalRequired","duplicateDetection","questionVersioning"],
          evaluation: ["autoEvalEnabled","manualReviewRequired","allowReEvalRequests","gradeCalcMethod","autoPublishAfterEval","lockAfterPublish"],
          results:    ["showRank","showGrade","showPercentage","showCorrectAnswers","showExplanations","resultPdfLogo","resultPdfSignature","resultPdfQrCode"],
          security:   ["secFullScreenDefault","secTabSwitchPolicy","secRefreshPolicy","secMultiLoginPolicy","secDeviceRestriction","secIpRestriction","secSessionTimeoutMins","secAuditLogging"],
          ux:         ["uiTheme","uiNavigationMode","uiQuestionPalette","uiProgressBar","uiTimerPosition","uiAutoSaveIntervalSecs","uiAllowResume"],
          notifications:["notifyOnExamCreated","notifyOnExamScheduled","notifyReminder1Day","notifyReminder1Hour","notifyReminder15Min","notifyOnResultPublished","notifyParentsOnResult","notifyViaEmail","notifyViaPush"],
          certificates:["certAutoGenerate","certMinScorePercent","certQrVerification","certDigitalSignature"],
          storage:    ["dataRetentionYears","autoArchiveOldExams","backupFrequency"],
          advanced:   ["featureQuestionBank","featureReports","featureLiveMonitoring","featureSecurity","featureCertificates","featureAIInsights"],
        };
        const keys = sectionPrefixes[section] ?? [];
        const partial: any = {};
        keys.forEach(k => { if ((DEFAULTS as any)[k] !== undefined) partial[k] = (DEFAULTS as any)[k]; });
        await prisma.onlineExamSettings.updateMany({ where: { schoolId }, data: partial });
      } else {
        // Reset ALL
        await prisma.onlineExamSettings.updateMany({
          where: { schoolId },
          data: { ...DEFAULTS, updatedById: userId },
        });
      }

      return reply.send({ success: true, message: section ? `${section} section reset to defaults.` : "All settings reset to defaults." });
    }
  );

  // ── GET /admin/exam-settings/export ──────────────────────
  app.get("/admin/exam-settings/export",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const settings = await prisma.onlineExamSettings.findFirst({ where: { schoolId } });
      if (!settings) return reply.status(404).send({ success: false, message: "No settings found." });

      // Clean for export
      const { id, schoolId: _sid, updatedById, updatedBy, updatedAt, createdAt, ...exportable } = settings as any;
      return reply.send({ success: true, data: { config: exportable, exportedAt: new Date(), version: "1.0" } });
    }
  );

  // ── POST /admin/exam-settings/import ─────────────────────
  app.post("/admin/exam-settings/import",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { config } = req.body as { config: Partial<typeof DEFAULTS> };

      if (!config || typeof config !== "object") {
        return reply.status(400).send({ success: false, message: "Invalid config." });
      }

      // Strip non-settings keys
      const allowed = Object.keys(DEFAULTS);
      const clean: any = {};
      Object.entries(config).forEach(([k, v]) => { if (allowed.includes(k)) clean[k] = v; });

      await prisma.onlineExamSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...DEFAULTS, ...clean, updatedById: userId },
        update: { ...clean, updatedById: userId },
      });

      return reply.send({ success: true, message: `${Object.keys(clean).length} settings imported.` });
    }
  );

  // ── GET /admin/exam-settings/audit ───────────────────────
  app.get("/admin/exam-settings/audit",
    { preHandler: [authenticate, requireCapability('onlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string };
      const page = Math.max(1, parseInt(q.page ?? "1"));

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where: { schoolId, entityType: "OnlineExamSettings" },
          orderBy: { occurredAt: "desc" },
          skip: (page-1)*15, take: 15,
          include: { user: { select: { name: true } } },
        }).catch(() => []),
        prisma.auditLog.count({ where: { schoolId, entityType: "OnlineExamSettings" } }).catch(() => 0),
      ]);

      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/15) } });
    }
  );
}
