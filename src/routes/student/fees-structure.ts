// apps/api/src/routes/student/fees-structure.ts
//
// Fee Structure (FeePlan + heads + installment schedule, status=ACTIVE
// only) + Due Fees (StudentFeeInstallment, real-time dues). All
// confirmed models.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/fees-structure] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function getStudentId(userId: number, schoolId: number): Promise<number | null> {
  const s = await safe("student lookup", () =>
    prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true } }), null);
  return s?.id ?? null;
}

export async function studentFeesStructureRoutes(app: FastifyInstance) {

  // ── GET /student/fees/structure ───────────────────────────────
  app.get("/student/fees/structure",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const studentPlan = await safe("studentFeePlan", () =>
        prisma.studentFeePlan.findFirst({
          where: { studentId: sid, schoolId, isActive: true },
          orderBy: { assignedAt: "desc" },
          include: {
            plan: {
              select: {
                name: true, status: true, totalAmount: true,
                heads: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, category: true, amount: true, frequency: true, isMandatory: true } },
                installments: { orderBy: { installmentNo: "asc" }, select: { id: true, name: true, installmentNo: true, dueDate: true, amount: true } },
              },
            },
          },
        }), null);

      if (!studentPlan || studentPlan.plan.status !== "ACTIVE") {
        return reply.send({ success: true, data: { hasPlan: false } });
      }

      return reply.send({
        success: true,
        data: {
          hasPlan: true,
          planName: studentPlan.plan.name,
          totalAmount: studentPlan.plan.totalAmount,
          heads: studentPlan.plan.heads,
          installmentSchedule: studentPlan.plan.installments,
        },
      });
    }
  );

  // ── GET /student/fees/due — real-time dues ────────────────────
  app.get("/student/fees/due",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const studentPlan = await safe("studentFeePlan for dues", () =>
        prisma.studentFeePlan.findFirst({
          where: { studentId: sid, schoolId, isActive: true },
          orderBy: { assignedAt: "desc" },
          include: {
            plan: { select: { name: true } },
            installments: { include: { installment: { select: { name: true, installmentNo: true } } }, orderBy: { dueDate: "asc" } },
          },
        }), null);

      if (!studentPlan) return reply.send({ success: true, data: { hasPlan: false } });

      const installments = studentPlan.installments.map((i: any) => ({
        id: i.id, name: i.installment.name, dueDate: i.dueDate,
        dueAmount: i.dueAmount, paidAmount: i.paidAmount, fineAmount: i.fineAmount, discountAmount: i.discountAmount,
        netDue: Math.max(0, Number(i.dueAmount) + Number(i.fineAmount) - Number(i.discountAmount) - Number(i.paidAmount)),
        status: i.status, isOverdue: i.status !== "PAID" && i.status !== "WAIVED" && new Date(i.dueDate) < new Date(),
      }));

      return reply.send({
        success: true,
        data: {
          hasPlan: true, planName: studentPlan.plan.name, studentPlanId: studentPlan.id,
          summary: {
            totalAmount: studentPlan.totalAmount, paidAmount: studentPlan.paidAmount,
            dueAmount: studentPlan.dueAmount, fineAmount: studentPlan.fineAmount, discountAmount: studentPlan.discountAmount,
          },
          installments,
        },
      });
    }
  );
}