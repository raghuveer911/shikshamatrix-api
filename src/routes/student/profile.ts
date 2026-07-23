// apps/api/src/routes/student/profile.ts
//
// Personal / Parent / Emergency / Class Details / Hostel — all read
// endpoints from confirmed models (Student, ParentDetail, Class,
// HostelAllocation). Documents reuses the confirmed AdmissionDocument
// pattern already built for Parent.
//
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { appAuth } from "../../middleware/appAuth.js";
import { z } from "zod";

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (err: any) { console.log(`[student/profile] "${label}" failed:`, err?.message ?? err); return fallback; }
}

async function getStudentId(userId: number, schoolId: number): Promise<number | null> {
  const s = await safe("student lookup", () =>
    prisma.student.findFirst({ where: { userId, schoolId, isActive: true }, select: { id: true } }), null);
  return s?.id ?? null;
}

const personalUpdateSchema = z.object({
  studentPhone: z.string().optional(), studentEmail: z.string().email().optional().or(z.literal("")),
});

export async function studentProfileRoutes(app: FastifyInstance) {

  // ── GET /student/profile/personal ─────────────────────────────
  app.get("/student/profile/personal",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const student = await safe("student personal", () =>
        prisma.student.findFirst({
          where: { userId, schoolId, isActive: true },
          select: {
            admissionNumber: true, rollNumber: true, dateOfBirth: true, gender: true, bloodGroup: true,
            firstName: true, middleName: true, lastName: true, category: true, religion: true, caste: true,
            subCaste: true, motherTongue: true, placeOfBirth: true, nationality: true, aadhaarNumber: true,
            isBPL: true, isRTE: true, studentPhone: true, studentEmail: true, photoUrl: true, rfidNumber: true,
            address: true,
            user: { select: { name: true, avatarUrl: true, email: true, phone: true } },
          },
        }), null);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      return reply.send({ success: true, data: { profile: student } });
    }
  );

  // ── PATCH /student/profile/personal — limited self-editable fields ──
  app.patch("/student/profile/personal",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const parsed = personalUpdateSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message });

      await prisma.student.update({ where: { id: sid }, data: parsed.data });
      return reply.send({ success: true, message: "Profile updated" });
    }
  );

  // ── GET /student/profile/parent ───────────────────────────────
  app.get("/student/profile/parent",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const parent = await safe("parent details", () =>
        prisma.parentDetail.findFirst({
          where: { studentId: sid },
          select: {
            fatherName: true, fatherPhone: true, fatherOccupation: true, fatherQualification: true, fatherPhotoUrl: true,
            motherName: true, motherPhone: true, motherOccupation: true, motherQualification: true, motherPhotoUrl: true,
            guardianName: true, guardianRelation: true, guardianPhone: true, guardianOccupation: true, primaryGuardian: true,
            currentAddress: true, permanentAddress: true, sameAddress: true,
            whatsappNumber: true, commPreference: true,
          },
        }), null);

      return reply.send({ success: true, data: { parent } });
    }
  );

  // ── GET /student/profile/emergency ────────────────────────────
  app.get("/student/profile/emergency",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const emergency = await safe("emergency contact", () =>
        prisma.parentDetail.findFirst({
          where: { studentId: sid },
          select: { emergencyContact: true, emergencyPhone: true, emergencyRelation: true, fatherPhone: true, motherPhone: true },
        }), null);

      return reply.send({ success: true, data: { emergency } });
    }
  );

  // ── GET /student/profile/class-details ────────────────────────
  app.get("/student/profile/class-details",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;

      const student = await safe("class details", () =>
        prisma.student.findFirst({
          where: { userId, schoolId, isActive: true },
          select: {
            rollNumber: true, admissionNumber: true,
            class: {
              select: {
                name: true, section: true, academicYear: true,
                classTeacher: { select: { user: { select: { name: true, phone: true } } } },
              },
            },
            school: { select: { name: true } },
          },
        }), null);
      if (!student) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      return reply.send({
        success: true,
        data: {
          classDetails: {
            className: student.class?.name, section: student.class?.section, academicYear: student.class?.academicYear,
            rollNumber: student.rollNumber, admissionNumber: student.admissionNumber,
            schoolName: student.school?.name,
            classTeacherName: student.class?.classTeacher?.user?.name,
            classTeacherPhone: student.class?.classTeacher?.user?.phone,
          },
        },
      });
    }
  );

  // ── GET /student/profile/documents ────────────────────────────
  app.get("/student/profile/documents",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const documents = await safe("documents", () =>
        prisma.admissionDocument.findMany({
          where: { studentId: sid }, orderBy: { id: "desc" },
          select: { id: true, documentName: true, fileUrl: true, fileName: true, status: true, uploadedAt: true },
        }), [] as any[]);

      return reply.send({ success: true, data: { documents } });
    }
  );

  // ── GET /student/profile/hostel ───────────────────────────────
  app.get("/student/profile/hostel",
    { preHandler: appAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId, schoolId } = req as any;
      const sid = await getStudentId(userId, schoolId);
      if (!sid) return reply.status(404).send({ success: false, error: "STUDENT_NOT_FOUND" });

      const allocation = await safe("hostel allocation", () =>
        prisma.hostelAllocation.findFirst({
          where: { studentId: sid, schoolId, status: "ACTIVE" },
          select: {
            id: true, allocationDate: true, academicYear: true, roomId: true,
            hostel: {
              select: {
                name: true, hostelType: true, phone: true, facilities: true,
                warden: { select: { user: { select: { name: true, phone: true } } } },
              },
            },
            room: {
              select: { roomNumber: true, roomType: { select: { name: true, amenities: true, monthlyFee: true } }, floor: { select: { floorName: true } } },
            },
            bed: { select: { bedCode: true } },
          },
        }), null);

      if (!allocation) return reply.send({ success: true, data: { onHostel: false } });

      const roommates = await safe("roommates", () =>
        prisma.hostelAllocation.findMany({
          where: { roomId: allocation.roomId, status: "ACTIVE", studentId: { not: sid } },
          select: { student: { select: { rollNumber: true, user: { select: { name: true } } } }, bed: { select: { bedCode: true } } },
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
          bedCode: allocation.bed.bedCode, allocationDate: allocation.allocationDate, academicYear: allocation.academicYear,
          roommates: roommates.map((r: any) => ({ name: r.student.user.name, rollNumber: r.student.rollNumber, bedCode: r.bed.bedCode })),
        },
      });
    }
  );
}