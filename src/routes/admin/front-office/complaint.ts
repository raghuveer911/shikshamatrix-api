import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ── SLA config per priority ───────────────────────────────────
const SLA_HOURS: Record<string, number> = { LOW: 168, MEDIUM: 72, HIGH: 24, URGENT: 12 };
const DEPT_OPTIONS = ["Accounts","Academics","Transport","Hostel","Administration","IT Support","HR","Other"];

async function genTicketNo(schoolId: number): Promise<string> {
  const y = new Date().getFullYear().toString().slice(-2);
  const m = String(new Date().getMonth() + 1).padStart(2, "0");
  const cnt = await prisma.complaint.count({ where: { schoolId } });
  return `TKT-${y}${m}-${String(cnt + 1).padStart(4, "0")}`;
}

export async function adminComplaintRoutes(app: FastifyInstance) {

  // ── GET /admin/complaints/meta ────────────────────────────
  app.get("/admin/complaints/meta",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();

      const [byStatus, byCategory, byPriority, staff, overdue, avgResolution] = await Promise.all([
        prisma.complaint.groupBy({ by: ["status"],   where: { schoolId }, _count: true }),
        prisma.complaint.groupBy({ by: ["category"], where: { schoolId }, _count: true }),
        prisma.complaint.groupBy({ by: ["priority"], where: { schoolId }, _count: true }),
        prisma.staff.findMany({ where: { schoolId, isActive: true }, select: { userId: true, user: { select: { id: true, name: true } } }, take: 60 }),
        prisma.complaint.count({ where: { schoolId, status: { notIn: ["RESOLVED","CLOSED"] }, slaDeadline: { lt: now } } }),
        prisma.complaint.findMany({ where: { schoolId, resolvedAt: { not: null } }, select: { createdAt: true, resolvedAt: true } }),
      ]);

      const total    = byStatus.reduce((s, b) => s + b._count, 0);
      const open     = byStatus.filter(b => ["OPEN","ASSIGNED","IN_PROGRESS","WAITING_RESPONSE"].includes(b.status)).reduce((s, b) => s + b._count, 0);
      const resolved = byStatus.filter(b => ["RESOLVED","CLOSED"].includes(b.status)).reduce((s, b) => s + b._count, 0);
      const escalated = byStatus.find(b => b.status === "ESCALATED")?._count ?? 0;
      const inProgress = byStatus.find(b => b.status === "IN_PROGRESS")?._count ?? 0;

      const avgResHrs = avgResolution.length > 0
        ? Math.round(avgResolution.reduce((s, c) => s + (new Date(c.resolvedAt!).getTime() - new Date(c.createdAt).getTime()), 0) / avgResolution.length / 3600000 * 10) / 10
        : 0;

      const avgRating = await prisma.complaint.aggregate({ where: { schoolId, feedbackRating: { not: null } }, _avg: { feedbackRating: true } });

      return reply.send({
        success: true,
        data: {
          kpi: { total, open, resolved, escalated, inProgress, overdue, avgResHrs, avgRating: Math.round((avgRating._avg.feedbackRating ?? 0) * 10) / 10 },
          byStatus:   byStatus.map(b => ({ status: b.status,   count: b._count })),
          byCategory: byCategory.map(b => ({ category: b.category, count: b._count })).sort((a, b) => b.count - a.count),
          byPriority: byPriority.map(b => ({ priority: b.priority, count: b._count })),
          staff, deptOptions: DEPT_OPTIONS,
        },
      });
    }
  );

  // ── GET /admin/complaints ─────────────────────────────────
  app.get("/admin/complaints",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; status?: string; category?: string; priority?: string; department?: string; search?: string; assignedToId?: string; onlyOverdue?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 20;

      const where: any = { schoolId };
      if (q.status)       where.status       = q.status;
      if (q.category)     where.category     = q.category;
      if (q.priority)     where.priority     = q.priority;
      if (q.department)   where.department   = q.department;
      if (q.assignedToId) where.assignedToId = parseInt(q.assignedToId);
      if (q.onlyOverdue === "true") { where.slaDeadline = { lt: new Date() }; where.status = { notIn: ["RESOLVED","CLOSED"] }; }
      if (q.search) where.OR = [
        { title:           { contains: q.search, mode: "insensitive" } },
        { complainantName: { contains: q.search, mode: "insensitive" } },
        { ticketNo:        { contains: q.search, mode: "insensitive" } },
        { description:     { contains: q.search, mode: "insensitive" } },
      ];

      const [complaints, total] = await Promise.all([
        prisma.complaint.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
          include: { assignedTo: { select: { name: true } }, createdBy: { select: { name: true } }, relatedStudent: { include: { user: { select: { name: true } } } }, _count: { select: { timeline: true } } } }),
        prisma.complaint.count({ where }),
      ]);

      const now = new Date();
      const enriched = complaints.map(c => ({
        ...c,
        isOverdue: c.slaDeadline ? new Date(c.slaDeadline) < now && !["RESOLVED","CLOSED"].includes(c.status) : false,
        slaRemaining: c.slaDeadline && !["RESOLVED","CLOSED"].includes(c.status) ? Math.round((new Date(c.slaDeadline).getTime() - now.getTime()) / 3600000) : null,
      }));

      return reply.send({ success: true, data: { complaints: enriched, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // ── GET /admin/complaints/:id ─────────────────────────────
  app.get("/admin/complaints/:id",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const complaint = await prisma.complaint.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          assignedTo: { select: { name: true } }, createdBy: { select: { name: true } },
          escalatedTo: { select: { name: true } }, relatedStudent: { include: { user: { select: { name: true } } } },
          timeline: { orderBy: { createdAt: "asc" }, include: { createdBy: { select: { name: true } } } },
        },
      });
      if (!complaint) return reply.status(404).send({ success: false, message: "Not found." });
      const isOverdue = complaint.slaDeadline ? new Date(complaint.slaDeadline) < new Date() && !["RESOLVED","CLOSED"].includes(complaint.status) : false;
      return reply.send({ success: true, data: { complaint: { ...complaint, isOverdue } } });
    }
  );

  // ── POST /admin/complaints ────────────────────────────────
  app.post("/admin/complaints",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        complaintBy: string; complainantName: string; complainantMobile?: string; complainantEmail?: string; isAnonymous?: boolean;
        relatedStudentId?: number; relatedModule?: string; relatedModuleId?: number;
        category: string; title: string; description: string; priority?: string;
        attachmentUrls?: string[]; tags?: string[];
        assignedToId?: number; department?: string;
      };

      if (!body.title?.trim() || !body.description?.trim() || !body.complainantName?.trim())
        return reply.status(400).send({ success: false, message: "title, description, complainantName required." });

      const ticketNo = await genTicketNo(schoolId);
      const slaHrs   = SLA_HOURS[body.priority ?? "MEDIUM"] ?? 72;
      const slaDeadline = new Date(Date.now() + slaHrs * 3600000);

      const complaint = await prisma.complaint.create({
        data: {
          schoolId, createdById: userId, ticketNo,
          complaintBy: body.complaintBy as any ?? "PARENT",
          complainantName: body.complainantName.trim(),
          complainantMobile: body.complainantMobile ?? null,
          complainantEmail:  body.complainantEmail  ?? null,
          isAnonymous:       body.isAnonymous ?? false,
          relatedStudentId:  body.relatedStudentId  ?? null,
          relatedModule:     body.relatedModule     ?? null,
          relatedModuleId:   body.relatedModuleId   ?? null,
          category:    body.category as any ?? "OTHER",
          title:       body.title.trim(),
          description: body.description.trim(),
          priority:    body.priority as any ?? "MEDIUM",
          attachmentUrls: body.attachmentUrls ?? [],
          tags:        body.tags ?? [],
          assignedToId: body.assignedToId ?? null,
          department:   body.department   ?? null,
          assignedAt:   body.assignedToId ? new Date() : null,
          status:       body.assignedToId ? "ASSIGNED" : "OPEN",
          slaDeadline, slaHours: slaHrs,
        },
      });

      await prisma.complaintTimeline.create({
        data: { schoolId, complaintId: complaint.id, type: "CREATED", content: `Complaint registered (${body.category}) — SLA: ${slaHrs}h`, isPublic: true, createdById: userId },
      });
      if (body.assignedToId) {
        const assignee = await prisma.user.findFirst({ where: { id: body.assignedToId }, select: { name: true } });
        await prisma.complaintTimeline.create({
          data: { schoolId, complaintId: complaint.id, type: "ASSIGNMENT", content: `Assigned to ${assignee?.name ?? "—"}${body.department ? " | Dept: " + body.department : ""}`, isPublic: false, createdById: userId },
        });
      }

      return reply.status(201).send({ success: true, message: "Complaint registered.", data: { complaintId: complaint.id, ticketNo, slaDeadline } });
    }
  );

  // ── PUT /admin/complaints/:id ─────────────────────────────
  app.put("/admin/complaints/:id",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const data: any = {};
      ["title","description","category","priority","department","tags","attachmentUrls"].forEach(k => { if (body[k] !== undefined) data[k] = body[k]; });
      await prisma.complaint.updateMany({ where: { id: parseInt(id), schoolId }, data });
      return reply.send({ success: true, message: "Updated." });
    }
  );

  // ── PATCH /admin/complaints/:id/status ───────────────────
  app.patch("/admin/complaints/:id/status",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { status, note, isPublic, resolutionSummary } = req.body as { status: string; note?: string; isPublic?: boolean; resolutionSummary?: string };

      const updates: any = { status: status as any };
      if (status === "RESOLVED") { updates.resolvedAt = new Date(); if (resolutionSummary) updates.resolutionSummary = resolutionSummary; }
      if (status === "CLOSED")    updates.closedAt    = new Date();

      await prisma.complaint.updateMany({ where: { id: parseInt(id), schoolId }, data: updates });
      await prisma.complaintTimeline.create({
        data: { schoolId, complaintId: parseInt(id), type: "STATUS_CHANGE", content: `Status → ${status}${note ? " — " + note : ""}`, isPublic: isPublic ?? false, createdById: userId },
      });

      return reply.send({ success: true, message: `Status updated to ${status}` });
    }
  );

  // ── PATCH /admin/complaints/:id/assign ───────────────────
  app.patch("/admin/complaints/:id/assign",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { assignedToId, department } = req.body as { assignedToId: number; department?: string };

      await prisma.complaint.updateMany({ where: { id: parseInt(id), schoolId }, data: { assignedToId, department: department ?? null, status: "ASSIGNED", assignedAt: new Date() } });
      const assignee = await prisma.user.findFirst({ where: { id: assignedToId }, select: { name: true } });
      await prisma.complaintTimeline.create({
        data: { schoolId, complaintId: parseInt(id), type: "ASSIGNMENT", content: `Assigned to ${assignee?.name ?? "—"}${department ? " ("+department+")" : ""}`, isPublic: false, createdById: userId },
      });

      return reply.send({ success: true, message: "Complaint assigned." });
    }
  );

  // ── POST /admin/complaints/:id/note ──────────────────────
  app.post("/admin/complaints/:id/note",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { content, isPublic, attachmentUrls } = req.body as { content: string; isPublic: boolean; attachmentUrls?: string[] };

      await prisma.complaintTimeline.create({
        data: { schoolId, complaintId: parseInt(id), type: isPublic ? "NOTE" : "NOTE", content: content.trim(), isPublic, attachmentUrls: attachmentUrls ?? [], createdById: userId },
      });
      if (isPublic) {
        await prisma.complaint.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "WAITING_RESPONSE" } });
      }

      return reply.send({ success: true, message: "Note added." });
    }
  );

  // ── POST /admin/complaints/:id/escalate ──────────────────
  app.post("/admin/complaints/:id/escalate",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { escalationLevel, escalatedToId, reason, isAuto } = req.body as { escalationLevel: string; escalatedToId?: number; reason?: string; isAuto?: boolean };

      await prisma.complaint.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "ESCALATED", escalationLevel: escalationLevel as any, escalatedToId: escalatedToId ?? null, escalatedAt: new Date(), autoEscalated: isAuto ?? false } });
      await prisma.complaintTimeline.create({
        data: { schoolId, complaintId: parseInt(id), type: "ESCALATION", content: `${isAuto ? "⚡ Auto-" : ""}Escalated to ${escalationLevel.replace(/_/g," ")}${reason ? " — " + reason : ""}`, isPublic: false, createdById: userId },
      });

      return reply.send({ success: true, message: "Complaint escalated." });
    }
  );

  // ── POST /admin/complaints/:id/resolve ───────────────────
  app.post("/admin/complaints/:id/resolve",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { resolutionSummary, note } = req.body as { resolutionSummary: string; note?: string };

      if (!resolutionSummary?.trim()) return reply.status(400).send({ success: false, message: "resolutionSummary required." });

      await prisma.complaint.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "RESOLVED", resolvedAt: new Date(), resolutionSummary: resolutionSummary.trim() } });
      await prisma.complaintTimeline.create({
        data: { schoolId, complaintId: parseInt(id), type: "RESOLUTION", content: `✅ Resolved: ${resolutionSummary.trim()}${note ? " — " + note : ""}`, isPublic: true, createdById: userId },
      });

      return reply.send({ success: true, message: "Complaint resolved." });
    }
  );

  // ── POST /admin/complaints/:id/reopen ────────────────────
  app.post("/admin/complaints/:id/reopen",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason?: string };

      await prisma.complaint.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "OPEN", resolvedAt: null, closedAt: null } });
      await prisma.complaintTimeline.create({
        data: { schoolId, complaintId: parseInt(id), type: "STATUS_CHANGE", content: `🔄 Complaint reopened${reason ? " — " + reason : ""}`, isPublic: true, createdById: userId },
      });

      return reply.send({ success: true, message: "Complaint reopened." });
    }
  );

  // ── POST /admin/complaints/:id/feedback ──────────────────
  app.post("/admin/complaints/:id/feedback",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { feedbackRating, feedbackComment } = req.body as { feedbackRating: number; feedbackComment?: string };

      await prisma.complaint.updateMany({ where: { id: parseInt(id), schoolId }, data: { feedbackRating, feedbackComment: feedbackComment ?? null, feedbackAt: new Date(), status: "CLOSED" } });
      return reply.send({ success: true, message: "Feedback submitted." });
    }
  );

  // ── POST /admin/complaints/auto-escalate ─────────────────
  // Run via cron or manual trigger — check overdue complaints
  app.post("/admin/complaints/auto-escalate",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const now = new Date();

      const overdue = await prisma.complaint.findMany({
        where: { schoolId, status: { notIn: ["RESOLVED","CLOSED","ESCALATED"] }, slaDeadline: { lt: now }, autoEscalated: false },
        select: { id: true, priority: true, escalationLevel: true },
      });

      let escalated = 0;
      for (const c of overdue) {
        const nextLevel = c.escalationLevel === null ? "DEPARTMENT_HEAD"
          : c.escalationLevel === "DEPARTMENT_HEAD" ? "PRINCIPAL"
          : c.escalationLevel === "PRINCIPAL" ? "MANAGEMENT"
          : null;

        if (nextLevel) {
          await prisma.complaint.update({ where: { id: c.id }, data: { status: "ESCALATED", escalationLevel: nextLevel as any, escalatedAt: now, autoEscalated: true } });
          await prisma.complaintTimeline.create({
            data: { schoolId, complaintId: c.id, type: "ESCALATION", content: `⚡ Auto-escalated to ${nextLevel.replace(/_/g," ")} (SLA breached)`, isPublic: false, createdById: userId },
          });
          escalated++;
        }
      }

      return reply.send({ success: true, message: `Auto-escalated ${escalated} complaint(s).`, data: { escalated } });
    }
  );

  // ── GET /admin/complaints/report ─────────────────────────
  app.get("/admin/complaints/report",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string; groupBy?: string };

      const where: any = { schoolId };
      if (q.from || q.to) {
        where.createdAt = {};
        if (q.from) where.createdAt.gte = new Date(q.from);
        if (q.to)   where.createdAt.lte = new Date(q.to);
      }

      const [byCategory, byDept, byStatus, byStaff, resolutionData] = await Promise.all([
        prisma.complaint.groupBy({ by: ["category"],   where, _count: true }),
        prisma.complaint.groupBy({ by: ["department"], where, _count: true }),
        prisma.complaint.groupBy({ by: ["status"],     where, _count: true }),
        prisma.complaint.groupBy({ by: ["assignedToId"], where, _count: true }),
        prisma.complaint.findMany({ where: { ...where, resolvedAt: { not: null } }, select: { createdAt: true, resolvedAt: true, priority: true } }),
      ]);

      // Staff name enrichment
      const staffIds = byStaff.map(b => b.assignedToId).filter(Boolean) as number[];
      const staffUsers = staffIds.length > 0 ? await prisma.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }) : [];
      const staffMap: Record<number, string> = {};
      staffUsers.forEach(u => { staffMap[u.id] = u.name; });

      // Avg resolution per priority
      const resByPriority: Record<string, number[]> = {};
      resolutionData.forEach(r => {
        if (!resByPriority[r.priority]) resByPriority[r.priority] = [];
        resByPriority[r.priority].push((new Date(r.resolvedAt!).getTime() - new Date(r.createdAt).getTime()) / 3600000);
      });
      const avgResByPriority = Object.entries(resByPriority).map(([priority, hrs]) => ({
        priority, avgHrs: Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length * 10) / 10,
      }));

      // SLA compliance rate
      const total = resolutionData.length;
      const withinSla = resolutionData.filter(r => {
        const slaHrs = SLA_HOURS[r.priority] ?? 72;
        const hrs = (new Date(r.resolvedAt!).getTime() - new Date(r.createdAt).getTime()) / 3600000;
        return hrs <= slaHrs;
      }).length;
      const slaComplianceRate = total > 0 ? Math.round((withinSla / total) * 100) : 0;

      const avgRating = await prisma.complaint.aggregate({ where: { ...where, feedbackRating: { not: null } }, _avg: { feedbackRating: true } });

      return reply.send({
        success: true,
        data: {
          byCategory:   byCategory.map(b => ({ category: b.category, count: b._count })).sort((a, b) => b.count - a.count),
          byDept:       byDept.map(b => ({ dept: b.department ?? "Unassigned", count: b._count })),
          byStatus:     byStatus.map(b => ({ status: b.status, count: b._count })),
          byStaff:      byStaff.map(b => ({ name: b.assignedToId ? (staffMap[b.assignedToId] ?? "—") : "Unassigned", count: b._count })),
          avgResByPriority, slaComplianceRate,
          avgRating:    Math.round((avgRating._avg.feedbackRating ?? 0) * 10) / 10,
        },
      });
    }
  );

  // ── DELETE /admin/complaints/:id ─────────────────────────
  app.delete("/admin/complaints/:id",
    { preHandler: [authenticate, requireCapability('frontOffice.complaintManagement')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.complaint.deleteMany({ where: { id: parseInt(id), schoolId } });
      return reply.send({ success: true });
    }
  );
}
