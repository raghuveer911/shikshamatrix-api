import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

async function genVisitorNo(schoolId: number): Promise<string> {
  const d = new Date();
  const key = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const count = await prisma.visitor.count({ where: { schoolId, createdAt: { gte: todayStart } } });
  return `VIS-${key}-${String(count+1).padStart(3,"0")}`;
}

export async function adminVisitorRoutes(app: FastifyInstance) {

  // ── GET /admin/visitors/meta ──────────────────────────────
  app.get("/admin/visitors/meta",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const today = new Date(); today.setHours(0,0,0,0);
      const tomorr = new Date(today); tomorr.setDate(tomorr.getDate()+1);

      const [todayCount, expected, checkedIn, checkedOut, pendingExit, staff] = await Promise.all([
        prisma.visitor.count({ where: { schoolId, createdAt: { gte: today, lt: tomorr } } }),
        prisma.visitor.count({ where: { schoolId, status: "EXPECTED", expectedDate: { gte: today, lt: tomorr } } }),
        prisma.visitor.count({ where: { schoolId, status: { in: ["CHECKED_IN","MEETING"] }, checkInAt: { gte: today } } }),
        prisma.visitor.count({ where: { schoolId, status: "CHECKED_OUT", checkOutAt: { gte: today } } }),
        prisma.visitor.count({ where: { schoolId, status: { in: ["CHECKED_IN","MEETING"] } } }),
        prisma.staff.findMany({
          where: { schoolId, isActive: true },
          select: { userId:true, user:{ select:{ id:true, name:true } } },
          take: 60,
        }),
      ]);

      const byType = await prisma.visitor.groupBy({
        by: ["visitorType"], where: { schoolId, createdAt: { gte: today, lt: tomorr } }, _count: true,
      });

      return reply.send({
        success: true,
        data: { kpi: { todayCount, expected, checkedIn, checkedOut, pendingExit }, byType: byType.map(b=>({type:b.visitorType,count:b._count})), staff },
      });
    }
  );

  // ── GET /admin/visitors ───────────────────────────────────
  app.get("/admin/visitors",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?:string; status?:string; type?:string; date?:string; search?:string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;

      const where: any = { schoolId };
      if (q.status) where.status = q.status;
      if (q.type)   where.visitorType = q.type;
      if (q.date) {
        const d = new Date(q.date); d.setHours(0,0,0,0);
        const d2 = new Date(d); d2.setDate(d2.getDate()+1);
        where.createdAt = { gte: d, lt: d2 };
      }
      if (q.search) {
        where.OR = [
          { visitorName:  { contains: q.search, mode: "insensitive" } },
          { mobileNumber: { contains: q.search } },
          { visitorNo:    { contains: q.search, mode: "insensitive" } },
        ];
      }

      const [visitors, total] = await Promise.all([
        prisma.visitor.findMany({
          where, skip: (page-1)*limit, take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            personToMeet: { select: { name: true } },
            createdBy:    { select: { name: true } },
          },
        }),
        prisma.visitor.count({ where }),
      ]);

      return reply.send({ success: true, data: { visitors, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ── GET /admin/visitors/today ─────────────────────────────
  app.get("/admin/visitors/today",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const today = new Date(); today.setHours(0,0,0,0);
      const tomorr = new Date(today); tomorr.setDate(tomorr.getDate()+1);

      const visitors = await prisma.visitor.findMany({
        where: { schoolId, createdAt: { gte: today, lt: tomorr } },
        orderBy: { createdAt: "desc" },
        include: { personToMeet: { select: { name: true } }, createdBy: { select: { name: true } } },
      });

      return reply.send({ success: true, data: { visitors } });
    }
  );

  // ── POST /admin/visitors ──────────────────────────────────
  app.post("/admin/visitors",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        visitorName: string; mobileNumber: string; email?: string;
        visitorType?: string; idProofUrl?: string; photoUrl?: string;
        purpose?: string; purposeNote?: string;
        personToMeetId?: number; personToMeetName?: string;
        expectedDate?: string; expectedTime?: string;
        remarks?: string;
      };

      if (!body.visitorName?.trim() || !body.mobileNumber?.trim()) {
        return reply.status(400).send({ success: false, message: "visitorName and mobileNumber required." });
      }

      const visitorNo = await genVisitorNo(schoolId);
      const visitor = await prisma.visitor.create({
        data: {
          schoolId, createdById: userId, visitorNo,
          visitorName:      body.visitorName.trim(),
          mobileNumber:     body.mobileNumber.trim(),
          email:            body.email ?? null,
          visitorType:      body.visitorType as any ?? "PARENT",
          idProofUrl:       body.idProofUrl ?? null,
          photoUrl:         body.photoUrl ?? null,
          purpose:          body.purpose as any ?? "OTHER",
          purposeNote:      body.purposeNote ?? null,
          personToMeetId:   body.personToMeetId ?? null,
          personToMeetName: body.personToMeetName ?? null,
          expectedDate:     body.expectedDate ? new Date(body.expectedDate) : null,
          expectedTime:     body.expectedTime ?? null,
          remarks:          body.remarks ?? null,
          status:           "EXPECTED",
        },
      });

      return reply.status(201).send({ success: true, message: "Visitor added.", data: { visitorId: visitor.id, visitorNo } });
    }
  );

  // ── PATCH /admin/visitors/:id/checkin ─────────────────────
  app.patch("/admin/visitors/:id/checkin",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const v = await prisma.visitor.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!v) return reply.status(404).send({ success: false, message: "Not found." });

      await prisma.visitor.update({
        where: { id: parseInt(id) },
        data: { status: "CHECKED_IN", checkInAt: new Date() },
      });

      return reply.send({ success: true, message: "Checked in.", data: { checkInAt: new Date() } });
    }
  );

  // ── PATCH /admin/visitors/:id/checkout ────────────────────
  app.patch("/admin/visitors/:id/checkout",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const v = await prisma.visitor.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!v) return reply.status(404).send({ success: false, message: "Not found." });
      if (!v.checkInAt) return reply.status(400).send({ success: false, message: "Visitor has not checked in." });

      const now = new Date();
      const durationMins = Math.round((now.getTime() - new Date(v.checkInAt).getTime()) / 60000);

      await prisma.visitor.update({
        where: { id: parseInt(id) },
        data: { status: "CHECKED_OUT", checkOutAt: now, visitDurationMins: durationMins },
      });

      return reply.send({ success: true, message: `Checked out. Duration: ${durationMins} min.`, data: { durationMins } });
    }
  );

  // ── PATCH /admin/visitors/:id/status ──────────────────────
  app.patch("/admin/visitors/:id/status",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { status } = req.body as { status: string };
      await prisma.visitor.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: status as any } });
      return reply.send({ success: true, message: `Status → ${status}` });
    }
  );

  // ── POST /admin/visitors/:id/gate-pass ────────────────────
  app.post("/admin/visitors/:id/gate-pass",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const v = await prisma.visitor.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!v) return reply.status(404).send({ success: false, message: "Not found." });

      const gatePassNo = `GP-${Date.now().toString().slice(-6)}`;
      await prisma.visitor.update({ where: { id: parseInt(id) }, data: { gatePassNo } });

      return reply.send({
        success: true,
        data: {
          gatePassNo, visitorName: v.visitorName,
          purpose: v.purpose, mobileNumber: v.mobileNumber,
          checkInAt: v.checkInAt, generatedAt: new Date(),
        },
      });
    }
  );

  // ── GET /admin/visitors/report ────────────────────────────
  app.get("/admin/visitors/report",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string };

      const where: any = { schoolId };
      if (q.from || q.to) {
        where.createdAt = {};
        if (q.from) where.createdAt.gte = new Date(q.from);
        if (q.to)   where.createdAt.lte = new Date(q.to);
      }

      const [byType, byPurpose, avgDuration] = await Promise.all([
        prisma.visitor.groupBy({ by: ["visitorType"], where, _count: true }),
        prisma.visitor.groupBy({ by: ["purpose"],     where, _count: true }),
        prisma.visitor.aggregate({ where: { ...where, visitDurationMins: { not: null } }, _avg: { visitDurationMins: true } }),
      ]);

      return reply.send({
        success: true,
        data: {
          byType:    byType.map(b=>({type:b.visitorType,count:b._count})).sort((a,b)=>b.count-a.count),
          byPurpose: byPurpose.map(b=>({purpose:b.purpose,count:b._count})).sort((a,b)=>b.count-a.count),
          avgDurationMins: Math.round(avgDuration._avg.visitDurationMins ?? 0),
        },
      });
    }
  );

  // ── DELETE /admin/visitors/:id ────────────────────────────
  app.delete("/admin/visitors/:id",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.visitor.deleteMany({ where: { id: parseInt(id), schoolId } });
      return reply.send({ success: true });
    }
  );
}
