import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { generatePayslipsForMonth, PayslipError } from "../../../services/payslip.service.js";

export async function adminHrPayslipsRoutes(app: FastifyInstance) {
  const P = "/admin/hr/payslips";

  // ── POST /admin/hr/payslips/generate ────────────────────
  // Generates payslips for all active staff (or a specific list) for the
  // given month. Staff without a salary profile assigned are skipped, not
  // failed — the response reports exactly who was skipped and why.
  app.post(`${P}/generate`, { preHandler: [authenticate, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as { month: number; year: number; staffIds?: number[] };

      if (!b.month || !b.year || b.month < 1 || b.month > 12) {
        return reply.status(400).send({ success: false, message: "A valid month (1-12) and year are required." });
      }

      const result = await generatePayslipsForMonth(schoolId, b.month, b.year, Number(userId), b.staffIds);
      return reply.send({
        success: true,
        message: `Generated ${result.generated} payslip(s)${result.skipped.length ? `, skipped ${result.skipped.length}` : ""}.`,
        data: result,
      });
    }
  );

  // ── GET /admin/hr/payslips ────────────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { month?: string; year?: string; staffId?: string; page?: string };
      const page = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 30;

      const where: any = { schoolId };
      if (q.month) where.month = Number(q.month);
      if (q.year) where.year = Number(q.year);
      if (q.staffId) where.staffId = Number(q.staffId);

      const [payslips, total] = await Promise.all([
        prisma.payslip.findMany({
          where, orderBy: [{ year: "desc" }, { month: "desc" }], skip: (page - 1) * limit, take: limit,
          include: { staff: { include: { user: { select: { name: true, avatarUrl: true } }, departmentRef: { select: { name: true } } } } },
        }),
        prisma.payslip.count({ where }),
      ]);

      return reply.send({ success: true, data: { payslips, total, pages: Math.ceil(total / limit) } });
    }
  );

  // ── GET /admin/hr/payslips/:id ─────────────────────────────
  app.get(`${P}/:id`, { preHandler: [authenticate, requireCapability("hr.core")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const payslip = await prisma.payslip.findFirst({
        where: { id: Number(id), schoolId },
        include: { staff: { include: { user: { select: { name: true, avatarUrl: true } }, departmentRef: { select: { name: true } }, designationRef: { select: { name: true } } } } },
      });
      if (!payslip) return reply.status(404).send({ success: false, message: "Payslip not found." });
      return reply.send({ success: true, data: { payslip } });
    }
  );
}
