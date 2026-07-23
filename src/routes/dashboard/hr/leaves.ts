import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { z } from "zod";

const actionSchema = z.object({
  action:  z.enum(["APPROVED", "REJECTED"]),
  hrNote:  z.string().optional(),
});

export async function hrLeavesRoutes(app: FastifyInstance) {

  // ── GET /hr/leaves — Leave requests list ────────────────────
  app.get("/hr/leaves",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { status = "PENDING", page = "1" } =
        req.query as Record<string, string>;

      const skip = (parseInt(page) - 1) * 20;

      const [leaves, total] = await Promise.all([
        prisma.hrLeaveApplication.findMany({
          where: { schoolId, status: status as any },
          skip,
          take: 20,
          orderBy: { appliedAt: "desc" },
          select: {
            id:         true,
            fromDate:   true,
            toDate:     true,
            totalDays:  true,
            isHalfDay:  true,
            reason:     true,
            status:     true,
            appliedAt:  true,
            hrNote:     true,
            hrActionAt: true,
            leaveType: { select: { name: true, color: true, isPaid: true } },
            staff: {
              select: {
                id:           true,
                employeeId:   true,
                employeeType: true,
                user:           { select: { name: true, avatarUrl: true } },
                departmentRef:  { select: { name: true } },
                designationRef: { select: { name: true } },
              },
            },
          },
        }),
        prisma.hrLeaveApplication.count({
          where: { schoolId, status: status as any },
        }),
      ]);

      // Counts per status
      const statusCounts = await prisma.hrLeaveApplication.groupBy({
        by:     ["status"],
        where:  { schoolId },
        _count: true,
      });

      return reply.send({
        success: true,
        data: {
          leaves,
          statusCounts: statusCounts.reduce((acc, s) => ({
            ...acc, [s.status]: s._count,
          }), {} as Record<string, number>),
          pagination: {
            total,
            page:       parseInt(page),
            totalPages: Math.ceil(total / 20),
          },
        },
      });
    }
  );

  // ── GET /hr/leaves/:id — Leave detail ───────────────────────
  app.get("/hr/leaves/:id",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };

      const leave = await prisma.hrLeaveApplication.findFirst({
        where: { id: parseInt(id), schoolId },
        select: {
          id:            true,
          fromDate:      true,
          toDate:        true,
          totalDays:     true,
          isHalfDay:     true,
          halfDayType:   true,
          reason:        true,
          status:        true,
          appliedAt:     true,
          hrNote:        true,
          hrAction:      true,
          hrActionAt:    true,
          managerAction: true,
          managerNote:   true,
          attachment:    true,
          leaveType: {
            select: {
              name:     true,
              color:    true,
              isPaid:   true,
              maxDays:  true,
            },
          },
          staff: {
            select: {
              id:           true,
              employeeId:   true,
              employeeType: true,
              user:           { select: { name: true, phone: true, avatarUrl: true } },
              departmentRef:  { select: { name: true } },
              designationRef: { select: { name: true } },
              leaveBalances: {
                where:  { leaveTypeId: undefined }, // will filter below
                select: {
                  totalDays:   true,
                  usedDays:    true,
                  pendingDays: true,
                  leaveType:   { select: { name: true } },
                },
              },
            },
          },
        },
      });

      if (!leave) {
        return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      }

      return reply.send({ success: true, data: { leave } });
    }
  );

  // ── POST /hr/leaves/:id/action — Approve / Reject ──────────
  app.post("/hr/leaves/:id/action",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req as any;
      const { id } = req.params as { id: string };

      const parsed = actionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.errors[0]?.message,
        });
      }

      const { action, hrNote } = parsed.data;

      const leave = await prisma.hrLeaveApplication.findFirst({
        where: { id: parseInt(id), schoolId },
        select: { id: true, status: true, staffId: true, totalDays: true, leaveTypeId: true },
      });

      if (!leave) {
        return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      }
      if (leave.status !== "PENDING" && leave.status !== "SUBMITTED") {
        return reply.status(400).send({
          success: false,
          error:   "ALREADY_ACTIONED",
          message: `Leave is already ${leave.status}`,
        });
      }

      await prisma.$transaction(async (tx) => {
        // Update leave application
        await tx.hrLeaveApplication.update({
          where: { id: parseInt(id) },
          data: {
            hrAction:   action as any,
            hrNote:     hrNote ?? null,
            hrId:       userId,
            hrActionAt: new Date(),
            status:     action as any,
          },
        });

        // If approved — update leave balance
        if (action === "APPROVED") {
          await tx.hrLeaveBalance.updateMany({
            where: {
              staffId:     leave.staffId,
              leaveTypeId: leave.leaveTypeId,
            },
            data: {
              usedDays:    { increment: leave.totalDays },
              pendingDays: { decrement: leave.totalDays },
            },
          });
        } else {
          // If rejected — free up pending days
          await tx.hrLeaveBalance.updateMany({
            where: {
              staffId:     leave.staffId,
              leaveTypeId: leave.leaveTypeId,
            },
            data: { pendingDays: { decrement: leave.totalDays } },
          });
        }
      });

      return reply.send({
        success: true,
        message: `Leave ${action === "APPROVED" ? "approved" : "rejected"} successfully`,
      });
    }
  );
}