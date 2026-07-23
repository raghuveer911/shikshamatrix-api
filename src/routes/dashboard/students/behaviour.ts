import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { z } from "zod";

const behaviourSchema = z.object({
  studentId: z.number(),
  type:      z.enum(["POSITIVE", "NEGATIVE"]),
  category:  z.string().min(1),
  severity:  z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  remarks:   z.string().min(1),
  date:      z.string(),
});

export async function studentsBehaviourRoutes(app: FastifyInstance) {

  // ── GET /students/:id/behaviour ────────────────────────────
  app.get("/students/:id/behaviour",
    { preHandler: [appAuth, requireCapability('students.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id }       = req.params as { id: string };

      const records = await prisma.behaviourRecord.findMany({
        where:   { schoolId, studentId: parseInt(id) },
        orderBy: { date: "desc" },
        take:    30,
        select: {
          id:       true,
          type:     true,
          category: true,
          severity: true,
          remarks:  true,
          date:     true,
          addedBy: {
            select: { user: { select: { name: true } } },
          },
        },
      });

      return reply.send({
        success: true,
        data: {
          records: records.map((r) => ({
            id:        r.id,
            type:      r.type,
            category:  r.category,
            severity:  r.severity,
            remarks:   r.remarks,
            date:      r.date,
            addedBy:   r.addedBy?.user?.name ?? "Unknown",
          })),
        },
      });
    }
  );

  // ── POST /students/behaviour — Add behaviour record ─────────
  app.post("/students/behaviour",
    { preHandler: [appAuth, requireCapability('students.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;

      const parsed = behaviourSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.errors[0]?.message,
        });
      }

      const { studentId, type, category, severity, remarks, date } = parsed.data;

      const record = await prisma.behaviourRecord.create({
        data: {
          schoolId,
          studentId,
          type,
          category,
          severity:   severity ?? "LOW",
          remarks,
          date:       new Date(date),
          addedById:  staffId,
        },
      });

      return reply.send({
        success: true,
        message: "Behaviour record added",
        data: { id: record.id },
      });
    }
  );
}
