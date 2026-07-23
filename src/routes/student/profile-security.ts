// apps/api/src/routes/student/profile-security.ts
//
// Change Password — confirmed User.passwordHash field. Uses bcrypt
// (assumed already a project dependency, standard for auth systems).
//
// Devices/Login History/2FA intentionally NOT built — per your own
// Phase-1 plan, these stay "Coming Soon" even though a LoginHistory
// relation exists on User (its exact field structure wasn't shared,
// so wiring it now would mean guessing — Phase 2 candidate).
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { z } from "zod";
import bcrypt from "bcrypt";

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

export async function studentProfileSecurityRoutes(app: FastifyInstance) {

  app.post("/student/profile/security/change-password",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = req as any;

      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });
      const { currentPassword, newPassword } = parsed.data;

      const user = await prisma.user.findFirst({ where: { id: userId }, select: { passwordHash: true } });
      if (!user) return reply.status(404).send({ success: false, error: "USER_NOT_FOUND" });

      const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isValid) return reply.status(400).send({ success: false, error: "INVALID_CURRENT_PASSWORD", message: "Current password is incorrect" });

      const newHash = await bcrypt.hash(newPassword, 10);
      await prisma.user.update({ where: { id: userId }, data: { passwordHash: newHash } });

      return reply.send({ success: true, message: "Password changed successfully" });
    }
  );
}