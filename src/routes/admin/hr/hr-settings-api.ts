// apps/api/src/routes/admin/hr/hr-settings-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminHrSettingsRoutes(app: FastifyInstance) {
  const P = "/admin/hr/settings";

  // ─── GET SETTINGS (create with defaults if missing) ──────
  app.get(P, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      let settings = await prisma.hrSettings.findUnique({ where: { schoolId } });
      if (!settings) {
        settings = await prisma.hrSettings.create({ data: { schoolId } });
      }
      return rep.send({ settings });
    }
  );

  // ─── UPDATE GENERAL SETTINGS ──────────────────────────────
  app.put(`${P}/general`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.hrSettings.upsert({
        where: { schoolId },
        create: { schoolId, employeeIdFormat: b.employeeIdFormat, employeeIdStartSeq: Number(b.employeeIdStartSeq ?? 1), defaultAcademicSession: b.defaultAcademicSession, workingDays: b.workingDays, fiscalYearStart: Number(b.fiscalYearStart ?? 4) },
        update: { employeeIdFormat: b.employeeIdFormat, employeeIdStartSeq: b.employeeIdStartSeq ? Number(b.employeeIdStartSeq) : undefined, defaultAcademicSession: b.defaultAcademicSession, workingDays: b.workingDays, fiscalYearStart: b.fiscalYearStart ? Number(b.fiscalYearStart) : undefined },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE EMPLOYEE SETTINGS ─────────────────────────────
  app.put(`${P}/employee`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.hrSettings.upsert({
        where: { schoolId },
        create: { schoolId, employmentTypes: b.employmentTypes, staffCategories: b.staffCategories, defaultProbationDays: Number(b.defaultProbationDays ?? 90), confirmationAlertDays: Number(b.confirmationAlertDays ?? 15) },
        update: { employmentTypes: b.employmentTypes, staffCategories: b.staffCategories, defaultProbationDays: b.defaultProbationDays ? Number(b.defaultProbationDays) : undefined, confirmationAlertDays: b.confirmationAlertDays ? Number(b.confirmationAlertDays) : undefined },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE ATTENDANCE SETTINGS ───────────────────────────
  app.put(`${P}/attendance`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.hrSettings.upsert({
        where: { schoolId },
        create: { schoolId, attendanceMethods: b.attendanceMethods, graceMins: Number(b.graceMins ?? 15), halfDayAfterMins: Number(b.halfDayAfterMins ?? 240), autoMarkAbsent: b.autoMarkAbsent ?? false, autoMarkTime: b.autoMarkTime ?? "10:30", overtimeEnabled: b.overtimeEnabled ?? false, missedPunchAlertEnabled: b.missedPunchAlertEnabled ?? true },
        update: { attendanceMethods: b.attendanceMethods, graceMins: b.graceMins ? Number(b.graceMins) : undefined, halfDayAfterMins: b.halfDayAfterMins ? Number(b.halfDayAfterMins) : undefined, autoMarkAbsent: b.autoMarkAbsent, autoMarkTime: b.autoMarkTime, overtimeEnabled: b.overtimeEnabled, missedPunchAlertEnabled: b.missedPunchAlertEnabled },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE LEAVE SETTINGS ────────────────────────────────
  app.put(`${P}/leave`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.hrSettings.upsert({
        where: { schoolId },
        create: { schoolId, leaveYearStartMonth: Number(b.leaveYearStartMonth ?? 4), maxConsecutiveLeave: Number(b.maxConsecutiveLeave ?? 15), sandwichRuleEnabled: b.sandwichRuleEnabled ?? true, backdatedLeaveAllowed: b.backdatedLeaveAllowed ?? false, backdatedLeaveDays: Number(b.backdatedLeaveDays ?? 3), autoLeaveApprovalDays: Number(b.autoLeaveApprovalDays ?? 0), compOffExpiryDays: Number(b.compOffExpiryDays ?? 90), encashmentAllowed: b.encashmentAllowed ?? true },
        update: { leaveYearStartMonth: b.leaveYearStartMonth ? Number(b.leaveYearStartMonth) : undefined, maxConsecutiveLeave: b.maxConsecutiveLeave ? Number(b.maxConsecutiveLeave) : undefined, sandwichRuleEnabled: b.sandwichRuleEnabled, backdatedLeaveAllowed: b.backdatedLeaveAllowed, backdatedLeaveDays: b.backdatedLeaveDays ? Number(b.backdatedLeaveDays) : undefined, autoLeaveApprovalDays: b.autoLeaveApprovalDays ? Number(b.autoLeaveApprovalDays) : undefined, compOffExpiryDays: b.compOffExpiryDays ? Number(b.compOffExpiryDays) : undefined, encashmentAllowed: b.encashmentAllowed },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE RECRUITMENT SETTINGS ─────────────────────────
  app.put(`${P}/recruitment`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.hrSettings.upsert({
        where: { schoolId },
        create: { schoolId, vacancyApprovalRequired: b.vacancyApprovalRequired ?? true, defaultCandidatePipeline: b.defaultCandidatePipeline, interviewReminderHours: Number(b.interviewReminderHours ?? 24), offerLetterExpiryDays: Number(b.offerLetterExpiryDays ?? 7) },
        update: { vacancyApprovalRequired: b.vacancyApprovalRequired, defaultCandidatePipeline: b.defaultCandidatePipeline, interviewReminderHours: b.interviewReminderHours ? Number(b.interviewReminderHours) : undefined, offerLetterExpiryDays: b.offerLetterExpiryDays ? Number(b.offerLetterExpiryDays) : undefined },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE PERFORMANCE SETTINGS ─────────────────────────
  app.put(`${P}/performance`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.hrSettings.upsert({
        where: { schoolId },
        create: { schoolId, reviewFrequency: b.reviewFrequency ?? "QUARTERLY", kpiAutoCalculate: b.kpiAutoCalculate ?? true, performanceGoalEnabled: b.performanceGoalEnabled ?? true, appraisalCycle: b.appraisalCycle ?? "YEARLY", minKpiScore: b.minKpiScore ?? 40 },
        update: { reviewFrequency: b.reviewFrequency, kpiAutoCalculate: b.kpiAutoCalculate, performanceGoalEnabled: b.performanceGoalEnabled, appraisalCycle: b.appraisalCycle, minKpiScore: b.minKpiScore ? Number(b.minKpiScore) : undefined },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE DOCUMENT SETTINGS ────────────────────────────
  app.put(`${P}/documents`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.hrSettings.upsert({
        where: { schoolId },
        create: { schoolId, docExpiryAlertDays: b.docExpiryAlertDays ?? [7, 15, 30], requiredDocsByType: b.requiredDocsByType ?? {}, autoComplianceCheck: b.autoComplianceCheck ?? true, bgCheckRequired: b.bgCheckRequired ?? false },
        update: { docExpiryAlertDays: b.docExpiryAlertDays, requiredDocsByType: b.requiredDocsByType, autoComplianceCheck: b.autoComplianceCheck, bgCheckRequired: b.bgCheckRequired },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE ID CARD SETTINGS ─────────────────────────────
  app.put(`${P}/idcards`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.hrSettings.upsert({
        where: { schoolId },
        create: { schoolId, idCardValidYears: Number(b.idCardValidYears ?? 3), idCardAutoGenerate: b.idCardAutoGenerate ?? false, idCardQrEnabled: b.idCardQrEnabled ?? true, idCardDigitalSignature: b.idCardDigitalSignature ?? false },
        update: { idCardValidYears: b.idCardValidYears ? Number(b.idCardValidYears) : undefined, idCardAutoGenerate: b.idCardAutoGenerate, idCardQrEnabled: b.idCardQrEnabled, idCardDigitalSignature: b.idCardDigitalSignature },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE NOTIFICATION SETTINGS ────────────────────────
  app.put(`${P}/notifications`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.hrSettings.upsert({
        where: { schoolId },
        create: { schoolId, notifyLeaveRequest: b.notifyLeaveRequest ?? true, notifyLeaveApproval: b.notifyLeaveApproval ?? true, notifyAttendanceAlert: b.notifyAttendanceAlert ?? true, notifyDocExpiry: b.notifyDocExpiry ?? true, notifyContractExpiry: b.notifyContractExpiry ?? true, notifyRecruitmentEvent: b.notifyRecruitmentEvent ?? true, notifyAppraisalDue: b.notifyAppraisalDue ?? true, notifyViaEmail: b.notifyViaEmail ?? true, notifyViaSms: b.notifyViaSms ?? false, notifyViaPush: b.notifyViaPush ?? false },
        update: { notifyLeaveRequest: b.notifyLeaveRequest, notifyLeaveApproval: b.notifyLeaveApproval, notifyAttendanceAlert: b.notifyAttendanceAlert, notifyDocExpiry: b.notifyDocExpiry, notifyContractExpiry: b.notifyContractExpiry, notifyRecruitmentEvent: b.notifyRecruitmentEvent, notifyAppraisalDue: b.notifyAppraisalDue, notifyViaEmail: b.notifyViaEmail, notifyViaSms: b.notifyViaSms, notifyViaPush: b.notifyViaPush },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE APPROVAL WORKFLOWS ────────────────────────────
  app.put(`${P}/workflows`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.hrSettings.upsert({
        where: { schoolId },
        create: { schoolId, leaveApprovalFlow: b.leaveApprovalFlow, loanApprovalFlow: b.loanApprovalFlow, salaryApprovalFlow: b.salaryApprovalFlow, transferApprovalFlow: b.transferApprovalFlow, docVerificationFlow: b.docVerificationFlow },
        update: { leaveApprovalFlow: b.leaveApprovalFlow, loanApprovalFlow: b.loanApprovalFlow, salaryApprovalFlow: b.salaryApprovalFlow, transferApprovalFlow: b.transferApprovalFlow, docVerificationFlow: b.docVerificationFlow },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE SECURITY SETTINGS ────────────────────────────
  app.put(`${P}/security`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.hrSettings.upsert({
        where: { schoolId },
        create: { schoolId, salaryVisible: b.salaryVisible, staffDataAccess: b.staffDataAccess ?? "ROLE_BASED", documentAccessLevel: b.documentAccessLevel ?? "HR_ONLY", sensitiveDataMasking: b.sensitiveDataMasking ?? true },
        update: { salaryVisible: b.salaryVisible, staffDataAccess: b.staffDataAccess, documentAccessLevel: b.documentAccessLevel, sensitiveDataMasking: b.sensitiveDataMasking },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE AUDIT SETTINGS ────────────────────────────────
  app.put(`${P}/audit`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.hrSettings.upsert({
        where: { schoolId },
        create: { schoolId, logRetentionYears: Number(b.logRetentionYears ?? 7), auditEnabled: b.auditEnabled ?? true, sensitiveActionsTracked: b.sensitiveActionsTracked ?? true, suspiciousActivityAlert: b.suspiciousActivityAlert ?? true },
        update: { logRetentionYears: b.logRetentionYears ? Number(b.logRetentionYears) : undefined, auditEnabled: b.auditEnabled, sensitiveActionsTracked: b.sensitiveActionsTracked, suspiciousActivityAlert: b.suspiciousActivityAlert },
      });
      return rep.send({ settings });
    }
  );

  // ─── RESET TO DEFAULTS ────────────────────────────────────
  app.post(`${P}/reset`, { preHandler: [authenticate, requireCapability('hr.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      await prisma.hrSettings.deleteMany({ where: { schoolId } });
      const settings = await prisma.hrSettings.create({ data: { schoolId } });
      return rep.send({ settings, message: "Settings reset to defaults" });
    }
  );
}
