import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../lib/prisma.js";
import { isStaffRole } from "../utils/roles.js";

// ── Extend request type ───────────────────────────────────────
declare module "fastify" {
  interface FastifyRequest {
    userId:   number;
    schoolId: number;
    role:     string;
    staffId?: number;
  }
}

export async function appAuth(req: FastifyRequest, reply: FastifyReply) {

  // ── JWT Verify ────────────────────────────────────────────
  try {
    await req.jwtVerify();
  } catch {
    return reply.status(401).send({ success: false, error: "UNAUTHORIZED" });
  }

  const payload = req.user as any;
  const role    = payload.role as string;

  // ── Platform roles block ──────────────────────────────────
  if (role === "SCHOOL_ADMIN" || role === "SUPER_ADMIN") {
    return reply.status(403).send({
      success: false,
      error:   "APP_LOGIN_NOT_ALLOWED",
      message: "Please use the web panel.",
    });
  }

  // ── User active? ──────────────────────────────────────────
  const user = await prisma.user.findFirst({
    where:  { id: payload.userId, isActive: true, isDeleted: false },
    select: { id: true, schoolId: true },
  });
  if (!user) {
    return reply.status(401).send({ success: false, error: "USER_NOT_FOUND" });
  }

  // ── School active? ────────────────────────────────────────
  const school = await prisma.school.findFirst({
    where:  { id: payload.schoolId, status: "ACTIVE", isApproved: true },
    select: { id: true },
  });
  if (!school) {
    return reply.status(403).send({ success: false, error: "SCHOOL_INACTIVE" });
  }

  // ── Staff record check ────────────────────────────────────
  if (isStaffRole(role)) {
    const staff = await prisma.staff.findFirst({
      where:  { userId: payload.userId, isActive: true },
      select: { id: true },
    });
    if (!staff) {
      return reply.status(403).send({ success: false, error: "STAFF_NOT_FOUND" });
    }
    req.staffId = staff.id;
  }

  // ── Attach to request ─────────────────────────────────────
  req.userId   = payload.userId;
  req.schoolId = payload.schoolId;
  req.role     = role;
}