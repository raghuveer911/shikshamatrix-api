// apps/api/src/routes/admin/working-days.ts
//
// Working Days configuration per session — which weekdays the school
// runs, and how Saturdays work (all working / all off / alternate).
// The Academic Calendar's is-working-day endpoint reads this to decide
// whether any given date counts as a school day.
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

const ALL_WEEKDAYS = ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"];
const DEFAULT_WORKING = ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"];

export async function adminWorkingDayRoutes(app: FastifyInstance) {
  const P = "/admin/working-days";

  // ── GET /admin/working-days ───────────────────────────────
  // Returns the saved config, or the sensible default (Mon–Sat) if
  // the school hasn't configured one yet — so callers always get a
  // usable answer instead of null.
  app.get(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { academicYearId?: string };

      const session = q.academicYearId
        ? await prisma.academicYear.findFirst({ where: { id: parseInt(q.academicYearId), schoolId } })
        : await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
      if (!session) return rep.status(404).send({ success: false, message: "Session not found." });

      const config = await prisma.workingDayConfig.findUnique({ where: { academicYearId: session.id } });

      return rep.send({
        success: true,
        data: {
          academicYearId: session.id,
          isConfigured: !!config,
          workingDays: config?.workingDays ?? DEFAULT_WORKING,
          saturdayPattern: config?.saturdayPattern ?? "ALL_WORKING",
          sundayOff: config?.sundayOff ?? true,
        },
      });
    }
  );

  // ── PUT /admin/working-days ───────────────────────────────
  app.put(P, { preHandler: [authenticate, requireCapability('academics.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as {
        academicYearId: number;
        workingDays: string[];
        saturdayPattern?: string;
        sundayOff?: boolean;
      };

      if (!b.academicYearId) return rep.status(400).send({ success: false, message: "academicYearId is required." });
      if (!Array.isArray(b.workingDays) || b.workingDays.length === 0) {
        return rep.status(400).send({ success: false, message: "Select at least one working day." });
      }
      const invalid = b.workingDays.filter(d => !ALL_WEEKDAYS.includes(d));
      if (invalid.length > 0) {
        return rep.status(400).send({ success: false, message: `Invalid weekday value(s): ${invalid.join(", ")}` });
      }

      const session = await prisma.academicYear.findFirst({ where: { id: b.academicYearId, schoolId } });
      if (!session) return rep.status(404).send({ success: false, message: "Session not found." });
      if (session.status === "LOCKED") return rep.status(400).send({ success: false, message: "This session is locked." });

      // Keep sundayOff and the workingDays list from contradicting each
      // other — whichever the admin just set explicitly wins.
      let workingDays = b.workingDays;
      if (b.sundayOff === true) workingDays = workingDays.filter(d => d !== "SUNDAY");
      const sundayOff = b.sundayOff ?? !workingDays.includes("SUNDAY");

      const config = await prisma.workingDayConfig.upsert({
        where: { academicYearId: b.academicYearId },
        create: {
          schoolId, academicYearId: b.academicYearId,
          workingDays: workingDays as any,
          saturdayPattern: (b.saturdayPattern as any) ?? "ALL_WORKING",
          sundayOff,
        },
        update: {
          workingDays: workingDays as any,
          ...(b.saturdayPattern !== undefined ? { saturdayPattern: b.saturdayPattern as any } : {}),
          sundayOff,
        },
      });

      return rep.send({ success: true, message: "Working days updated.", data: { config } });
    }
  );
}
