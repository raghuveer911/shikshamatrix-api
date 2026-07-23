// apps/api/src/routes/admin/library/lib-settings-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminLibSettingsRoutes(app: FastifyInstance) {
  const P = "/admin/library/settings";

  // ─── GET ALL SETTINGS ─────────────────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      let settings = await prisma.libSettings.findUnique({ where: { schoolId } });
      if (!settings) settings = await prisma.libSettings.create({ data: { schoolId } });

      const [reservationRule, membershipStats] = await Promise.all([
        prisma.libReservationRule.findUnique({ where: { schoolId } }),
        prisma.libMembership.groupBy({ by: ["memberType"], where: { schoolId }, _count: { id: true } }),
      ]);

      return rep.send({ settings, reservationRule, membershipStats });
    }
  );

  // ─── UPDATE GENERAL SETTINGS ──────────────────────────────
  app.put(`${P}/general`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.libSettings.upsert({
        where: { schoolId },
        create: { schoolId, bookCodePrefix: b.bookCodePrefix ?? "LIB", copyCodeFormat: b.copyCodeFormat ?? "{PREFIX}-{BOOKNO}-C{COPYNO}" },
        update: { bookCodePrefix: b.bookCodePrefix, copyCodeFormat: b.copyCodeFormat },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE MEMBERSHIP / ISSUE RULES ──────────────────────
  app.put(`${P}/issue-rules`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.libSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          studentDueDays:      b.studentDueDays  ? Number(b.studentDueDays)  : undefined,
          teacherDueDays:      b.teacherDueDays  ? Number(b.teacherDueDays)  : undefined,
          staffDueDays:        b.staffDueDays    ? Number(b.staffDueDays)    : undefined,
          parentDueDays:       b.parentDueDays   ? Number(b.parentDueDays)   : undefined,
          maxBooksStudent:     b.maxBooksStudent ? Number(b.maxBooksStudent) : undefined,
          maxBooksTeacher:     b.maxBooksTeacher ? Number(b.maxBooksTeacher) : undefined,
          maxBooksStaff:       b.maxBooksStaff   ? Number(b.maxBooksStaff)   : undefined,
          maxRenewals:         b.maxRenewals     ? Number(b.maxRenewals)     : undefined,
          renewalDays:         b.renewalDays     ? Number(b.renewalDays)     : undefined,
          requireApprovalRenew: b.requireApprovalRenew,
        },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE FINE RULES ────────────────────────────────────
  app.put(`${P}/fine-rules`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.libSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          fineEnabled:          b.fineEnabled,
          fineRatePerDay:       b.fineRatePerDay       ? Number(b.fineRatePerDay)       : undefined,
          fineDamageRate:       b.fineDamageRate       ? Number(b.fineDamageRate)       : undefined,
          fineLossRate:         b.fineLossRate         ? Number(b.fineLossRate)         : undefined,
          fineGracePeriodDays:  b.fineGracePeriodDays  ? Number(b.fineGracePeriodDays)  : undefined,
        },
      });
      return rep.send({ settings });
    }
  );

  // ─── UPDATE RESERVATION RULES ─────────────────────────────
  app.put(`${P}/reservation-rules`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const rule = await prisma.libReservationRule.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          maxReservationsStudent: b.maxReservationsStudent ? Number(b.maxReservationsStudent) : undefined,
          maxReservationsTeacher: b.maxReservationsTeacher ? Number(b.maxReservationsTeacher) : undefined,
          maxReservationsStaff:   b.maxReservationsStaff   ? Number(b.maxReservationsStaff)   : undefined,
          collectionWindowHours:  b.collectionWindowHours  ? Number(b.collectionWindowHours)  : undefined,
          reservationExpiryDays:  b.reservationExpiryDays  ? Number(b.reservationExpiryDays)  : undefined,
          teacherPriority:        b.teacherPriority        ? Number(b.teacherPriority)        : undefined,
          studentPriority:        b.studentPriority        ? Number(b.studentPriority)        : undefined,
          staffPriority:          b.staffPriority          ? Number(b.staffPriority)          : undefined,
          notifyOnAvailable:      b.notifyOnAvailable,
          notifyChannels:         b.notifyChannels,
        },
      });
      return rep.send({ rule });
    }
  );

  // ─── UPDATE DIGITAL LIBRARY SETTINGS ─────────────────────
  app.put(`${P}/digital`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      // Digital settings stored in LibSettings using existing fields or app config
      // For now, return the body as confirmation (extend LibSettings model if needed)
      return rep.send({ ok: true, digital: b });
    }
  );

  // ─── WORKING HOURS ────────────────────────────────────────
  app.put(`${P}/hours`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.libSettings.upsert({
        where: { schoolId },
        create: { schoolId, openTime: b.openTime ?? "08:00", closeTime: b.closeTime ?? "17:00", workingDays: b.workingDays ?? ["MON","TUE","WED","THU","FRI","SAT"] },
        update: {
          openTime:    b.openTime,
          closeTime:   b.closeTime,
          workingDays: b.workingDays,
        },
      });
      return rep.send({ settings });
    }
  );

  // ─── RESET TO DEFAULTS ────────────────────────────────────
  app.post(`${P}/reset`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      await prisma.libSettings.deleteMany({ where: { schoolId } });
      const settings = await prisma.libSettings.create({ data: { schoolId } });
      return rep.send({ settings, message: "Library settings reset to defaults" });
    }
  );

  // ─── INTEGRATION STATUS ───────────────────────────────────
  app.get(`${P}/integrations`, { preHandler: [authenticate, requireCapability('library.issueReturn')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      // Check which integration data exists
      const [students, staff, digitalResources, commTemplates] = await Promise.all([
        prisma.student.count({ where: { schoolId, isActive: true } }),
        prisma.staff.count({ where: { schoolId, isActive: true } }),
        prisma.libDigitalResource.count({ where: { schoolId, studyMaterialId: { not: null } } }),
        prisma.commTemplate.count({ where: { schoolId, isActive: true } }).catch(() => 0),
      ]);

      return rep.send({
        integrations: {
          studentsModule:      { connected: true,  count: students,     label: "Students" },
          hrModule:            { connected: true,  count: staff,        label: "Staff & Teachers" },
          studyCenterContent:  { connected: digitalResources > 0, count: digitalResources, label: "Study Center" },
          communicationEngine: { connected: true,  count: commTemplates, label: "Communication" },
          financeModule:       { connected: true,  count: 0,            label: "Finance (Fine Collection)" },
        },
      });
    }
  );
}
