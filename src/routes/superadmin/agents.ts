import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { hashPassword } from "../../utils/auth.js";
import { authenticateSuperAdmin } from "../../middleware/authenticate.js";
import { levelForSchoolCount, generateReferralCode } from "../../utils/agentLevel.js";

// ── Random password generator (same shape as school-admin creation) ──
function generatePassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$";
  let pass = "";
  for (let i = 0; i < 12; i++) {
    pass += chars[Math.floor(Math.random() * chars.length)];
  }
  return pass;
}

const createAgentSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  phone: z.string().min(10).max(15),
  username: z.string().min(3).max(50),
  panCard: z.string().max(20).optional(),
  bankAccountName: z.string().max(100).optional(),
  bankAccountNumber: z.string().max(30).optional(),
  bankIfsc: z.string().max(15).optional(),
});

const updateAgentSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(10).max(15).optional(),
  panCard: z.string().max(20).nullable().optional(),
  bankAccountName: z.string().max(100).nullable().optional(),
  bankAccountNumber: z.string().max(30).nullable().optional(),
  bankIfsc: z.string().max(15).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

const mapSchoolSchema = z.object({
  schoolId: z.number().int().positive(),
});

export async function superAdminAgentRoutes(app: FastifyInstance) {
  // ── GET /superadmin/agents ──────────────────────────────
  app.get(
    "/superadmin/agents",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        page?: string;
        limit?: string;
        search?: string;
        level?: string;
        status?: string;
      };

      const page = parseInt(query.page ?? "1");
      const limit = parseInt(query.limit ?? "10");
      const skip = (page - 1) * limit;

      const where: any = {};
      if (query.search) {
        where.OR = [
          { name: { contains: query.search, mode: "insensitive" } },
          { email: { contains: query.search, mode: "insensitive" } },
          { phone: { contains: query.search } },
          { referralCode: { contains: query.search, mode: "insensitive" } },
        ];
      }
      if (query.level && query.level !== "ALL") where.level = query.level;
      if (query.status && query.status !== "ALL") where.status = query.status;

      const [agents, total] = await Promise.all([
        prisma.agent.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            referralCode: true,
            level: true,
            schoolCount: true,
            status: true,
            createdAt: true,
            lastLoginAt: true,
          },
        }),
        prisma.agent.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: { agents, total, page, limit, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  // ── POST /superadmin/agents ─────────────────────────────
  app.post(
    "/superadmin/agents",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createAgentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "VALIDATION_ERROR",
          message: parsed.error.errors[0]?.message ?? "Invalid input",
        });
      }

      const data = parsed.data;
      const payload = request.user as any;

      const existing = await prisma.agent.findFirst({
        where: {
          OR: [{ email: data.email }, { phone: data.phone }, { username: data.username }],
        },
      });
      if (existing) {
        return reply.status(409).send({
          success: false,
          error: "DUPLICATE",
          message: "An agent with this email, phone, or username already exists.",
        });
      }

      // Referral codes must be unique — retry a few times on the rare collision.
      let referralCode = generateReferralCode(data.name);
      for (let i = 0; i < 5; i++) {
        const clash = await prisma.agent.findUnique({ where: { referralCode } });
        if (!clash) break;
        referralCode = generateReferralCode(data.name);
      }

      const tempPassword = generatePassword();
      const passwordHash = await hashPassword(tempPassword);

      const agent = await prisma.agent.create({
        data: {
          name: data.name,
          email: data.email,
          phone: data.phone,
          username: data.username,
          panCard: data.panCard,
          bankAccountName: data.bankAccountName,
          bankAccountNumber: data.bankAccountNumber,
          bankIfsc: data.bankIfsc,
          referralCode,
          passwordHash,
          level: "BRONZE",
          schoolCount: 0,
          createdByAdminId: payload.superAdminId,
        },
      });

      return reply.status(201).send({
        success: true,
        message: "Agent created successfully.",
        data: {
          agent: {
            id: agent.id,
            name: agent.name,
            email: agent.email,
            username: agent.username,
            referralCode: agent.referralCode,
            level: agent.level,
          },
          // Returned once, at creation time only — never retrievable again.
          temporaryPassword: tempPassword,
        },
      });
    }
  );

  // ── GET /superadmin/agents/:id ───────────────────────────
  app.get(
    "/superadmin/agents/:id",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const agent = await prisma.agent.findUnique({
        where: { id: parseInt(id) },
        include: {
          schoolMappings: {
            where: { status: "ACTIVE" },
            include: { school: { select: { id: true, name: true, city: true, status: true } } },
          },
        },
      });

      if (!agent) {
        return reply.status(404).send({ success: false, error: "NOT_FOUND", message: "Agent not found." });
      }

      const { passwordHash, ...safeAgent } = agent;
      return reply.send({ success: true, data: { agent: safeAgent } });
    }
  );

  // ── PATCH /superadmin/agents/:id ─────────────────────────
  app.patch(
    "/superadmin/agents/:id",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = updateAgentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "VALIDATION_ERROR",
          message: parsed.error.errors[0]?.message ?? "Invalid input",
        });
      }

      const agent = await prisma.agent.findUnique({ where: { id: parseInt(id) } });
      if (!agent) {
        return reply.status(404).send({ success: false, error: "NOT_FOUND", message: "Agent not found." });
      }

      // level is intentionally not editable here — it is always derived
      // from schoolCount so it can never drift out of sync with reality.
      const updated = await prisma.agent.update({
        where: { id: agent.id },
        data: parsed.data,
      });

      const { passwordHash, ...safeAgent } = updated;
      return reply.send({ success: true, message: "Agent updated.", data: { agent: safeAgent } });
    }
  );

  // ── GET /superadmin/agents/:id/schools ───────────────────
  app.get(
    "/superadmin/agents/:id/schools",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const mappings = await prisma.agentSchoolMapping.findMany({
        where: { agentId: parseInt(id) },
        include: { school: { select: { id: true, name: true, city: true, status: true } } },
        orderBy: { assignedAt: "desc" },
      });
      return reply.send({ success: true, data: { mappings } });
    }
  );

  // ── POST /superadmin/agents/:id/schools ──────────────────
  // Manual mapping — the stopgap until the registration-page referral
  // field ships. Once that field exists, the same table gets populated
  // automatically with source = REFERRAL_CODE instead.
  app.post(
    "/superadmin/agents/:id/schools",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = mapSchoolSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "VALIDATION_ERROR",
          message: parsed.error.errors[0]?.message ?? "Invalid input",
        });
      }

      const agentId = parseInt(id);
      const { schoolId } = parsed.data;

      const [agent, school, existingMapping] = await Promise.all([
        prisma.agent.findUnique({ where: { id: agentId } }),
        prisma.school.findUnique({ where: { id: schoolId } }),
        prisma.agentSchoolMapping.findUnique({ where: { schoolId } }),
      ]);

      if (!agent) return reply.status(404).send({ success: false, error: "NOT_FOUND", message: "Agent not found." });
      if (!school) return reply.status(404).send({ success: false, error: "NOT_FOUND", message: "School not found." });
      if (existingMapping && existingMapping.status === "ACTIVE") {
        return reply.status(409).send({
          success: false,
          error: "ALREADY_MAPPED",
          message: "This school is already mapped to an agent.",
        });
      }

      await prisma.$transaction(async (tx) => {
        if (existingMapping) {
          // Was previously removed — reactivate under the new agent.
          await tx.agentSchoolMapping.update({
            where: { id: existingMapping.id },
            data: { agentId, status: "ACTIVE", source: "MANUAL_BY_SUPERADMIN", assignedAt: new Date(), removedAt: null },
          });
        } else {
          await tx.agentSchoolMapping.create({
            data: { agentId, schoolId, source: "MANUAL_BY_SUPERADMIN" },
          });
        }
        await recalculateAgentLevel(tx, agentId);
      });

      return reply.send({ success: true, message: "School mapped to agent." });
    }
  );

  // ── DELETE /superadmin/agents/:id/schools/:schoolId ──────
  app.delete(
    "/superadmin/agents/:id/schools/:schoolId",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, schoolId } = request.params as { id: string; schoolId: string };
      const agentId = parseInt(id);

      const mapping = await prisma.agentSchoolMapping.findUnique({ where: { schoolId: parseInt(schoolId) } });
      if (!mapping || mapping.agentId !== agentId || mapping.status !== "ACTIVE") {
        return reply.status(404).send({ success: false, error: "NOT_FOUND", message: "Active mapping not found." });
      }

      await prisma.$transaction(async (tx) => {
        await tx.agentSchoolMapping.update({
          where: { id: mapping.id },
          data: { status: "REMOVED", removedAt: new Date() },
        });
        await recalculateAgentLevel(tx, agentId);
      });

      return reply.send({ success: true, message: "School unmapped from agent." });
    }
  );
}

// Shared with the razorpay webhook — recomputes schoolCount + level for
// an agent from the ACTIVE mapping count. Call this inside the same
// transaction as any mapping create/remove so the two never drift apart.
export async function recalculateAgentLevel(tx: any, agentId: number) {
  const schoolCount = await tx.agentSchoolMapping.count({ where: { agentId, status: "ACTIVE" } });
  const level = levelForSchoolCount(schoolCount);
  await tx.agent.update({ where: { id: agentId }, data: { schoolCount, level } });
  return { schoolCount, level };
}
