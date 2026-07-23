import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

export async function staffSettingsRoutes(app: FastifyInstance) {
  const P = "/staff/settings";

  // ── GET /staff/settings/profile ─────────────────────────
  app.get(`${P}/profile`, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, staffId } = req as any;

      const user = await prisma.user.findUnique({
        where: { id: Number(userId) },
        select: { id: true, name: true, phone: true, email: true, avatarUrl: true, role: true },
      });
      if (!user) return reply.status(404).send({ success: false, message: "User not found." });

      let staffInfo = null;
      if (staffId) {
        const staff = await prisma.staff.findUnique({
          where: { id: staffId },
          select: { employeeId: true, departmentRef: { select: { name: true } }, designationRef: { select: { name: true } } },
        });
        staffInfo = staff ? { employeeId: staff.employeeId, department: staff.departmentRef?.name ?? null, designation: staff.designationRef?.name ?? null } : null;
      }

      return reply.send({ success: true, data: { user, staffInfo } });
    }
  );

  // ── PUT /staff/settings/profile ─────────────────────────
  // Only the small set of self-editable fields — not role, not employeeId.
  app.put(`${P}/profile`, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = req as any;
      const b = req.body as { phone?: string; email?: string; avatarUrl?: string };

      const user = await prisma.user.update({
        where: { id: Number(userId) },
        data: {
          ...(b.phone !== undefined ? { phone: b.phone || null } : {}),
          ...(b.email !== undefined ? { email: b.email || null } : {}),
          ...(b.avatarUrl !== undefined ? { avatarUrl: b.avatarUrl || null } : {}),
        },
        select: { id: true, name: true, phone: true, email: true, avatarUrl: true },
      });

      return reply.send({ success: true, message: "Profile updated.", data: { user } });
    }
  );

  // ── GET /staff/settings/subscription-status ─────────────
  // Read-only visibility into the school's plan — staff can see it, only
  // the school admin can act on it (upgrade/renew stays web-admin-only).
  app.get(`${P}/subscription-status`, { preHandler: [appAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;

      const sub = await prisma.schoolSubscription.findUnique({
        where: { schoolId },
        include: { plan: { select: { name: true, tier: true, maxStudents: true, maxStaff: true, storageGB: true } } },
      });

      if (!sub) {
        return reply.send({ success: true, data: { hasSubscription: false } });
      }

      const [activeStudentCount, activeStaffCount] = await Promise.all([
        prisma.student.count({ where: { schoolId, isActive: true } }),
        prisma.staff.count({ where: { schoolId, isActive: true } }),
      ]);

      return reply.send({
        success: true,
        data: {
          hasSubscription: true,
          planName: sub.plan.name, tier: sub.plan.tier, status: sub.status,
          isTrial: sub.isTrial,
          expiresAt: sub.isTrial ? sub.trialEndsAt : sub.billingCycleEnd,
          maxStudents: sub.plan.maxStudents, activeStudentCount,
          maxStaff: sub.plan.maxStaff, activeStaffCount,
          storageGB: sub.plan.storageGB,
        },
      });
    }
  );
}
