// apps/api/src/routes/admin/hr/recruitment-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminRecruitmentRoutes(app: FastifyInstance) {
  const P = "/admin/hr/recruitment";

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [openJobs, totalApps, scheduledInterviews, selected, offered] = await Promise.all([
        prisma.hrJobOpening.count({ where: { schoolId, status: "PUBLISHED" } }),
        prisma.hrJobApplication.count({ where: { schoolId } }),
        prisma.hrInterview.count({ where: { schoolId, result: "PENDING", cancelledAt: null } }),
        prisma.hrJobApplication.count({ where: { schoolId, stage: "SELECTED" } }),
        prisma.hrJobApplication.count({ where: { schoolId, stage: "OFFERED" } }),
      ]);
      const stageBreakdown = await prisma.hrJobApplication.groupBy({
        by: ["stage"],
        where: { schoolId },
        _count: { id: true },
      });
      const recentApps = await prisma.hrJobApplication.findMany({
        where: { schoolId },
        orderBy: { createdAt: "desc" },
        take: 6,
        include: { job: { select: { title: true } } },
      });
      return rep.send({ openJobs, totalApps, scheduledInterviews, selected, offered, stageBreakdown, recentApps });
    }
  );

  // ─── JOB OPENINGS ─────────────────────────────────────────
  app.get(`${P}/jobs`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const jobs = await prisma.hrJobOpening.findMany({
        where: {
          schoolId,
          ...(q.status ? { status: q.status as any } : {}),
          ...(q.deptId ? { departmentId: Number(q.deptId) } : {}),
          ...(q.search ? { title: { contains: q.search, mode: "insensitive" } } : {}),
        },
        include: {
          department: { select: { name: true } },
          designation: { select: { name: true } },
          _count: { select: { applications: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ jobs });
    }
  );

  app.post(`${P}/jobs`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const job = await prisma.hrJobOpening.create({
        data: {
          schoolId,
          departmentId: Number(b.departmentId),
          designationId: Number(b.designationId),
          title: b.title,
          positions: Number(b.positions ?? 1),
          qualification: b.qualification ?? null,
          experience: b.experience ?? null,
          description: b.description ?? null,
          status: b.status ?? "DRAFT",
          closingDate: b.closingDate ? new Date(b.closingDate) : null,
        },
      });
      return rep.send({ job });
    }
  );

  app.put(`${P}/jobs/:id`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const job = await prisma.hrJobOpening.update({
        where: { id, schoolId },
        data: {
          title: b.title,
          positions: b.positions ? Number(b.positions) : undefined,
          qualification: b.qualification,
          experience: b.experience,
          description: b.description,
          status: b.status,
          closingDate: b.closingDate ? new Date(b.closingDate) : undefined,
          departmentId: b.departmentId ? Number(b.departmentId) : undefined,
          designationId: b.designationId ? Number(b.designationId) : undefined,
        },
      });
      return rep.send({ job });
    }
  );

  app.delete(`${P}/jobs/:id`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.hrJobOpening.delete({ where: { id, schoolId } });
      return rep.send({ ok: true });
    }
  );

  // ─── APPLICATIONS ─────────────────────────────────────────
  app.get(`${P}/applications`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const apps = await prisma.hrJobApplication.findMany({
        where: {
          schoolId,
          ...(q.jobId ? { jobId: Number(q.jobId) } : {}),
          ...(q.stage ? { stage: q.stage as any } : {}),
          ...(q.search ? {
            OR: [
              { name: { contains: q.search, mode: "insensitive" } },
              { email: { contains: q.search, mode: "insensitive" } },
              { mobile: { contains: q.search } },
            ],
          } : {}),
        },
        include: {
          job: { select: { title: true, department: { select: { name: true } } } },
          interviews: { orderBy: { scheduledAt: "desc" }, take: 1 },
        },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ apps });
    }
  );

  app.post(`${P}/applications`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const app2 = await prisma.hrJobApplication.create({
        data: {
          schoolId,
          jobId: Number(b.jobId),
          name: b.name,
          mobile: b.mobile,
          email: b.email ?? null,
          qualification: b.qualification ?? null,
          experience: b.experience ?? null,
          resumeUrl: b.resumeUrl ?? null,
          stage: "APPLIED",
          tags: b.tags ?? [],
          notes: b.notes ?? null,
        },
      });
      return rep.send({ app: app2 });
    }
  );

  app.put(`${P}/applications/:id/stage`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const app2 = await prisma.hrJobApplication.update({
        where: { id, schoolId },
        data: { stage: b.stage as any, notes: b.notes ?? undefined },
      });
      return rep.send({ app: app2 });
    }
  );

  app.delete(`${P}/applications/:id`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      await prisma.hrJobApplication.delete({ where: { id, schoolId } });
      return rep.send({ ok: true });
    }
  );

  // ─── INTERVIEWS ───────────────────────────────────────────
  app.get(`${P}/interviews`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const interviews = await prisma.hrInterview.findMany({
        where: {
          schoolId,
          ...(q.result ? { result: q.result as any } : {}),
        },
        include: {
          application: {
            select: {
              name: true, mobile: true,
              job: { select: { title: true, department: { select: { name: true } } } },
            },
          },
        },
        orderBy: { scheduledAt: "desc" },
      });
      return rep.send({ interviews });
    }
  );

  app.post(`${P}/interviews`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const interview = await prisma.hrInterview.create({
        data: {
          schoolId,
          applicationId: Number(b.applicationId),
          scheduledAt: new Date(b.scheduledAt),
          mode: b.mode ?? "OFFLINE",
          panel: b.panel ?? [],
          venue: b.venue ?? null,
          meetingLink: b.meetingLink ?? null,
          result: "PENDING",
        },
      });
      // Move application to INTERVIEW stage
      await prisma.hrJobApplication.update({
        where: { id: Number(b.applicationId), schoolId },
        data: { stage: "INTERVIEW" },
      });
      return rep.send({ interview });
    }
  );

  app.put(`${P}/interviews/:id/feedback`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const interview = await prisma.hrInterview.update({
        where: { id, schoolId },
        data: {
          result: b.result as any,
          subjectKnowledge: b.subjectKnowledge ? Number(b.subjectKnowledge) : null,
          communication: b.communication ? Number(b.communication) : null,
          experience: b.experience ? Number(b.experience) : null,
          overallRating: b.overallRating ? Number(b.overallRating) : null,
          feedback: b.feedback ?? null,
          conductedAt: new Date(),
        },
      });
      // If selected, update application stage
      if (b.result === "SELECTED") {
        await prisma.hrJobApplication.update({
          where: { id: interview.applicationId, schoolId },
          data: { stage: "SELECTED" },
        });
      }
      return rep.send({ interview });
    }
  );

  // ─── OFFER LETTERS ────────────────────────────────────────
  app.get(`${P}/offers`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const offers = await prisma.hrOfferLetter.findMany({
        where: { schoolId },
        include: {
          application: {
            select: {
              name: true, mobile: true, email: true,
              job: { select: { title: true, department: { select: { name: true } } } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      return rep.send({ offers });
    }
  );

  app.post(`${P}/offers`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const offer = await prisma.hrOfferLetter.create({
        data: {
          schoolId,
          applicationId: Number(b.applicationId),
          offeredSalary: b.offeredSalary,
          joiningDate: b.joiningDate ? new Date(b.joiningDate) : null,
          validUntil: b.validUntil ? new Date(b.validUntil) : null,
          fileUrl: b.fileUrl ?? null,
          notes: b.notes ?? null,
          status: "SENT",
        },
      });
      await prisma.hrJobApplication.update({
        where: { id: Number(b.applicationId), schoolId },
        data: { stage: "OFFERED" },
      });
      return rep.send({ offer });
    }
  );

  app.put(`${P}/offers/:id/respond`, { preHandler: [authenticate, requireCapability('hr.recruitment')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const offer = await prisma.hrOfferLetter.update({
        where: { id, schoolId },
        data: { response: b.response, responseAt: new Date() },
      });
      if (b.response === "ACCEPTED") {
        await prisma.hrJobApplication.update({
          where: { id: offer.applicationId, schoolId },
          data: { stage: "JOINED" },
        });
      }
      return rep.send({ offer });
    }
  );
}
