// apps/api/src/routes/student/certificates.ts
//
// Certificates — CertIssued (confirmed model) + CertRequest (for the
// "request a new certificate" flow under Download Certificates).
// Academic/Achievement screens filter CertIssued by category;
// Download screen shows ALL valid certs + request history/form.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { z } from "zod";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/certificates] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function getStudentId(userId: number, schoolId: number): Promise<number | null> {
  const s = await safe("student lookup", () =>
    prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true } }), null);
  return s?.id ?? null;
}

const requestSchema = z.object({
  certType: z.string(), purpose: z.string().optional(), urgency: z.enum(["NORMAL", "URGENT"]).default("NORMAL"), copies: z.number().min(1).default(1),
});

export async function studentCertificatesRoutes(app: FastifyInstance) {

  // ── GET /student/certificates/academic ───────────────────────
  app.get("/student/certificates/academic",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const certs = await safe("academic certs", () =>
        prisma.certIssued.findMany({
          where: { studentId: sid, schoolId, category: "ACADEMIC", status: "VALID" },
          orderBy: { issuedDate: "desc" },
          select: { id: true, certNumber: true, certType: true, title: true, issuedDate: true, validUntil: true, pdfUrl: true },
        }), [] as any[]);

      return reply.send({ success: true, data: { certificates: certs } });
    }
  );

  // ── GET /student/certificates/achievement ────────────────────
  app.get("/student/certificates/achievement",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const certs = await safe("achievement certs", () =>
        prisma.certIssued.findMany({
          where: { studentId: sid, schoolId, category: "ACHIEVEMENT", status: "VALID" },
          orderBy: { issuedDate: "desc" },
          select: { id: true, certNumber: true, certType: true, title: true, issuedDate: true, pdfUrl: true, purposeNote: true },
        }), [] as any[]);

      return reply.send({ success: true, data: { certificates: certs } });
    }
  );

  // ── GET /student/certificates/all — Download screen, all categories ──
  app.get("/student/certificates/all",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const certs = await safe("all certs", () =>
        prisma.certIssued.findMany({
          where: { studentId: sid, schoolId, status: "VALID" },
          orderBy: { issuedDate: "desc" },
          select: { id: true, certNumber: true, certType: true, category: true, title: true, issuedDate: true, pdfUrl: true, downloadCount: true },
        }), [] as any[]);

      return reply.send({ success: true, data: { certificates: certs } });
    }
  );

  // ── PATCH /student/certificates/:id/download — track download ──
  app.patch("/student/certificates/:id/download",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      await safe("increment download", () =>
        prisma.certIssued.update({
          where: { id: parseInt(id) },
          data: { downloadCount: { increment: 1 }, lastAccessedAt: new Date() },
        }), null);
      return reply.send({ success: true });
    }
  );

  // ── GET /student/certificates/requests — request history ────
  app.get("/student/certificates/requests",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const requests = await safe("cert requests", () =>
        prisma.certRequest.findMany({
          where: { studentId: sid, schoolId },
          orderBy: { createdAt: "desc" }, take: 20,
          select: {
            id: true, certType: true, purpose: true, urgency: true, copies: true,
            status: true, rejectionReason: true, createdAt: true,
            certIssued: { select: { id: true, pdfUrl: true } },
          },
        }), [] as any[]);

      return reply.send({ success: true, data: { requests } });
    }
  );

  // ── POST /student/certificates/requests — new request ────────
  app.post("/student/certificates/requests",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });
      const { certType, purpose, urgency, copies } = parsed.data;

      await prisma.certRequest.create({
        data: {
          schoolId, studentId: sid, requestedById: userId,
          certType: certType as any, purpose: purpose ?? null, urgency, copies, status: "PENDING",
        },
      });

      return reply.status(201).send({ success: true, message: "Certificate request submitted" });
    }
  );
}