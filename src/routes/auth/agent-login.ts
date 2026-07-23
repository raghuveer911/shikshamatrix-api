import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { verifyPassword } from "../../utils/auth.js";

const schema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

export async function agentLoginRoutes(app: FastifyInstance) {
  app.post(
    "/auth/agent/login",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "VALIDATION_ERROR",
          message: parsed.error.errors[0]?.message ?? "Invalid input",
        });
      }

      const { username, password } = parsed.data;

      const agent = await prisma.agent.findUnique({ where: { username } });
      if (!agent) {
        return reply.status(404).send({
          success: false,
          error: "NOT_FOUND",
          message: "No agent account found with this username.",
        });
      }

      if (agent.status !== "ACTIVE") {
        return reply.status(403).send({
          success: false,
          error: "ACCOUNT_INACTIVE",
          message: "This agent account has been deactivated. Contact ShikshaMatrix support.",
        });
      }

      const valid = await verifyPassword(password, agent.passwordHash);
      if (!valid) {
        return reply.status(401).send({
          success: false,
          error: "INVALID_PASSWORD",
          message: "Incorrect password.",
        });
      }

      const payload = {
        agentId: agent.id,
        username: agent.username,
        isAgent: true,
      };

      const accessToken = app.jwt.sign(
        payload,
        { expiresIn: (process.env["JWT_EXPIRES_IN"] ?? "4h") as any }
      );
      const refreshToken = app.jwt.sign(
        { agentId: agent.id, type: "refresh" },
        { expiresIn: (process.env["JWT_REFRESH_EXPIRES_IN"] ?? "4h") as any }
      );

      await prisma.agent.update({
        where: { id: agent.id },
        data: { lastLoginAt: new Date() },
      });

      return reply.status(200).send({
        success: true,
        message: `Welcome back, ${agent.name}!`,
        data: {
          accessToken,
          refreshToken,
          agent: {
            id: agent.id,
            name: agent.name,
            username: agent.username,
            level: agent.level,
            referralCode: agent.referralCode,
          },
        },
      });
    }
  );
}
