// apps/api/src/routes/parent/more.ts
//
// FULL REWRITE — based on confirmed models only.
//   - Library: LibIssue/LibBookCopy/LibBook/LibFine (all confirmed)
//   - Hostel: added roommates (same-room active allocations) — rest
//     of the original hostel route was already correct against the
//     confirmed Hostel/HostelRoom/RoomType/HostelFloor/HostelBed models
//   - Documents: FIXED — was calling prisma.studentCertificate
//     (doesn't exist) and prisma.studentIdCard (confirmed: doesn't
//     exist for students at all) — now uses CertIssued, ID card
//     section removed entirely
//   - Leave: FIXED — was calling prisma.studentLeaveApplication
//     (doesn't exist) — now uses the confirmed LeaveRequest model
//     (applicantType: STUDENT, studentUserId)
//   - Transport: returns a clear "coming soon" flag — no student↔route
//     assignment model exists in this schema, confirmed earlier
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { z } from "zod";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[parent/more] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function verifyParentChild(parentUserId: number, studentRecordId: number, schoolId: number): Promise<boolean> {
  const student = await safe("verifyParentChild: student", () =>
    prisma.student.findFirst({ where: { id: studentRecordId, schoolId }, select: { userId: true } }), null);
  if (!student) return false;
  const link = await safe("verifyParentChild: link", () =>
    prisma.parentStudent.findFirst({ where: { parentId: parentUserId, studentId: student.userId } }), null);
  return !!link;
}

const leaveSchema = z.object({
  studentId: z.number(), fromDate: z.string(), toDate: z.string(),
  reason: z.string().min(5), attachmentUrl: z.string().optional(),
});

