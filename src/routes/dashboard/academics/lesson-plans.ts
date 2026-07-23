// apps/api/src/routes/dashboard/academics/lesson-plans.ts
//
// NEW MODULE — Lesson Plans, with approval workflow.
//
// Business rules (based on the confirmed schema):
//   - Teacher creates as DRAFT, can freely edit while DRAFT/REJECTED.
//   - Once submitted (PENDING_APPROVAL) or APPROVED, core content is
//     locked from editing — only status (teaching progress) can still
//     change, since that's independent of approval.
//   - Approve/Reject is restricted to SYSTEM_ADMIN (no HOD/coordinator
//     role confirmed in this schema, so admin is the only approver).
//   - weekNumber/monthNumber are auto-computed server-side from
//     plannedDate — not asked from the user, just handy metadata.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { appAuth } from "../../../middleware/appAuth.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { z } from "zod";

const TEACHING_METHODS = ["LECTURE","ACTIVITY","DISCUSSION","PRACTICAL","PROJECT_BASED","SMART_CLASS","FLIPPED_CLASS"] as const;
const LESSON_STATUSES = ["NOT_STARTED","IN_PROGRESS","COMPLETED","REVISION"] as const;

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[academics/lesson-plans] "${label}" failed:`, err?.message ?? err); return fallback; }
}

// ISO-ish week-of-year (Mon-start), good enough for grouping/display purposes.
function weekOfYear(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

const createSchema = z.object({
  classId:      z.number(),
  subjectId:    z.number(),
  chapterId:    z.number().optional(),
  topicId:      z.number().optional(),
  title:        z.string().min(1),
  objectives:   z.array(z.string()).default([]),
  teachingMethod: z.enum(TEACHING_METHODS).default("LECTURE"),
  durationMins: z.number().default(45),
  outcomes:     z.array(z.string()).default([]),
  notes:        z.string().optional(),
  plannedDate:  z.string().optional(), // "YYYY-MM-DD"
});

const updateSchema = createSchema.partial().omit({ classId: true, subjectId: true });

export async function academicsLessonPlanRoutes(app: FastifyInstance) {

  // ── GET /academics/lesson-plans?classId=&subjectId= ─────────
  app.get("/academics/lesson-plans",
    { preHandler: [appAuth, requireCapability('academics.lessonPlans')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { classId, subjectId } = req.query as Record<string, string>;

      const plans = await safe("plans fetch", () =>
        prisma.studyLessonPlan.findMany({
          where: {
            schoolId, staffId,
            ...(classId ? { classId: parseInt(classId) } : {}),
            ...(subjectId ? { subjectId: parseInt(subjectId) } : {}),
          },
          orderBy: [{ plannedDate: "asc" }, { createdAt: "desc" }],
          select: {
            id: true, title: true, teachingMethod: true, durationMins: true,
            plannedDate: true, weekNumber: true, status: true, approvalStatus: true,
            chapter: { select: { name: true, chapterNumber: true } },
            topic: { select: { name: true } },
          },
        }), [] as any[]);

      return reply.send({ success: true, data: { plans } });
    }
  );

  // ── GET /academics/lesson-plans/:id — Detail ────────────────
  app.get("/academics/lesson-plans/:id",
    { preHandler: [appAuth, requireCapability('academics.lessonPlans')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req as any;
      const { id } = req.params as { id: string };

      const plan = await prisma.studyLessonPlan.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          class: { select: { name: true, section: true } },
          subject: { select: { name: true } },
          chapter: { select: { name: true, chapterNumber: true } },
          topic: { select: { name: true } },
          approvedBy: { select: { user: { select: { name: true } } } },
          materials: {
            include: { material: { select: { id: true, title: true, type: true, fileUrl: true, externalUrl: true } } },
            orderBy: { sortOrder: "asc" },
          },
        },
      });

      if (!plan) return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      return reply.send({ success: true, data: { plan } });
    }
  );

  // ── POST /academics/lesson-plans — Create (as DRAFT) ────────
  app.post("/academics/lesson-plans",
    { preHandler: [appAuth, requireCapability('academics.lessonPlans')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;

      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });
      const { classId, subjectId, chapterId, topicId, title, objectives, teachingMethod, durationMins, outcomes, notes, plannedDate } = parsed.data;

      const cls = await safe("class lookup", () =>
        prisma.class.findFirst({ where: { id: classId, schoolId }, select: { academicYear: true } }), null);
      if (!cls) return reply.status(404).send({ success: false, error: "CLASS_NOT_FOUND" });

      const date = plannedDate ? new Date(plannedDate) : null;

      const plan = await prisma.studyLessonPlan.create({
        data: {
          schoolId, staffId, classId, subjectId,
          chapterId: chapterId ?? null, topicId: topicId ?? null,
          title, objectives, teachingMethod, durationMins, outcomes, notes: notes ?? null,
          academicYear: cls.academicYear,
          plannedDate: date, weekNumber: date ? weekOfYear(date) : null, monthNumber: date ? date.getMonth() + 1 : null,
          status: "NOT_STARTED", approvalStatus: "DRAFT",
        },
      });

      return reply.status(201).send({ success: true, message: "Lesson plan created", data: { id: plan.id } });
    }
  );

  // ── PATCH /academics/lesson-plans/:id — Edit (DRAFT/REJECTED only) ──
  app.patch("/academics/lesson-plans/:id",
    { preHandler: [appAuth, requireCapability('academics.lessonPlans')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { id } = req.params as { id: string };

      const existing = await prisma.studyLessonPlan.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      if (existing.staffId !== staffId) return reply.status(403).send({ success: false, error: "NOT_ALLOWED" });
      if (!["DRAFT", "REJECTED"].includes(existing.approvalStatus)) {
        return reply.status(403).send({ success: false, error: "LOCKED", message: "Only draft or rejected plans can be edited." });
      }

      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });
      const { chapterId, topicId, title, objectives, teachingMethod, durationMins, outcomes, notes, plannedDate } = parsed.data;
      const date = plannedDate ? new Date(plannedDate) : undefined;

      await prisma.studyLessonPlan.update({
        where: { id: parseInt(id) },
        data: {
          ...(chapterId !== undefined ? { chapterId } : {}),
          ...(topicId !== undefined ? { topicId } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(objectives !== undefined ? { objectives } : {}),
          ...(teachingMethod !== undefined ? { teachingMethod } : {}),
          ...(durationMins !== undefined ? { durationMins } : {}),
          ...(outcomes !== undefined ? { outcomes } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(date !== undefined ? { plannedDate: date, weekNumber: weekOfYear(date), monthNumber: date.getMonth() + 1 } : {}),
          // Re-editing a rejected plan sends it back to draft
          approvalStatus: existing.approvalStatus === "REJECTED" ? "DRAFT" : existing.approvalStatus,
        },
      });

      return reply.send({ success: true, message: "Lesson plan updated" });
    }
  );

  // ── PATCH /academics/lesson-plans/:id/status — Teaching progress ──
  app.patch("/academics/lesson-plans/:id/status",
    { preHandler: [appAuth, requireCapability('academics.lessonPlans')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { id } = req.params as { id: string };
      const { status } = req.body as { status: string };

      if (!LESSON_STATUSES.includes(status as any)) {
        return reply.status(400).send({ success: false, error: "INVALID_STATUS" });
      }

      const existing = await prisma.studyLessonPlan.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      if (existing.staffId !== staffId) return reply.status(403).send({ success: false, error: "NOT_ALLOWED" });

      await prisma.studyLessonPlan.update({
        where: { id: parseInt(id) },
        data: { status: status as any, completedAt: status === "COMPLETED" ? new Date() : null },
      });

      return reply.send({ success: true, message: "Status updated" });
    }
  );

  // ── POST /academics/lesson-plans/:id/submit — DRAFT/REJECTED → PENDING_APPROVAL ──
  app.post("/academics/lesson-plans/:id/submit",
    { preHandler: [appAuth, requireCapability('academics.lessonPlans')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { id } = req.params as { id: string };

      const existing = await prisma.studyLessonPlan.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      if (existing.staffId !== staffId) return reply.status(403).send({ success: false, error: "NOT_ALLOWED" });
      if (!["DRAFT", "REJECTED"].includes(existing.approvalStatus)) {
        return reply.status(400).send({ success: false, error: "ALREADY_SUBMITTED" });
      }

      await prisma.studyLessonPlan.update({
        where: { id: parseInt(id) },
        data: { approvalStatus: "PENDING_APPROVAL" },
      });

      return reply.send({ success: true, message: "Submitted for approval" });
    }
  );

  // ── PATCH /academics/lesson-plans/:id/approval — Admin approve/reject ──
  app.patch("/academics/lesson-plans/:id/approval",
    { preHandler: [appAuth, requireCapability('academics.lessonPlans')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, role, staffId } = req as any;
      const { id } = req.params as { id: string };
      const { action } = req.body as { action: "APPROVE" | "REJECT" };

      if (role !== "SYSTEM_ADMIN") {
        return reply.status(403).send({ success: false, error: "NOT_ALLOWED", message: "Only admin can approve lesson plans." });
      }

      const existing = await prisma.studyLessonPlan.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      if (existing.approvalStatus !== "PENDING_APPROVAL") {
        return reply.status(400).send({ success: false, error: "NOT_PENDING" });
      }

      await prisma.studyLessonPlan.update({
        where: { id: parseInt(id) },
        data: {
          approvalStatus: action === "APPROVE" ? "APPROVED" : "REJECTED",
          approvedById: staffId, approvedAt: new Date(),
        },
      });

      return reply.send({ success: true, message: `Lesson plan ${action === "APPROVE" ? "approved" : "rejected"}` });
    }
  );

  // ── DELETE /academics/lesson-plans/:id — DRAFT only ─────────
  app.delete("/academics/lesson-plans/:id",
    { preHandler: [appAuth, requireCapability('academics.lessonPlans')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { id } = req.params as { id: string };

      const existing = await prisma.studyLessonPlan.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!existing) return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      if (existing.staffId !== staffId) return reply.status(403).send({ success: false, error: "NOT_ALLOWED" });
      if (existing.approvalStatus !== "DRAFT") {
        return reply.status(403).send({ success: false, error: "LOCKED", message: "Only draft plans can be deleted." });
      }

      await prisma.studyLessonPlan.delete({ where: { id: parseInt(id) } });
      return reply.send({ success: true, message: "Lesson plan deleted" });
    }
  );

  // ── POST /academics/lesson-plans/:id/materials — Attach material ──
  app.post("/academics/lesson-plans/:id/materials",
    { preHandler: [appAuth, requireCapability('academics.lessonPlans')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { id } = req.params as { id: string };
      const { materialId } = req.body as { materialId: number };

      const plan = await prisma.studyLessonPlan.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!plan) return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      if (plan.staffId !== staffId) return reply.status(403).send({ success: false, error: "NOT_ALLOWED" });

      await prisma.studyLessonPlanMaterial.upsert({
        where: { lessonPlanId_materialId: { lessonPlanId: parseInt(id), materialId } },
        update: {},
        create: { lessonPlanId: parseInt(id), materialId },
      });

      return reply.send({ success: true, message: "Material attached" });
    }
  );

  // ── DELETE /academics/lesson-plans/:id/materials/:materialId ──
  app.delete("/academics/lesson-plans/:id/materials/:materialId",
    { preHandler: [appAuth, requireCapability('academics.lessonPlans')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, staffId } = req as any;
      const { id, materialId } = req.params as { id: string; materialId: string };

      const plan = await prisma.studyLessonPlan.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!plan) return reply.status(404).send({ success: false, error: "NOT_FOUND" });
      if (plan.staffId !== staffId) return reply.status(403).send({ success: false, error: "NOT_ALLOWED" });

      await prisma.studyLessonPlanMaterial.deleteMany({
        where: { lessonPlanId: parseInt(id), materialId: parseInt(materialId) },
      });

      return reply.send({ success: true, message: "Material removed" });
    }
  );
}