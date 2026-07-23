import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { verifyPassword } from "../../utils/auth.js";

const schema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

export async function superAdminLoginRoutes(app: FastifyInstance) {
  app.post(
    "/auth/superadmin/login",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "VALIDATION_ERROR",
          message: parsed.error.errors[0]?.message ?? "Invalid input",
        });
      }

      const { email, password } = parsed.data;

      const superAdmin = await prisma.superAdmin.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (!superAdmin) {
        return reply.status(404).send({
          success: false,
          error: "NOT_FOUND",
          message: "No account found with this email.",
        });
      }

      if (!superAdmin.isActive) {
        return reply.status(403).send({
          success: false,
          error: "ACCOUNT_INACTIVE",
          message: "Account is deactivated.",
        });
      }

      const valid = await verifyPassword(password, superAdmin.passwordHash);
      if (!valid) {
        return reply.status(401).send({
          success: false,
          error: "INVALID_PASSWORD",
          message: "Incorrect password.",
        });
      }

      const payload = {
        superAdminId: superAdmin.id,
        email: superAdmin.email,
        isSuperAdmin: true,
      };

      const accessToken = app.jwt.sign(
        payload,
        { expiresIn: (process.env["JWT_EXPIRES_IN"] ?? "4h") as any }
      );
      const refreshToken = app.jwt.sign(
         { superAdminId: superAdmin.id, type: "refresh" },
          { expiresIn: (process.env["JWT_REFRESH_EXPIRES_IN"] ?? "4h") as any }
      );

      await prisma.superAdmin.update({
        where: { id: superAdmin.id },
        data: { lastLoginAt: new Date() },
      });

      return reply.status(200).send({
        success: true,
        message: `Welcome back, ${superAdmin.name}!`,
        data: {
          accessToken,
          refreshToken,
          superAdmin: {
            id: superAdmin.id,
            name: superAdmin.name,
            email: superAdmin.email,
          },
        },
      });
    }
  );
}