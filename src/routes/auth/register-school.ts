import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { hashPassword } from "../../utils/auth.js";
import { recalculateAgentLevel } from "../superadmin/agents.js";

const registerSchema = z.object({
  // School Info
  schoolName: z.string().min(3, "School name must be at least 3 characters"),
  board: z.enum(["CBSE","CISCE" , "ICSE", "RBSE" , "UPMSP" , "BSEB" , "DBSE" , "GSEB" , "IB","CAIE" , "OTHER"]),
  establishedYear: z.coerce.number().min(1800).max(new Date().getFullYear()).optional(),
  city: z.string().min(2, "City is required"),
  state: z.string().min(2, "State is required"),
  pincode: z.string().length(6, "Pincode must be 6 digits"),
  address: z.string().min(10, "Please enter full address"),
  schoolEmail: z.string().email("Invalid school email"),
  schoolPhone: z.string().length(10, "Phone must be 10 digits"),
  websiteUrl: z.string().url().optional().or(z.literal("")),

  // Admin Info
  adminName: z.string().min(3, "Admin name is required"),
  adminEmail: z.string().email("Invalid admin email"),
  adminPhone: z.string().length(10, "Admin phone must be 10 digits"),
  designation: z.string().min(2, "Designation is required"),

  // Account
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string(),

  // Optional — agent referral code entered at signup, if any.
  referralCode: z.string().trim().max(20).optional().or(z.literal("")),
}).refine((d) => d.password === d.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

export async function registerSchoolRoutes(app: FastifyInstance) {
  app.post(
    "/auth/register-school",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "VALIDATION_ERROR",
          message: parsed.error.errors[0]?.message ?? "Invalid input",
          fields: parsed.error.flatten().fieldErrors,
        });
      }

      const d = parsed.data;

      // Check school email already exists
      const existingSchool = await prisma.school.findFirst({
        where: { email: d.schoolEmail.toLowerCase() },
      });
      if (existingSchool) {
        return reply.status(409).send({
          success: false,
          error: "SCHOOL_EMAIL_EXISTS",
          message: "A school with this email already exists.",
        });
      }

      // Check admin email already exists
      const existingAdmin = await prisma.user.findFirst({
        where: { email: d.adminEmail.toLowerCase() },
      });
      if (existingAdmin) {
        return reply.status(409).send({
          success: false,
          error: "ADMIN_EMAIL_EXISTS",
          message: "An account with this admin email already exists.",
        });
      }

      // Check admin phone already exists
      const existingPhone = await prisma.user.findFirst({
        where: { phone: d.adminPhone },
      });
      if (existingPhone) {
        return reply.status(409).send({
          success: false,
          error: "ADMIN_PHONE_EXISTS",
          message: "An account with this phone number already exists.",
        });
      }

      // Generate unique slug
      let slug = generateSlug(d.schoolName);
      const slugExists = await prisma.school.findUnique({ where: { slug } });
      if (slugExists) {
        slug = `${slug}-${Date.now().toString(36)}`;
      }

      // Referral code is optional and best-effort — an invalid/unknown code
      // must never block registration, it just means no agent gets mapped.
      let referredAgent: { id: number } | null = null;
      const rawReferralCode = d.referralCode?.trim();
      if (rawReferralCode) {
        referredAgent = await prisma.agent.findFirst({
          where: { referralCode: rawReferralCode, status: "ACTIVE" },
          select: { id: true },
        });
      }

      // Create school + admin user in transaction
      const result = await prisma.$transaction(async (tx) => {
        // Create school
        const school = await tx.school.create({
          data: {
            name: d.schoolName,
            slug,
            email: d.schoolEmail.toLowerCase(),
            phone: d.schoolPhone,
            address: d.address,
            city: d.city,
            state: d.state,
            pincode: d.pincode,
            board: d.board,
            establishedYear: d.establishedYear,
            websiteUrl: d.websiteUrl || null,
            adminName: d.adminName,
            adminEmail: d.adminEmail.toLowerCase(),
            adminPhone: d.adminPhone,
            status: "ACTIVE",
            isApproved: true,
            referralCodeUsedAtSignup: rawReferralCode || null,
          },
        });

        // If a valid, active agent's referral code was entered, map this
        // school to that agent right now — the exact same table the
        // superadmin's manual "Map School" action writes to, just with
        // source = REFERRAL_CODE instead of MANUAL_BY_SUPERADMIN.
        if (referredAgent) {
          await tx.agentSchoolMapping.create({
            data: {
              agentId: referredAgent.id,
              schoolId: school.id,
              source: "REFERRAL_CODE",
            },
          });
          await recalculateAgentLevel(tx, referredAgent.id);
        }

        // Create academic year
        const currentYear = new Date().getFullYear();
        const academicYearName =
          new Date().getMonth() >= 3
            ? `${currentYear}-${(currentYear + 1).toString().slice(2)}`
            : `${currentYear - 1}-${currentYear.toString().slice(2)}`;

        await tx.academicYear.create({
          data: {
            schoolId: school.id,
            name: academicYearName,
            startDate: new Date(`${currentYear}-04-01`),
            endDate: new Date(`${currentYear + 1}-03-31`),
            isCurrent: true,
          },
        });

        // Create admin user
        const user = await tx.user.create({
          data: {
            schoolId: school.id,
            name: d.adminName,
            email: d.adminEmail.toLowerCase(),
            phone: d.adminPhone,
            passwordHash: await hashPassword(d.password),
            role: "SCHOOL_ADMIN",
            isActive: true,
          },
        });

        return { school, user };
      });

      // Deliberately NOT starting a trial here — registration must leave
      // the school with no subscription (fully locked, only School
      // Profile/Settings reachable). The one-time trial is started later,
      // only when the school admin explicitly requests it from the
      // Subscription/Plans page.

      // Generate JWT tokens
      const tokenPayload = {
        userId: result.user.id,
        schoolId: result.school.id,
        role: result.user.role,
        schoolName: result.school.name,
        userName: result.user.name,
      };

      const accessToken = app.jwt.sign(
        tokenPayload,
        { expiresIn: (process.env["JWT_EXPIRES_IN"] ?? "4h") as any }
      );
      const refreshToken = app.jwt.sign(
       { userId: result.user.id, type: "refresh" },
       { expiresIn: (process.env["JWT_REFRESH_EXPIRES_IN"] ?? "4h") as any }
      );

      // Update last login
      await prisma.user.update({
        where: { id: result.user.id },
        data: { lastLoginAt: new Date() },
      });

      return reply.status(201).send({
        success: true,
        message: `Welcome to ShikshaMatrix, ${result.school.name}!`,
        data: {
          accessToken,
          refreshToken,
          school: {
            id: result.school.id,
            name: result.school.name,
            slug: result.school.slug,
            plan: result.school.plan,
          },
          user: {
            id: result.user.id,
            name: result.user.name,
            email: result.user.email,
            phone: result.user.phone,
            role: result.user.role,
          },
        },
      });
    }
  );
}