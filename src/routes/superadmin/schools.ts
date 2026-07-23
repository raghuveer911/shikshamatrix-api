import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { hashPassword } from "../../utils/auth.js";
import { authenticateSuperAdmin } from "../../middleware/authenticate.js";

// ── Random password generator ──────────────────────────────
function generatePassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$";
  let pass = "";
  for (let i = 0; i < 12; i++) {
    pass += chars[Math.floor(Math.random() * chars.length)];
  }
  return pass;
}

export async function superAdminSchoolRoutes(app: FastifyInstance) {

  // ── GET /superadmin/schools ─────────────────────────────
  app.get(
    "/superadmin/schools",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        page?: string;
        limit?: string;
        search?: string;
        plan?: string;
        status?: string;
      };

      const page = parseInt(query.page ?? "1");
      const limit = parseInt(query.limit ?? "10");
      const skip = (page - 1) * limit;

      const where: any = {};

      if (query.search) {
        where.OR = [
          { name: { contains: query.search, mode: "insensitive" } },
          { city: { contains: query.search, mode: "insensitive" } },
          { adminName: { contains: query.search, mode: "insensitive" } },
          { adminEmail: { contains: query.search, mode: "insensitive" } },
          { adminPhone: { contains: query.search } },
        ];
      }

      if (query.plan && query.plan !== "ALL") {
        where.schoolSubscription = { plan: { tier: query.plan } };
      }

      if (query.status && query.status !== "ALL") {
        where.status = query.status;
      }

      const [schools, total] = await Promise.all([
        prisma.school.findMany({
          where,
          skip,
          take: limit,
          orderBy: { registeredAt: "desc" },
          select: {
            id: true,
            name: true,
            slug: true,
            city: true,
            state: true,
            board: true,
            status: true,
            isApproved: true,
            adminName: true,
            adminEmail: true,
            adminPhone: true,
            totalStudents: true,
            schoolSubscription: {
              select: {
                status: true,
                plan: { select: { tier: true, name: true } },
              },
            },
            totalTeachers: true,
            registeredAt: true,
            logoUrl: true,
            _count: {
              select: { users: true },
            },
          },
        }),
        prisma.school.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: {
          schools,
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    }
  );

  // ── GET /superadmin/schools/:id ─────────────────────────
  app.get(
    "/superadmin/schools/:id",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const school = await prisma.school.findUnique({
        where: { id: parseInt(id) },
        include: {
          _count: {
            select: {
              users: true,
              students: true,
              staffMembers: true,
              classes: true,
              invoices: true,
            },
          },
          academicYears: {
            where: { isCurrent: true },
            take: 1,
          },
          schoolSubscription: {
            include: {
              plan: true,
              creditWallet: true,
              auditLogs: { orderBy: { createdAt: "desc" }, take: 5 },
            },
          },
        },
      });

      if (!school) {
        return reply.status(404).send({
          success: false,
          error: "NOT_FOUND",
          message: "School not found.",
        });
      }

      return reply.send({ success: true, data: { school } });
    }
  );

  // ── PATCH /superadmin/schools/:id/status ────────────────
  app.patch(
    "/superadmin/schools/:id/status",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { status } = request.body as { status: "ACTIVE" | "SUSPENDED" };

      if (!["ACTIVE", "SUSPENDED"].includes(status)) {
        return reply.status(400).send({
          success: false,
          message: "Status must be ACTIVE or SUSPENDED",
        });
      }

      const school = await prisma.school.update({
        where: { id: parseInt(id) },
        data: { status },
        select: { id: true, name: true, status: true },
      });

      return reply.send({
        success: true,
        message: `${school.name} has been ${status === "ACTIVE" ? "activated" : "suspended"}.`,
        data: { school },
      });
    }
  );

  // ── PATCH /superadmin/schools/:id/plan ─────────────────
  app.patch(
    "/superadmin/schools/:id/plan",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const schoolId = parseInt(id);
      const { tier } = request.body as {
        tier: "ECONOMY" | "ESSENTIAL" | "PROFESSIONAL" | "ENTERPRISE";
      };

      if (!["ECONOMY", "ESSENTIAL", "PROFESSIONAL", "ENTERPRISE"].includes(tier)) {
        return reply.status(400).send({
          success: false,
          message: "Invalid tier",
        });
      }

      const plan = await prisma.subscriptionPlan.findUnique({ where: { tier } });
      if (!plan) {
        return reply.status(404).send({ success: false, message: `No plan found for tier ${tier}.` });
      }

      const existing = await prisma.schoolSubscription.findUnique({ where: { schoolId } });
      const now = new Date();
      const cycleEnd = new Date(now);
      cycleEnd.setFullYear(cycleEnd.getFullYear() + 1);

      const subscription = existing
        ? await prisma.schoolSubscription.update({
            where: { schoolId },
            data: { planId: plan.id, status: "ACTIVE" },
          })
        : await prisma.schoolSubscription.create({
            data: {
              schoolId,
              planId: plan.id,
              status: "ACTIVE",
              billingCycleStart: now,
              billingCycleEnd: cycleEnd,
              creditWallet: {
                create: { smsBalance: plan.smsCredits, whatsappBalance: plan.whatsappCredits },
              },
            },
          });

      const school = await prisma.school.findUnique({
        where: { id: schoolId },
        select: { id: true, name: true },
      });

      await prisma.subscriptionHistory.create({
        data: {
          subscriptionId: subscription.id,
          schoolId,
          event: !existing ? "CREATED" : existing.planId === plan.id ? "RENEWED" : "UPGRADED",
          description: existing
            ? `Plan changed to ${tier} by admin`
            : `${tier} plan assigned by admin`,
        },
      });

      return reply.send({
        success: true,
        message: `${school?.name} plan changed to ${tier}.`,
        data: { school, subscription },
      });
    }
  );

  // ── POST /superadmin/schools/:id/reset-password ─────────
  app.post(
    "/superadmin/schools/:id/reset-password",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const school = await prisma.school.findUnique({
        where: { id: parseInt(id) },
        select: { id: true, name: true, adminEmail: true },
      });

      if (!school) {
        return reply.status(404).send({
          success: false,
          message: "School not found.",
        });
      }

      const newPassword = generatePassword();
      const passwordHash = await hashPassword(newPassword);

      await prisma.user.updateMany({
        where: {
          schoolId: parseInt(id),
          role: "SCHOOL_ADMIN",
          email: school.adminEmail,
        },
        data: { passwordHash },
      });

      return reply.send({
        success: true,
        message: "Admin password reset successfully.",
        data: {
          schoolName: school.name,
          adminEmail: school.adminEmail,
          newPassword,
        },
      });
    }
  );

  // ── POST /superadmin/schools/:id/login-as ───────────────
  app.post(
    "/superadmin/schools/:id/login-as",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      // Find school admin user
      const adminUser = await prisma.user.findFirst({
        where: {
          schoolId: parseInt(id),
          role: "SCHOOL_ADMIN",
          isActive: true,
          isDeleted: false,
        },
        include: {
          school: {
            select: { id: true, name: true, status: true },
          },
        },
      });

      if (!adminUser) {
        return reply.status(404).send({
          success: false,
          message: "No active school admin found for this school.",
        });
      }

      if (adminUser.school.status === "SUSPENDED") {
        return reply.status(403).send({
          success: false,
          message: "School is suspended. Activate it first.",
        });
      }

      // Generate token as school admin
      const tokenPayload = {
        userId: adminUser.id,
        schoolId: adminUser.schoolId,
        role: adminUser.role,
        schoolName: adminUser.school.name,
        userName: adminUser.name,
        loginAsMode: true, // flag to indicate superadmin impersonation
      };

      const accessToken = app.jwt.sign(tokenPayload, { expiresIn: "2h" });

      return reply.send({
        success: true,
        message: `Logging in as ${adminUser.school.name} admin.`,
        data: {
          accessToken,
          user: {
            id: adminUser.id,
            name: adminUser.name,
            email: adminUser.email,
            phone: adminUser.phone,
            role: adminUser.role,
            school: adminUser.school,
          },
          redirectUrl: "http://localhost:3000/dashboard",
        },
      });
    }
  );

  // ── DELETE /superadmin/schools/:id ──────────────────────
  app.delete(
    "/superadmin/schools/:id",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const school = await prisma.school.findUnique({
        where: { id: parseInt(id) },
        select: { name: true },
      });

      if (!school) {
        return reply.status(404).send({
          success: false,
          message: "School not found.",
        });
      }

      // Soft delete — suspend + mark deleted
      await prisma.school.update({
        where: { id: parseInt(id) },
        data: { status: "SUSPENDED", isApproved: false },
      });

      return reply.send({
        success: true,
        message: `${school.name} has been removed from platform.`,
      });
    }
  );

  // ── GET /superadmin/stats ───────────────────────────────
  app.get(
    "/superadmin/stats",
    { preHandler: [authenticateSuperAdmin] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const [
        totalSchools,
        activeSchools,
        suspendedSchools,
        totalUsers,
        planBreakdown,
      ] = await Promise.all([
        prisma.school.count(),
        prisma.school.count({ where: { status: "ACTIVE" } }),
        prisma.school.count({ where: { status: "SUSPENDED" } }),
        prisma.user.count(),
        prisma.subscriptionPlan.findMany({
          select: {
            tier: true,
            _count: { select: { schoolSubscriptions: true } },
          },
        }),
      ]);

      return reply.send({
        success: true,
        data: {
          totalSchools,
          activeSchools,
          suspendedSchools,
          totalUsers,
          planBreakdown,
        },
      });
    }
  );
}