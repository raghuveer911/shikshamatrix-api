import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { z } from "zod";

const markSchema = z.object({
  date:    z.string(),
  records: z.array(z.object({
    staffId:  z.number(),
    status:   z.enum(["PRESENT", "ABSENT", "LATE", "HALF_DAY", "ON_LEAVE"]),
    inTime:   z.string().optional(),
    outTime:  z.string().optional(),
    remarks:  z.string().optional(),
  })),
});

export async function hrAttendanceRoutes(app: FastifyInstance) {

  // ── GET /hr/attendance — Fetch attendance for a date ────────
  app.get("/hr/attendance",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { date, departmentId } = req.query as Record<string, string>;

      const targetDate = date ? new Date(date) : new Date();
      const dayStart   = new Date(targetDate); dayStart.setHours(0,0,0,0);
      const dayEnd     = new Date(targetDate); dayEnd.setHours(23,59,59,999);

      // All active staff
      const staff = await prisma.staff.findMany({
        where: {
          schoolId,
          isActive: true,
          ...(departmentId ? { departmentId: parseInt(departmentId) } : {}),
        },
        orderBy: { user: { name: "asc" } },
        select: {
          id:           true,
          employeeId:   true,
          employeeType: true,
          user:           { select: { name: true, avatarUrl: true } },
          departmentRef:  { select: { name: true } },
          designationRef: { select: { name: true } },
        },
      });

      // Existing attendance
      const existing = await prisma.staffAttendance.findMany({
        where: {
          schoolId,
          date: { gte: dayStart, lte: dayEnd },
          ...(departmentId ? {
            staff: { departmentId: parseInt(departmentId) },
          } : {}),
        },
        select: {
          staffId:     true,
          status:      true,
          inTime:      true,
          outTime:     true,
          lateMinutes: true,
          isHalfDay:   true,
          remarks:     true,
        },
      });

      const attMap = new Map(existing.map((a) => [a.staffId, a]));

      const summary = {
        present:  existing.filter((a) => a.status === "PRESENT").length,
        absent:   existing.filter((a) => a.status === "ABSENT").length,
        late:     existing.filter((a) => a.status === "LATE").length,
        onLeave:  existing.filter((a) => a.status === "ON_LEAVE").length,
        total:    staff.length,
        marked:   existing.length,
      };

      return reply.send({
        success: true,
        data: {
          date:          targetDate.toISOString().split("T")[0],
          alreadyMarked: existing.length > 0,
          summary,
          staff: staff.map((s) => {
            const att = attMap.get(s.id);
            return {
              id:           s.id,
              employeeId:   s.employeeId,
              employeeType: s.employeeType,
              name:         s.user.name,
              avatarUrl:    s.user.avatarUrl,
              department:   s.departmentRef?.name ?? "—",
              designation:  s.designationRef?.name ?? "—",
              status:       att?.status   ?? null,
              inTime:       att?.inTime   ?? null,
              outTime:      att?.outTime  ?? null,
              remarks:      att?.remarks  ?? null,
            };
          }),
        },
      });
    }
  );

  // ── POST /hr/attendance — Mark staff attendance ─────────────
  app.post("/hr/attendance",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req as any;

      const parsed = markSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.errors[0]?.message,
        });
      }

      const { date, records } = parsed.data;
      const targetDate = new Date(date);

      await Promise.all(
        records.map((r) =>
          prisma.staffAttendance.upsert({
            where:  { staffId_date: { staffId: r.staffId, date: targetDate } },
            update: {
              status:    r.status,
              inTime:    r.inTime  ?? null,
              outTime:   r.outTime ?? null,
              remarks:   r.remarks ?? null,
              isManual:  true,
              markedById: userId,
            },
            create: {
              schoolId,
              staffId:    r.staffId,
              date:       targetDate,
              status:     r.status,
              inTime:     r.inTime  ?? null,
              outTime:    r.outTime ?? null,
              remarks:    r.remarks ?? null,
              isManual:   true,
              markedById: userId,
            },
          })
        )
      );

      return reply.send({
        success: true,
        message: `Attendance marked for ${records.length} staff`,
      });
    }
  );
}