export async function parentMoreRoutes(app: FastifyInstance) {

  // ══════════════════════════════════════════════════════════
  // LIBRARY
  // ══════════════════════════════════════════════════════════
  app.get("/parent/library",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { studentId } = req.query as { studentId: string };
      const sid = parseInt(studentId);

      if (!(await verifyParentChild(userId, sid, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      const issues = await safe("libIssue.findMany", () =>
        prisma.libIssue.findMany({
          where: { studentId: sid },
          orderBy: { issueDate: "desc" }, take: 20,
          select: {
            id: true, issueDate: true, dueDate: true, returnDate: true, status: true,
            renewalCount: true, returnCondition: true,
            copy: { select: { copyCode: true, book: { select: { title: true, coverUrl: true, author: { select: { name: true } } } } } },
            fine: { select: { totalAmount: true, status: true, overdueDays: true } },
          },
        }), [] as any[]);

      const mapped = issues.map((i: any) => ({
        id: i.id, bookTitle: i.copy?.book?.title ?? "—", author: i.copy?.book?.author?.name ?? "Unknown",
        coverUrl: i.copy?.book?.coverUrl ?? null, copyCode: i.copy?.copyCode,
        issueDate: i.issueDate, dueDate: i.dueDate, returnDate: i.returnDate,
        status: i.status, isOverdue: i.status === "ACTIVE" && new Date(i.dueDate) < new Date(),
        renewalCount: i.renewalCount, returnCondition: i.returnCondition,
        fine: i.fine ? { amount: i.fine.totalAmount, status: i.fine.status, overdueDays: i.fine.overdueDays } : null,
      }));

      return reply.send({
        success: true,
        data: {
          issues: mapped,
          summary: {
            activeCount: mapped.filter((i) => i.status === "ACTIVE").length,
            overdueCount: mapped.filter((i) => i.isOverdue).length,
            totalFineDue: mapped.reduce((s, i) => s + (i.fine && i.fine.status === "PENDING" ? Number(i.fine.amount) : 0), 0),
          },
        },
      });
    }
  );

  // ══════════════════════════════════════════════════════════
  // TRANSPORT — not available yet (no student↔route model)
  // ══════════════════════════════════════════════════════════
  app.get("/parent/transport",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { studentId } = req.query as { studentId: string };
      const sid = parseInt(studentId);

      if (!(await verifyParentChild(userId, sid, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      return reply.send({ success: true, data: { onTransport: false, comingSoon: true } });
    }
  );

  // ══════════════════════════════════════════════════════════
  // LEAVE — uses the confirmed LeaveRequest model
  // ══════════════════════════════════════════════════════════
  app.get("/parent/leaves",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { studentId } = req.query as { studentId: string };
      const sid = parseInt(studentId);

      if (!(await verifyParentChild(userId, sid, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      const student = await safe("student.findFirst (userId)", () =>
        prisma.student.findFirst({ where: { id: sid, schoolId }, select: { userId: true } }), null);
      if (!student) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      const leaves = await safe("leaveRequest.findMany", () =>
        prisma.leaveRequest.findMany({
          where: { schoolId, applicantType: "STUDENT", studentUserId: student.userId },
          orderBy: { createdAt: "desc" }, take: 20,
          select: {
            id: true, fromDate: true, toDate: true, totalDays: true, reason: true,
            attachmentUrl: true, status: true, rejectionNote: true, createdAt: true, approvedAt: true,
          },
        }), [] as any[]);

      return reply.send({ success: true, data: { leaves } });
    }
  );

  app.post("/parent/leaves/apply",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const parsed = leaveSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });
      const { studentId, fromDate, toDate, reason, attachmentUrl } = parsed.data;

      if (!(await verifyParentChild(userId, studentId, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      const student = await safe("student.findFirst (userId)", () =>
        prisma.student.findFirst({ where: { id: studentId, schoolId }, select: { userId: true } }), null);
      if (!student) return reply.status(404).send({ success: false, error: "NOT_FOUND" });

      const from = new Date(fromDate), to = new Date(toDate);
      const totalDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000) + 1);

      await prisma.leaveRequest.create({
        data: {
          schoolId, applicantType: "STUDENT", studentUserId: student.userId,
          fromDate: from, toDate: to, totalDays, reason,
          attachmentUrl: attachmentUrl ?? null, status: "PENDING",
        },
      });

      return reply.status(201).send({ success: true, message: "Leave application submitted for review" });
    }
  );

  // ══════════════════════════════════════════════════════════
  // DOCUMENTS — FIXED: CertIssued instead of non-existent
  // studentCertificate; ID card section removed (confirmed unavailable)
  // ══════════════════════════════════════════════════════════
  app.get("/parent/documents",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { studentId } = req.query as { studentId: string };
      const sid = parseInt(studentId);

      if (!(await verifyParentChild(userId, sid, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      const student = await safe("student.findFirst", () =>
        prisma.student.findFirst({ where: { id: sid, schoolId }, select: { admissionNumber: true, user: { select: { name: true } } } }), null);

      const [docs, certificates] = await Promise.all([
        safe("admissionDocument.findMany", () =>
          prisma.admissionDocument.findMany({
            where: { studentId: sid }, orderBy: { id: "desc" },
            select: { id: true, documentName: true, fileUrl: true, fileName: true, status: true, uploadedAt: true },
          }), [] as any[]),

        safe("certIssued.findMany", () =>
          prisma.certIssued.findMany({
            where: { studentId: sid, status: "VALID" },
            orderBy: { issuedDate: "desc" },
            select: { id: true, certType: true, certNumber: true, category: true, title: true, issuedDate: true, pdfUrl: true },
          }), [] as any[]),
      ]);

      return reply.send({
        success: true,
        data: {
          student: { name: student?.user?.name, admissionNo: student?.admissionNumber },
          documents: docs, certificates,
        },
      });
    }
  );

  // ══════════════════════════════════════════════════════════
  // HOSTEL — added roommates (rest already matched confirmed models)
  // ══════════════════════════════════════════════════════════
  app.get("/parent/hostel",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const { studentId } = req.query as { studentId: string };
      const sid = parseInt(studentId);

      if (!(await verifyParentChild(userId, sid, schoolId)))
        return reply.status(403).send({ success: false, error: "NOT_LINKED" });

      const allocation = await safe("hostelAllocation.findFirst", () =>
        prisma.hostelAllocation.findFirst({
          where: { studentId: sid, schoolId, status: "ACTIVE" },
          select: {
            id: true, allocationDate: true, academicYear: true, roomId: true, bedId: true,
            hostel: {
              select: {
                name: true, hostelType: true, phone: true, facilities: true,
                warden: { select: { user: { select: { name: true, phone: true } } } },
              },
            },
            room: {
              select: {
                roomNumber: true,
                roomType: { select: { name: true, amenities: true, monthlyFee: true } },
                floor: { select: { floorName: true } },
              },
            },
            bed: { select: { bedCode: true } },
          },
        }), null);

      if (!allocation) return reply.send({ success: true, data: { onHostel: false } });

      const roommates = await safe("roommates lookup", () =>
        prisma.hostelAllocation.findMany({
          where: { roomId: allocation.roomId, status: "ACTIVE", studentId: { not: sid } },
          select: {
            student: { select: { rollNumber: true, user: { select: { name: true } } } },
            bed: { select: { bedCode: true } },
          },
        }), [] as any[]);

      return reply.send({
        success: true,
        data: {
          onHostel: true,
          hostel: {
            name: allocation.hostel.name, type: allocation.hostel.hostelType, phone: allocation.hostel.phone,
            facilities: allocation.hostel.facilities,
            wardenName: allocation.hostel.warden?.user?.name, wardenPhone: allocation.hostel.warden?.user?.phone,
          },
          room: {
            number: allocation.room.roomNumber, type: allocation.room.roomType?.name,
            amenities: allocation.room.roomType?.amenities ?? [], floor: allocation.room.floor?.floorName,
            monthlyFee: allocation.room.roomType?.monthlyFee,
          },
          bedCode: allocation.bed.bedCode,
          allocationDate: allocation.allocationDate, academicYear: allocation.academicYear,
          roommates: roommates.map((r: any) => ({ name: r.student.user.name, rollNumber: r.student.rollNumber, bedCode: r.bed.bedCode })),
        },
      });
    }
  );
}