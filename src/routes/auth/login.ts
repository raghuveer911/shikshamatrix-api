import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { verifyPassword, isEmail, normalizePhone } from "../../utils/auth.js";
import {
  isStaffRole, isStudentRole, isParentRole,
  isPlatformRole, isSchoolAdmin,
} from "../../utils/roles.js";

// ─── Web Schema — SCHOOL_ADMIN only ──────────────────────────
const webLoginSchema = z.object({
  identifier: z.string().min(1, "Email or phone is required"),
  password:   z.string().min(1, "Password is required"),
  role:       z.literal("SCHOOL_ADMIN"),
});

// ─── App Schema — Staff / Student / Parent ────────────────────
const appLoginSchema = z.object({
  identifier: z.string().min(1, "Email or phone is required"),
  password:   z.string().min(1, "Password is required"),
  loginAs:    z.enum(["STAFF", "STUDENT", "PARENT"]),
});

// ─── Shared: Find User ───────────────────────────────────────
async function findUser(identifier: string) {
  const id = identifier.trim();
  const where = isEmail(id)
    ? { email: id.toLowerCase(), isDeleted: false }
    : { phone: normalizePhone(id), isDeleted: false };

  return prisma.user.findFirst({
    where,
    include: {
      school: {
        select: { id: true, name: true, status: true, isApproved: true },
      },
    },
  });
}

// ─── Shared: Common Checks ───────────────────────────────────
function checkSchool(user: any, reply: FastifyReply) {
  if (!user.school.isApproved || user.school.status === "SUSPENDED") {
    reply.status(403).send({
      success: false,
      error: "SCHOOL_INACTIVE",
      message: "School account is inactive. Contact ShikshaMatrix support.",
    });
    return false;
  }
  return true;
}

function checkActive(user: any, reply: FastifyReply) {
  if (!user.isActive) {
    reply.status(403).send({
      success: false,
      error: "ACCOUNT_INACTIVE",
      message: "Your account is deactivated. Contact your administrator.",
    });
    return false;
  }
  return true;
}

// ─── Shared: Generate Tokens ─────────────────────────────────
function generateTokens(app: FastifyInstance, user: any) {
  const accessToken = app.jwt.sign(
    { userId: user.id, schoolId: user.schoolId, role: user.role },
    { expiresIn: (process.env["JWT_EXPIRES_IN"] ?? "4h") as any }
  );
  const refreshToken = app.jwt.sign(
    { userId: user.id, type: "refresh" },
    { expiresIn: (process.env["JWT_REFRESH_EXPIRES_IN"] ?? "30d") as any }
  );
  return { accessToken, refreshToken };
}

// ─── Shared: Update Last Login ───────────────────────────────
async function updateLastLogin(userId: number) {
  await prisma.user.update({
    where: { id: userId },
    data:  { lastLoginAt: new Date() },
  });
}

// ─────────────────────────────────────────────────────────────
export async function loginRoutes(app: FastifyInstance) {

  // ── 1. WEB LOGIN — /auth/login (SCHOOL_ADMIN only) ─────────
  app.post("/auth/login", async (req: FastifyRequest, reply: FastifyReply) => {

    const parsed = webLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: "VALIDATION_ERROR",
        message: parsed.error.errors[0]?.message ?? "Invalid input",
      });
    }

    const { identifier, password } = parsed.data;

    const user = await findUser(identifier);

    if (!user) {
      return reply.status(404).send({
        success: false,
        error: "USER_NOT_FOUND",
        message: "No account found. Please check your credentials.",
      });
    }

    // Only SCHOOL_ADMIN can login here
    if (!isSchoolAdmin(user.role)) {
      return reply.status(403).send({
        success: false,
        error: "NOT_SCHOOL_ADMIN",
        message: "This login is for School Admin only. Please use the correct portal.",
      });
    }

    if (!checkSchool(user, reply)) return;
    if (!checkActive(user, reply)) return;

    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      return reply.status(401).send({
        success: false,
        error: "INVALID_PASSWORD",
        message: "Incorrect password. Please try again.",
      });
    }

    const { accessToken, refreshToken } = generateTokens(app, user);
    await updateLastLogin(user.id);

    return reply.status(200).send({
      success: true,
      message: `Welcome back, ${user.name}!`,
      data: {
        accessToken,
        refreshToken,
        user: {
          id:        user.id,
          name:      user.name,
          phone:     user.phone,
          email:     user.email,
          role:      user.role,
          gender:    user.gender,
          avatarUrl: user.avatarUrl,
          school:    { id: user.school.id, name: user.school.name },
        },
      },
    });
  });

  // ── 2. APP LOGIN — /auth/app-login (Staff/Student/Parent) ──
  app.post("/auth/app-login", async (req: FastifyRequest, reply: FastifyReply) => {

    const parsed = appLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: "VALIDATION_ERROR",
        message: parsed.error.errors[0]?.message ?? "Invalid input",
      });
    }

    const { identifier, password, loginAs } = parsed.data;

    const user = await findUser(identifier);

    if (!user) {
      return reply.status(404).send({
        success: false,
        error: "USER_NOT_FOUND",
        message: "No account found. Please contact your school administrator.",
      });
    }

    // Block platform roles from app login
    if (isPlatformRole(user.role)) {
      return reply.status(403).send({
        success: false,
        error: "APP_LOGIN_NOT_ALLOWED",
        message: "Please use the web panel to login.",
      });
    }

    // loginAs match check
    const roleMatch =
      loginAs === "STAFF"   ? isStaffRole(user.role)   :
      loginAs === "STUDENT" ? isStudentRole(user.role) :
      loginAs === "PARENT"  ? isParentRole(user.role)  : false;

    if (!roleMatch) {
      const correctAs =
        isStaffRole(user.role)   ? "Staff"   :
        isStudentRole(user.role) ? "Student" : "Parent";
      return reply.status(403).send({
        success: false,
        error: "ROLE_MISMATCH",
        message: `You are registered as ${correctAs}. Please select the correct login type.`,
      });
    }

    if (!checkSchool(user, reply)) return;
    if (!checkActive(user, reply)) return;

    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      return reply.status(401).send({
        success: false,
        error: "INVALID_PASSWORD",
        message: "Incorrect password. Please try again.",
      });
    }

    const { accessToken, refreshToken } = generateTokens(app, user);
    await updateLastLogin(user.id);

    return reply.status(200).send({
      success: true,
      message: `Welcome back, ${user.name}!`,
      data: {
        accessToken,
        refreshToken,
        loginAs,
        user: {
          id:        user.id,
          name:      user.name,
          phone:     user.phone,
          email:     user.email,
          role:      user.role,
          gender:    user.gender,
          avatarUrl: user.avatarUrl,
          school:    { id: user.school.id, name: user.school.name },
        },
      },
    });
  });
}