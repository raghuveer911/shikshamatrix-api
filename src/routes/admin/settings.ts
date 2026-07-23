import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import bcrypt from "bcryptjs";

export async function adminSettingsRoutes(app: FastifyInstance) {

  // ── GET /admin/school-settings ────────────────────────────
  app.get("/admin/school-settings",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const [school, settings, notifSettings, academicYears] = await Promise.all([
        prisma.school.findUnique({
          where: { id: schoolId },
          select: {
            id: true, name: true, email: true, phone: true,
            address: true, city: true, state: true, pincode: true,
            board: true, establishedYear: true, logoUrl: true,
            websiteUrl: true, adminName: true, adminEmail: true,
            adminPhone: true, plan: true, status: true,
            totalStudents: true, totalTeachers: true, totalStaff: true,
            maxStudents: true, maxTeachers: true, registeredAt: true,
          },
        }),
        prisma.schoolSettings.findUnique({ where: { schoolId } }),
        prisma.notificationSettings.findUnique({ where: { schoolId } }),
        prisma.academicYear.findMany({
          where: { schoolId },
          orderBy: { startDate: "desc" },
        }),
      ]);

      // Create defaults if not exist
      const finalSettings = settings ?? await prisma.schoolSettings.create({
        data: { schoolId, workingDays: "MON_SAT", periodStartTime: "09:00" },
      });

      const finalNotif = notifSettings ?? await prisma.notificationSettings.create({
        data: { schoolId },
      });

      return reply.send({
        success: true,
        data: { school, settings: finalSettings, notificationSettings: finalNotif, academicYears },
      });
    }
  );

  // ── PATCH /admin/school-settings/profile ──────────────────
  app.patch("/admin/school-settings/profile",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as {
        name?: string; phone?: string; address?: string;
        city?: string; state?: string; pincode?: string;
        board?: string; establishedYear?: number;
        logoUrl?: string; websiteUrl?: string;
      };

      const school = await prisma.school.update({
        where: { id: schoolId },
        data: {
          ...(body.name && { name: body.name.trim() }),
          ...(body.phone && { phone: body.phone.trim() }),
          ...(body.address && { address: body.address.trim() }),
          ...(body.city && { city: body.city.trim() }),
          ...(body.state && { state: body.state.trim() }),
          ...(body.pincode && { pincode: body.pincode.trim() }),
          ...(body.board && { board: body.board as any }),
          ...(body.establishedYear && { establishedYear: body.establishedYear }),
          ...(body.logoUrl !== undefined && { logoUrl: body.logoUrl }),
          ...(body.websiteUrl !== undefined && { websiteUrl: body.websiteUrl }),
        },
        select: { id: true, name: true, email: true, phone: true, logoUrl: true },
      });

      return reply.send({ success: true, message: "School profile updated.", data: { school } });
    }
  );

  // ── PATCH /admin/school-settings/timetable ────────────────
  app.patch("/admin/school-settings/timetable",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as { workingDays?: string; periodStartTime?: string; };

      const settings = await prisma.schoolSettings.upsert({
        where: { schoolId },
        create: { schoolId, workingDays: body.workingDays ?? "MON_SAT", periodStartTime: body.periodStartTime ?? "09:00" },
        update: {
          ...(body.workingDays && { workingDays: body.workingDays }),
          ...(body.periodStartTime && { periodStartTime: body.periodStartTime }),
        },
      });

      return reply.send({ success: true, message: "Timetable settings updated.", data: { settings } });
    }
  );

  // ── PATCH /admin/school-settings/notifications ────────────
  app.patch("/admin/school-settings/notifications",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as Record<string, boolean>;

      const notif = await prisma.notificationSettings.upsert({
        where: { schoolId },
        create: { schoolId, ...body },
        update: body,
      });

      return reply.send({ success: true, message: "Notification preferences saved.", data: { notificationSettings: notif } });
    }
  );

  // ── POST /admin/school-settings/academic-year ─────────────
  app.post("/admin/school-settings/academic-year",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as { name: string; startDate: string; endDate: string; isCurrent?: boolean; };

      if (!body.name || !body.startDate || !body.endDate) {
        return reply.status(400).send({ success: false, message: "Name, startDate, endDate required." });
      }

      if (body.isCurrent) {
        await prisma.academicYear.updateMany({ where: { schoolId }, data: { isCurrent: false } });
      }

      const year = await prisma.academicYear.create({
        data: {
          schoolId, name: body.name.trim(),
          startDate: new Date(body.startDate),
          endDate: new Date(body.endDate),
          isCurrent: body.isCurrent ?? false,
        },
      });

      return reply.status(201).send({ success: true, message: "Academic year created.", data: { year } });
    }
  );

  // ── PATCH /admin/school-settings/academic-year/:id/current
  app.patch("/admin/school-settings/academic-year/:id/current",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      await prisma.academicYear.updateMany({ where: { schoolId }, data: { isCurrent: false } });
      await prisma.academicYear.update({ where: { id: parseInt(id) }, data: { isCurrent: true } });

      return reply.send({ success: true, message: "Current academic year updated." });
    }
  );

  // ── DELETE /admin/school-settings/academic-year/:id ───────
  app.delete("/admin/school-settings/academic-year/:id",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const year = await prisma.academicYear.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!year) return reply.status(404).send({ success: false, message: "Not found." });
      if (year.isCurrent) return reply.status(400).send({ success: false, message: "Cannot delete current academic year." });

      await prisma.academicYear.delete({ where: { id: parseInt(id) } });
      return reply.send({ success: true, message: "Academic year deleted." });
    }
  );

  // ── PATCH /admin/school-settings/password ─────────────────
  app.patch("/admin/school-settings/password",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.user as any;
      const body = request.body as { currentPassword: string; newPassword: string; };

      if (!body.currentPassword || !body.newPassword) {
        return reply.status(400).send({ success: false, message: "Both passwords required." });
      }
      if (body.newPassword.length < 8) {
        return reply.status(400).send({ success: false, message: "Password must be at least 8 characters." });
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return reply.status(404).send({ success: false, message: "User not found." });

      const valid = await bcrypt.compare(body.currentPassword, user.passwordHash);
      if (!valid) return reply.status(400).send({ success: false, message: "Current password is incorrect." });

      const hash = await bcrypt.hash(body.newPassword, 10);
      await prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } });

      return reply.send({ success: true, message: "Password changed successfully." });
    }
  );
}