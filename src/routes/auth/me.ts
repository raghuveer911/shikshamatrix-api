import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { getRoleLabel, getLoginAs } from "../../utils/roles.js";

export async function meRoutes(app: FastifyInstance) {
  app.get("/auth/me", { preHandler: appAuth }, async (req: FastifyRequest, reply: FastifyReply) => {

    const { userId } = req as any;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id:        true,
        name:      true,
        phone:     true,
        email:     true,
        role:      true,
        gender:    true,
        avatarUrl: true,
        school: {
          select: { id: true, name: true },
        },
        staffMember: {
          select: {
            employeeId:     true,
            employeeType:   true,
            departmentRef:  { select: { name: true } },
            designationRef: { select: { name: true } },
          },
        },
      },
    });

    if (!user) {
      return reply.status(404).send({ success: false, error: "USER_NOT_FOUND" });
    }

    return reply.status(200).send({
      success: true,
      data: {
        user: {
          id:          user.id,
          name:        user.name,
          phone:       user.phone,
          email:       user.email,
          role:        user.role,
          roleLabel:   getRoleLabel(user.role),
          loginAs:     getLoginAs(user.role),
          gender:      user.gender,
          avatarUrl:   user.avatarUrl,
          school:      user.school,
          // Staff only — baaki ke liye null aayega
          employeeId:   user.staffMember?.employeeId            ?? null,
          employeeType: user.staffMember?.employeeType          ?? null,
          department:   user.staffMember?.departmentRef?.name   ?? null,
          designation:  user.staffMember?.designationRef?.name  ?? null,
        },
      },
    });
  });
}