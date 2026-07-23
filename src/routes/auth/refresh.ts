import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";

const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

export async function refreshRoutes(app: FastifyInstance) {
  app.post(
    "/auth/refresh",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = refreshSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "VALIDATION_ERROR",
          message: "Refresh token is required.",
        });
      }

      try {
        const decoded = app.jwt.verify(parsed.data.refreshToken) as any;

        if (decoded.type !== "refresh") {
          throw new Error("Invalid token type");
        }

        const user = await prisma.user.findFirst({
          where: { id: decoded.userId, isDeleted: false, isActive: true },
          include: {
            school: { select: { id: true, name: true } },
          },
        });

        if (!user) {
          return reply.status(401).send({
            success: false,
            error: "USER_NOT_FOUND",
            message: "User not found or inactive.",
          });
        }

        const accessToken = app.jwt.sign(
          {
            userId: user.id,
            schoolId: user.schoolId,
            role: user.role,
            schoolName: user.school.name,
            userName: user.name,
          },
          { expiresIn: "15m" }
        );

        return reply.status(200).send({
          success: true,
          data: { accessToken },
        });
      } catch (err) {
        return reply.status(401).send({
          success: false,
          error: "INVALID_TOKEN",
          message: "Invalid or expired refresh token. Please login again.",
        });
      }
    }
  );
}