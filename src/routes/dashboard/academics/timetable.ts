import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

const DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

export async function academicsTimetableRoutes(app: FastifyInstance) {

  // ── GET /academics/timetable — Teacher ka weekly timetable ─
  app.get("/academics/timetable",
    { preHandler: [appAuth, requireCapability('academics.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { academicYear } = req.query as { academicYear?: string };

      const slots = await prisma.periodSlot.findMany({
        where: {
          schoolId,
          teacherId: staffId,
          ...(academicYear ? { academicYear } : {}),
        },
        orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
        select: {
          id:           true,
          dayOfWeek:    true,
          periodNumber: true,
          startTime:    true,
          duration:     true,
          isBreak:      true,
          breakLabel:   true,
          subject: {
            select: { name: true, code: true },
          },
          class: {
            select: { name: true, section: true, classNumber: true },
          },
        },
      });

      // Group by dayOfWeek (1=Mon...7=Sun)
      const weekMap: Record<number, any[]> = {};
      for (let i = 1; i <= 6; i++) weekMap[i] = []; // Mon–Sat

      slots.forEach((slot) => {
        if (weekMap[slot.dayOfWeek] !== undefined) {
          weekMap[slot.dayOfWeek].push({
            id:           slot.id,
            periodNumber: slot.periodNumber,
            startTime:    slot.startTime,
            duration:     slot.duration,
            isBreak:      slot.isBreak,
            breakLabel:   slot.breakLabel,
            subject:      slot.subject,
            class:        slot.class,
          });
        }
      });

      const week = Object.entries(weekMap).map(([day, periods]) => ({
        day:     parseInt(day),
        dayName: DAYS[parseInt(day) - 1],
        periods,
      }));

      return reply.send({ success: true, data: { week } });
    }
  );
}
