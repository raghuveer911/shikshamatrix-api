import { FastifyRequest, FastifyReply } from "fastify";
import { JwtPayload } from "../types/index.js";

// Browser <img>/<a> tags can't send a custom Authorization header, so
// routes that serve files directly to those tags (GET /files/*) need
// an alternate way to pass the token — a ?token= query param. This is
// ONLY checked when no Authorization header is present, so normal
// fetch()-based API calls are completely unaffected.
async function verifyFromQueryToken(request: FastifyRequest): Promise<boolean> {
  const query = request.query as any;
  const token = query?.token;
  if (!token || typeof token !== "string") return false;
  try {
    const payload = request.server.jwt.verify(token) as any;
    (request as any).user = payload;
    return true;
  } catch {
    return false;
  }
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    if (!request.headers.authorization) {
      const ok = await verifyFromQueryToken(request);
      if (!ok) {
        return reply.status(401).send({
          success: false,
          error: "UNAUTHORIZED",
          message: "Invalid or expired token. Please login again.",
        });
      }
    } else {
      await request.jwtVerify();
    }
    // ✅ schoolId properly attached hai ya nahi check karo
    const payload = request.user as any;
    if (!payload.schoolId && !payload.isSuperAdmin) {
      return reply.status(401).send({
        success: false,
        error: "UNAUTHORIZED", 
        message: "Invalid token payload.",
      });
    }
  } catch (err) {
    reply.status(401).send({
      success: false,
      error: "UNAUTHORIZED",
      message: "Invalid or expired token. Please login again.",
    });
  }
}

export async function authenticateSuperAdmin(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    await request.jwtVerify();
    const payload = request.user as any;
    if (!payload.isSuperAdmin) {
      reply.status(403).send({
        success: false,
        error: "FORBIDDEN",
        message: "SuperAdmin access required.",
      });
    }
  } catch (err) {
    reply.status(401).send({
      success: false,
      error: "UNAUTHORIZED",
      message: "Invalid or expired token.",
    });
  }
}

// Agent auth is deliberately separate from `authenticate` (school users)
// and `authenticateSuperAdmin` — an Agent is neither, and must only ever
// see its own data (agentId is read from the token, never from a param).
export async function authenticateAgent(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    await request.jwtVerify();
    const payload = request.user as any;
    if (!payload.isAgent) {
      return reply.status(403).send({
        success: false,
        error: "FORBIDDEN",
        message: "Agent access required.",
      });
    }
  } catch (err) {
    reply.status(401).send({
      success: false,
      error: "UNAUTHORIZED",
      message: "Invalid or expired token. Please login again.",
    });
  }
}