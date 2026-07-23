// apps/api/src/routes/dashboard/messages/contact-info.ts
//
// NEW ROUTE — "who is this?" lookup for a conversation's other
// participant. Built entirely from already-confirmed models
// (Student, ParentStudent, Staff + their relations) — no new schema.
//
// Register in index.ts alongside the other messages routes:
//   import { messagesContactInfoRoutes } from "./routes/dashboard/messages/contact-info.js";
//   await app.register(messagesContactInfoRoutes);
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[messages/contact-info] "${label}" failed:`, err?.message ?? err); return fallback; }
}

export async function messagesContactInfoRoutes(app: FastifyInstance) {

  // ── GET /messages/contact-info?userId= — role-aware identity card ──
  app.get("/messages/contact-info",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { userId } = req.query as { userId: string };
      const uid = parseInt(userId);

      const user = await safe("user lookup", () =>
        prisma.user.findFirst({
          where: { id: uid, schoolId },
          select: { id: true, name: true, role: true, phone: true, email: true, avatarUrl: true },
        }), null);
      if (!user) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      let details: any = {};

      if (user.role === "STUDENT") {
        const student = await safe("student lookup", () =>
          prisma.student.findFirst({
            where: { userId: uid, schoolId },
            select: { rollNumber: true, admissionNumber: true, class: { select: { name: true, section: true } } },
          }), null);
        details = {
          rollNumber: student?.rollNumber ?? null,
          admissionNumber: student?.admissionNumber ?? null,
          className: student?.class ? `${student.class.name}-${student.class.section}` : null,
        };
      } else if (user.role === "PARENT") {
        const links = await safe("parent's children lookup", () =>
          prisma.parentStudent.findMany({
            where: { parentId: uid },
            select: {
              relation: true,
              student: {
                select: {
                  rollNumber: true,
                  user: { select: { name: true } },
                  class: { select: { name: true, section: true } },
                },
              },
            },
          }), [] as any[]);
        details = {
          children: links.map((l: any) => ({
            name: l.student.user.name, relation: l.relation, rollNumber: l.student.rollNumber,
            className: l.student.class ? `${l.student.class.name}-${l.student.class.section}` : null,
          })),
        };
      } else {
        // Any staff role
        const staff = await safe("staff lookup", () =>
          prisma.staff.findFirst({
            where: { userId: uid, schoolId },
            select: {
              employeeId: true,
              departmentRef: { select: { name: true } },
              designationRef: { select: { name: true } },
            },
          }), null);
        details = {
          employeeId: staff?.employeeId ?? null,
          department: staff?.departmentRef?.name ?? null,
          designation: staff?.designationRef?.name ?? null,
        };
      }

      return reply.send({
        success: true,
        data: {
          id: user.id, name: user.name, role: user.role,
          phone: user.phone, avatarUrl: user.avatarUrl, details,
        },
      });
    }
  );
}