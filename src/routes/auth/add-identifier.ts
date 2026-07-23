import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { JwtPayload } from "../../types/index.js";
import { isEmail, normalizePhone } from "../../utils/auth.js";

const addIdentifierSchema = z.object({
  identifier: z.string().min(1, "Phone or email is required"),
});

export async function addIdentifierRoutes(app: FastifyInstance) {
  app.post(
    "/auth/add-identifier",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const payload = request.user as JwtPayload;

      const parsed = addIdentifierSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "VALIDATION_ERROR",
          message: parsed.error.errors[0]?.message ?? "Invalid input",
        });
      }

      const { identifier } = parsed.data;
      const currentUser = await prisma.user.findUnique({
        where: { id: payload.userId },
      });

      if (!currentUser) {
        return reply.status(404).send({
          success: false,
          error: "USER_NOT_FOUND",
          message: "User not found.",
        });
      }

      // Determine if adding email or phone
      if (isEmail(identifier)) {
        // Adding email
        if (currentUser.email) {
          return reply.status(400).send({
            success: false,
            error: "ALREADY_EXISTS",
            message: "You already have an email linked to your account.",
          });
        }

        // Check email not taken by another user
        const existing = await prisma.user.findFirst({
          where: { email: identifier.toLowerCase() },
        });
        if (existing) {
          return reply.status(409).send({
            success: false,
            error: "ALREADY_IN_USE",
            message:
              "This email is already linked to another account.",
          });
        }

        await prisma.user.update({
          where: { id: payload.userId },
          data: { email: identifier.toLowerCase() },
        });

        return reply.status(200).send({
          success: true,
          message: "Email added successfully! You can now login with your email too.",
        });
      } else {
        // Adding phone
        const normalizedPhone = normalizePhone(identifier);

        if (currentUser.phone) {
          return reply.status(400).send({
            success: false,
            error: "ALREADY_EXISTS",
            message: "You already have a phone number linked to your account.",
          });
        }

        // Check phone not taken
        const existing = await prisma.user.findFirst({
          where: { phone: normalizedPhone },
        });
        if (existing) {
          return reply.status(409).send({
            success: false,
            error: "ALREADY_IN_USE",
            message:
              "This phone number is already linked to another account.",
          });
        }

        await prisma.user.update({
          where: { id: payload.userId },
          data: { phone: normalizedPhone },
        });

        return reply.status(200).send({
          success: true,
          message:
            "Phone number added successfully! You can now login with your phone too.",
        });
      }
    }
  );
}