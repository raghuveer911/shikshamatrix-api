import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";

export async function financeStudentRoutes(app: FastifyInstance) {

  // ── GET /finance/student/search ─────────────────────────────
  app.get("/finance/student/search",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { q } = req.query as { q: string };

      if (!q || q.trim().length < 2) {
        return reply.send({ success: true, data: { students: [] } });
      }

      const students = await prisma.student.findMany({
        where: {
          schoolId,
          isActive: true,
          OR: [
            { user: { name: { contains: q, mode: "insensitive" } } },
            { admissionNo: { contains: q, mode: "insensitive" } },
            { rollNumber:  { contains: q, mode: "insensitive" } },
          ],
        },
        take: 15,
        select: {
          id:          true,
          admissionNo: true,
          rollNumber:  true,
          user:  { select: { name: true, phone: true } },
          class: { select: { name: true, section: true } },
          feePlans: {
            where: { isActive: true },
            select: { dueAmount: true, paidAmount: true, totalAmount: true },
            take: 1,
          },
        },
      });

      return reply.send({
        success: true,
        data: {
          students: students.map((s) => ({
            id:          s.id,
            name:        s.user.name,
            phone:       s.user.phone,
            admissionNo: s.admissionNo,
            rollNumber:  s.rollNumber,
            className:   `${s.class?.name ?? "—"} — ${s.class?.section ?? ""}`,
            dueAmount:   s.feePlans[0]?.dueAmount ?? 0,
            paidAmount:  s.feePlans[0]?.paidAmount ?? 0,
          })),
        },
      });
    }
  );

  // ── GET /finance/student/:id/fees ───────────────────────────
  app.get("/finance/student/:id/fees",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };

      const student = await prisma.student.findFirst({
        where: { id: parseInt(id), schoolId },
        select: {
          id:          true,
          admissionNo: true,
          rollNumber:  true,
          user:  { select: { name: true, phone: true } },
          class: { select: { name: true, section: true } },
          feePlans: {
            where: { isActive: true },
            include: {
              plan: {
                include: { heads: true },
              },
              installments: {
                include: {
                  installment: true,
                },
                orderBy: { dueDate: "asc" },
              },
            },
          },
        },
      });

      if (!student) {
        return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      }

      const activePlan = student.feePlans[0];

      return reply.send({
        success: true,
        data: {
          student: {
            id:          student.id,
            name:        student.user.name,
            phone:       student.user.phone,
            admissionNo: student.admissionNo,
            rollNumber:  student.rollNumber,
            className:   `${student.class?.name ?? "—"} — ${student.class?.section ?? ""}`,
          },
          feeSummary: activePlan ? {
            totalAmount:    activePlan.totalAmount,
            paidAmount:     activePlan.paidAmount,
            dueAmount:      activePlan.dueAmount,
            discountAmount: activePlan.discountAmount,
            fineAmount:     activePlan.fineAmount,
            planName:       activePlan.plan.name,
          } : null,
          feeHeads: activePlan?.plan.heads.map((h) => ({
            id:       h.id,
            name:     h.name,
            category: h.category,
            amount:   h.amount,
            frequency: h.frequency,
          })) ?? [],
          installments: activePlan?.installments.map((inst) => ({
            id:             inst.id,
            name:           inst.installment.name,
            installmentNo:  inst.installment.installmentNo,
            dueDate:        inst.dueDate,
            dueAmount:      inst.dueAmount,
            paidAmount:     inst.paidAmount,
            fineAmount:     inst.fineAmount,
            discountAmount: inst.discountAmount,
            status:         inst.status,
            paidAt:         inst.paidAt,
          })) ?? [],
        },
      });
    }
  );

  // ── GET /finance/dues — Class-wise pending list ─────────────
  app.get("/finance/dues",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { classId } = req.query as { classId?: string };

      const where: any = {
        schoolId,
        status: { in: ["PENDING", "OVERDUE", "PARTIAL"] },
        ...(classId ? {
          student: { classId: parseInt(classId) },
        } : {}),
      };

      const installments = await prisma.studentFeeInstallment.findMany({
        where,
        orderBy: [{ dueDate: "asc" }],
        take: 50,
        select: {
          id:        true,
          dueAmount: true,
          paidAmount: true,
          dueDate:   true,
          status:    true,
          installment: { select: { name: true } },
          student: {
            select: {
              id:          true,
              admissionNo: true,
              rollNumber:  true,
              user:  { select: { name: true, phone: true } },
              class: { select: { name: true, section: true } },
            },
          },
        },
      });

      // Group by class
      const classMap = new Map<string, any>();
      installments.forEach((inst) => {
        const key = `${inst.student.class?.name ?? "Unknown"} ${inst.student.class?.section ?? ""}`;
        if (!classMap.has(key)) {
          classMap.set(key, { className: key, students: [], totalDue: 0 });
        }
        const grp = classMap.get(key);
        const remaining = Number(inst.dueAmount) - Number(inst.paidAmount);
        grp.totalDue += remaining;

        // Merge same student
        const existing = grp.students.find((s: any) => s.id === inst.student.id);
        if (existing) {
          existing.dueAmount += remaining;
        } else {
          grp.students.push({
            id:          inst.student.id,
            name:        inst.student.user.name,
            admissionNo: inst.student.admissionNo,
            rollNumber:  inst.student.rollNumber,
            phone:       inst.student.user.phone,
            dueAmount:   remaining,
            installmentName: inst.installment.name,
            dueDate:     inst.dueDate,
            status:      inst.status,
          });
        }
      });

      return reply.send({
        success: true,
        data: { groups: Array.from(classMap.values()) },
      });
    }
  );
}
