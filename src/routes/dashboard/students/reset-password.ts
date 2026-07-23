// apps/api/src/routes/dashboard/students/reset-password.ts
//
// NEW endpoint — POST /students/:studentId/reset-password
//
// Regenerates the student's login password using the same DOB-based
// convention as bulk-import/admission (DDMMYYYY). Only the class
// teacher of that student's class (or admin/front-office) can do this
// — reuses the same accessLevelForClass() check as the rest of the
// Students module.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { hashPassword } from "../../../utils/auth.js";

const FULL_ACCESS_ROLES = ["SYSTEM_ADMIN", "FRONT_OFFICE"];

function dobToPassword(dob: Date): string {
  const dd = String(dob.getDate()).padStart(2, "0");
  const mm = String(dob.getMonth() + 1).padStart(2, "0");
  const yyyy = dob.getFullYear();
  return `${dd}${mm}${yyyy}`;
}

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[students/reset-password] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function studentsResetPasswordRoutes(app: FastifyInstance) {
  app.post("/students/:studentId/reset-password",
    { preHandler: [appAuth, requireCapability('students.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const { schoolId, role, staffId } = req as any;
        const studentId = parseInt((req.params as any).studentId);

        const student = await prisma.student.findFirst({
          where: { id: studentId, schoolId },
          select: { id: true, classId: true, dateOfBirth: true, userId: true, user: { select: { name: true } } },
        });
        if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });
        if (!student.dateOfBirth) {
          return reply.status(400).send({ success: false, error: "NO_DOB", message: "Student has no date of birth on file — cannot generate password." });
        }

        // Only the class teacher of this student's class (or admin/front-office) may reset
        let allowed = FULL_ACCESS_ROLES.includes(role);
        if (!allowed && staffId && student.classId) {
          const isClassTeacher = await safe("class teacher check", () =>
            prisma.class.findFirst({ where: { id: student.classId!, classTeacherId: staffId } }), null);
          allowed = !!isClassTeacher;
        }
        if (!allowed) {
          return reply.status(403).send({ success: false, error: "NO_ACCESS", message: "Only the class teacher or admin can reset this student's password." });
        }

        const newPassword = dobToPassword(student.dateOfBirth);
        const passwordHash = await hashPassword(newPassword);

        await prisma.user.update({
          where: { id: student.userId },
          data: { passwordHash },
        });

        return reply.send({
          success: true,
          message: `Password reset for ${student.user.name}`,
          data: { password: newPassword },
        });
      } catch (err: any) {
        console.log("[students/reset-password] route error:", err?.message ?? err);
        return reply.status(500).send({ success: false, error: "INTERNAL_ERROR" });
      }
    }
  );
}