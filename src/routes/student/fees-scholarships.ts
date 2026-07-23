// apps/api/src/routes/student/fees-scholarships.ts
//
// Scholarships (own + available programs) + Discounts. All confirmed
// models: StudentScholarship, ScholarshipProgram, FeeDiscount.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/fees-scholarships] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function getStudentContext(userId: number, schoolId: number) {
  return safe("student lookup", () =>
    prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true, classId: true } }), null);
}

export async function studentFeesScholarshipsRoutes(app: FastifyInstance) {

  // ── GET /student/fees/scholarships ────────────────────────────
  app.get("/student/fees/scholarships",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const student = await getStudentContext(userId, schoolId);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const [myScholarships, availablePrograms] = await Promise.all([
        safe("my scholarships", () =>
          prisma.studentScholarship.findMany({
            where: { studentId: student.id, schoolId, isActive: true },
            orderBy: { createdAt: "desc" },
            select: {
              id: true, name: true, discountType: true, discountValue: true,
              originalFee: true, benefitAmount: true, finalFee: true, status: true,
              validFrom: true, validUntil: true, program: { select: { name: true, scholarshipType: true } },
            },
          }), [] as any[]),

        safe("available programs", () =>
          prisma.scholarshipProgram.findMany({
            where: {
              schoolId, status: "ACTIVE",
              OR: [{ applicableClasses: { has: student.classId } }, { applicableClasses: { isEmpty: true } }],
            },
            select: {
              id: true, name: true, description: true, scholarshipType: true,
              discountType: true, discountValue: true, maxBenefitAmount: true,
              minPercentage: true, validFrom: true, validUntil: true, totalSeats: true, filledSeats: true,
            },
          }), [] as any[]),
      ]);

      return reply.send({ success: true, data: { myScholarships, availablePrograms } });
    }
  );

  // ── GET /student/fees/discounts ───────────────────────────────
  app.get("/student/fees/discounts",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const student = await getStudentContext(userId, schoolId);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const discounts = await safe("discounts", () =>
        prisma.feeDiscount.findMany({
          where: { studentId: student.id, schoolId, isActive: true },
          orderBy: { createdAt: "desc" },
          select: {
            id: true, name: true, discountType: true, category: true, value: true,
            applicableHeads: true, remarks: true, approvedAt: true,
          },
        }), [] as any[]);

      return reply.send({
        success: true,
        data: {
          discounts: discounts.map((d: any) => ({ ...d, isApproved: !!d.approvedAt })),
        },
      });
    }
  );
}