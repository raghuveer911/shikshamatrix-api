import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ── Auto-generate enquiry number ─────────────────────────────
async function genEnquiryNo(schoolId: number): Promise<string> {
  const y = new Date().getFullYear().toString().slice(-2);
  const m = String(new Date().getMonth()+1).padStart(2,"0");
  const count = await prisma.enquiry.count({ where: { schoolId } });
  return `ENQ-${y}${m}-${String(count+1).padStart(4,"0")}`;
}

export async function adminEnquiryRoutes(app: FastifyInstance) {

  // ── GET /admin/enquiries/meta ─────────────────────────────
  app.get("/admin/enquiries/meta",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;

      const today = new Date(); today.setHours(0,0,0,0);
      const tomorr = new Date(today); tomorr.setDate(tomorr.getDate()+1);

      const [total, newToday, followUpsPending, converted, lost, staff] = await Promise.all([
        prisma.enquiry.count({ where: { schoolId } }),
        prisma.enquiry.count({ where: { schoolId, createdAt: { gte: today, lt: tomorr } } }),
        prisma.followUp.count({ where: { schoolId, isDone: false, scheduledDate: { lte: new Date() } } }),
        prisma.enquiry.count({ where: { schoolId, status: "ADMISSION_CONFIRMED" } }),
        prisma.enquiry.count({ where: { schoolId, status: { in: ["NOT_INTERESTED","LOST"] } } }),
        prisma.staff.findMany({
          where: { schoolId, isActive: true },
          select: { userId: true, user: { select: { id:true, name:true } } },
          take: 50,
        }),
      ]);

      const totalNonLost = total - lost;
      const conversionRate = totalNonLost > 0 ? Math.round((converted / totalNonLost) * 100) : 0;

      // Source breakdown
      const bySource = await prisma.enquiry.groupBy({
        by: ["source"], where: { schoolId }, _count: true,
      });

      // Status breakdown
      const byStatus = await prisma.enquiry.groupBy({
        by: ["status"], where: { schoolId }, _count: true,
      });

      return reply.send({
        success: true,
        data: {
          kpi: { total, newToday, followUpsPending, converted, lost, conversionRate },
          bySource: bySource.map(b => ({ source: b.source, count: b._count })),
          byStatus: byStatus.map(b => ({ status: b.status, count: b._count })),
          staff,
        },
      });
    }
  );

  // ── GET /admin/enquiries ──────────────────────────────────
  app.get("/admin/enquiries",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?:string; status?:string; source?:string; assignedToId?:string; search?:string; from?:string; to?:string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status)      where.status       = q.status;
      if (q.source)      where.source       = q.source;
      if (q.assignedToId) where.assignedToId = parseInt(q.assignedToId);
      if (q.from || q.to) {
        where.createdAt = {};
        if (q.from) where.createdAt.gte = new Date(q.from);
        if (q.to)   where.createdAt.lte = new Date(q.to);
      }
      if (q.search) {
        where.OR = [
          { studentName:  { contains: q.search, mode: "insensitive" } },
          { mobileNumber: { contains: q.search } },
          { enquiryNo:    { contains: q.search, mode: "insensitive" } },
          { fatherName:   { contains: q.search, mode: "insensitive" } },
        ];
      }

      const [enquiries, total] = await Promise.all([
        prisma.enquiry.findMany({
          where, skip: (page-1)*limit, take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            assignedTo:  { select: { name: true } },
            createdBy:   { select: { name: true } },
            _count:      { select: { followUps: true } },
          },
        }),
        prisma.enquiry.count({ where }),
      ]);

      return reply.send({ success: true, data: { enquiries, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ── GET /admin/enquiries/:id ──────────────────────────────
  app.get("/admin/enquiries/:id",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };

      const enquiry = await prisma.enquiry.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          assignedTo: { select: { name: true } },
          createdBy:  { select: { name: true } },
          followUps:  { orderBy: { scheduledDate: "asc" }, include: { createdBy: { select: { name: true } } } },
          activities: { orderBy: { createdAt: "desc" }, include: { createdBy: { select: { name: true } } } },
        },
      });
      if (!enquiry) return reply.status(404).send({ success: false, message: "Not found." });
      return reply.send({ success: true, data: { enquiry } });
    }
  );

  // ── POST /admin/enquiries ─────────────────────────────────
  app.post("/admin/enquiries",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        studentName:string; gender?:string; dateOfBirth?:string; currentClass?:string;
        interestedClass?:string; interestedSession?:string; interestedSection?:string;
        fatherName?:string; motherName?:string; mobileNumber:string; whatsappNumber?:string;
        email?:string; address?:string; city?:string; state?:string;
        source?:string; referredBy?:string; assignedToId?:number; remarks?:string;
      };

      if (!body.studentName?.trim() || !body.mobileNumber?.trim()) {
        return reply.status(400).send({ success: false, message: "studentName and mobileNumber required." });
      }

      const enquiryNo = await genEnquiryNo(schoolId);
      const enquiry = await prisma.enquiry.create({
        data: {
          schoolId, createdById: userId, enquiryNo,
          studentName: body.studentName.trim(),
          gender: body.gender ?? null, dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null,
          currentClass: body.currentClass ?? null,
          interestedClass: body.interestedClass ?? null, interestedSession: body.interestedSession ?? null, interestedSection: body.interestedSection ?? null,
          fatherName: body.fatherName ?? null, motherName: body.motherName ?? null,
          mobileNumber: body.mobileNumber.trim(), whatsappNumber: body.whatsappNumber ?? null,
          email: body.email ?? null, address: body.address ?? null, city: body.city ?? null, state: body.state ?? null,
          source: body.source as any ?? "WALK_IN", referredBy: body.referredBy ?? null,
          assignedToId: body.assignedToId ?? null, remarks: body.remarks ?? null,
          status: "NEW",
        },
      });

      await prisma.enquiryActivity.create({
        data: { schoolId, enquiryId: enquiry.id, type: "CREATED", description: `Enquiry created — ${body.source ?? "WALK_IN"} source`, createdById: userId },
      });

      return reply.status(201).send({ success: true, message: "Enquiry created.", data: { enquiryId: enquiry.id, enquiryNo } });
    }
  );

  // ── PUT /admin/enquiries/:id ──────────────────────────────
  app.put("/admin/enquiries/:id",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const body = req.body as any;

      await prisma.enquiry.updateMany({ where: { id: parseInt(id), schoolId }, data: {
        ...(body.studentName     && { studentName:       body.studentName }),
        ...(body.gender          && { gender:            body.gender }),
        ...(body.fatherName      && { fatherName:        body.fatherName }),
        ...(body.motherName      && { motherName:        body.motherName }),
        ...(body.mobileNumber    && { mobileNumber:      body.mobileNumber }),
        ...(body.whatsappNumber  && { whatsappNumber:    body.whatsappNumber }),
        ...(body.email           && { email:             body.email }),
        ...(body.address         && { address:           body.address }),
        ...(body.city            && { city:              body.city }),
        ...(body.interestedClass && { interestedClass:   body.interestedClass }),
        ...(body.assignedToId    && { assignedToId:      body.assignedToId }),
        ...(body.remarks         && { remarks:           body.remarks }),
      }});
      return reply.send({ success: true, message: "Enquiry updated." });
    }
  );

  // ── PATCH /admin/enquiries/:id/status ─────────────────────
  app.patch("/admin/enquiries/:id/status",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { status, note } = req.body as { status: string; note?: string };

      await prisma.enquiry.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: status as any } });

      await prisma.enquiryActivity.create({
        data: { schoolId, enquiryId: parseInt(id), type: "STATUS_CHANGE", description: `Status changed to ${status}${note ? " — " + note : ""}`, createdById: userId },
      });

      return reply.send({ success: true, message: `Status → ${status}` });
    }
  );

  // ── POST /admin/enquiries/:id/follow-up ───────────────────
  app.post("/admin/enquiries/:id/follow-up",
    { preHandler: [authenticate, requireCapability('frontOffice.pipeline')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const body = req.body as { scheduledDate: string; scheduledTime?: string; notes?: string };

      const fu = await prisma.followUp.create({
        data: {
          schoolId, enquiryId: parseInt(id), createdById: userId,
          scheduledDate: new Date(body.scheduledDate),
          scheduledTime: body.scheduledTime ?? null,
          notes: body.notes ?? null,
        },
      });

      await prisma.enquiry.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "FOLLOW_UP" } });
      await prisma.enquiryActivity.create({
        data: { schoolId, enquiryId: parseInt(id), type: "FOLLOW_UP", description: `Follow-up scheduled for ${body.scheduledDate}`, createdById: userId },
      });

      return reply.status(201).send({ success: true, data: { followUpId: fu.id } });
    }
  );

  // ── PATCH /admin/enquiries/follow-up/:id ──────────────────
  app.patch("/admin/enquiries/follow-up/:id",
    { preHandler: [authenticate, requireCapability('frontOffice.pipeline')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { status, resultNotes } = req.body as { status: string; resultNotes?: string };

      const fu = await prisma.followUp.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!fu) return reply.status(404).send({ success: false, message: "Not found." });

      await prisma.followUp.update({
        where: { id: parseInt(id) },
        data: { status: status as any, resultNotes: resultNotes ?? null, isDone: true, doneAt: new Date() },
      });

      await prisma.enquiryActivity.create({
        data: { schoolId, enquiryId: fu.enquiryId, type: "CALL", description: `Follow-up result: ${status}${resultNotes ? " — " + resultNotes : ""}`, createdById: userId },
      });

      return reply.send({ success: true, message: "Follow-up updated." });
    }
  );

  // ── GET /admin/enquiries/today-followups ──────────────────
  app.get("/admin/enquiries/today-followups",
    { preHandler: [authenticate, requireCapability('frontOffice.pipeline')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const today = new Date(); today.setHours(0,0,0,0);
      const tomorr = new Date(today); tomorr.setDate(tomorr.getDate()+1);

      const followUps = await prisma.followUp.findMany({
        where: { schoolId, isDone: false, scheduledDate: { gte: today, lt: tomorr } },
        include: {
          enquiry: { select: { studentName:true, mobileNumber:true, interestedClass:true, status:true, enquiryNo:true } },
        },
        orderBy: { scheduledDate: "asc" },
      });

      return reply.send({ success: true, data: { followUps } });
    }
  );

  // ── POST /admin/enquiries/:id/convert ─────────────────────
  app.post("/admin/enquiries/:id/convert",
    { preHandler: [authenticate, requireCapability('frontOffice.pipeline')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };

      const enq = await prisma.enquiry.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!enq) return reply.status(404).send({ success: false, message: "Not found." });

      await prisma.enquiry.update({
        where: { id: parseInt(id) },
        data: { status: "ADMISSION_CONFIRMED", isConverted: true, convertedAt: new Date() },
      });

      await prisma.enquiryActivity.create({
        data: { schoolId, enquiryId: parseInt(id), type: "VISIT", description: "Enquiry converted to admission", createdById: userId },
      });

      // Return pre-filled data for admission form
      return reply.send({
        success: true,
        message: "Enquiry converted.",
        data: {
          prefilled: {
            studentName: enq.studentName, gender: enq.gender,
            dateOfBirth: enq.dateOfBirth, fatherName: enq.fatherName,
            motherName: enq.motherName, mobileNumber: enq.mobileNumber,
            email: enq.email, address: enq.address, city: enq.city,
            admissionClass: enq.interestedClass, session: enq.interestedSession,
          },
        },
      });
    }
  );

  // ── GET /admin/enquiries/report ───────────────────────────
  app.get("/admin/enquiries/report",
    { preHandler: [authenticate, requireCapability('frontOffice.pipeline')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string };

      const where: any = { schoolId };
      if (q.from || q.to) {
        where.createdAt = {};
        if (q.from) where.createdAt.gte = new Date(q.from);
        if (q.to)   where.createdAt.lte = new Date(q.to);
      }

      const [bySource, byStatus, byClass, counselorReport] = await Promise.all([
        prisma.enquiry.groupBy({ by: ["source"], where, _count: true }),
        prisma.enquiry.groupBy({ by: ["status"], where, _count: true }),
        prisma.enquiry.groupBy({ by: ["interestedClass"], where, _count: true }),
        prisma.enquiry.groupBy({ by: ["assignedToId"], where, _count: true }),
      ]);

      // Enrich counselor names
      const counselorIds = counselorReport.map(c => c.assignedToId).filter(Boolean) as number[];
      const counselors = counselorIds.length > 0
        ? await prisma.user.findMany({ where: { id: { in: counselorIds } }, select: { id:true, name:true } })
        : [];
      const cMap: Record<number,string> = {};
      counselors.forEach(c => { cMap[c.id] = c.name; });

      return reply.send({
        success: true,
        data: {
          bySource: bySource.map(b => ({ source: b.source, count: b._count })).sort((a,b)=>b.count-a.count),
          byStatus: byStatus.map(b => ({ status: b.status, count: b._count })),
          byClass:  byClass.map(b => ({ class: b.interestedClass ?? "Unknown", count: b._count })).sort((a,b)=>b.count-a.count),
          byCounselor: counselorReport.map(b => ({ name: b.assignedToId ? (cMap[b.assignedToId]??"—") : "Unassigned", count: b._count })),
        },
      });
    }
  );

  // ── DELETE /admin/enquiries/:id ───────────────────────────
  app.delete("/admin/enquiries/:id",
    { preHandler: [authenticate, requireCapability('frontOffice.enquiryLog')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.enquiry.deleteMany({ where: { id: parseInt(id), schoolId } });
      return reply.send({ success: true, message: "Enquiry deleted." });
    }
  );
}
