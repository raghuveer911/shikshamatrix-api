import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

export async function adminStudentsRoutes(app: FastifyInstance) {

  // ── GET /admin/students ───────────────────────────────────
  app.get("/admin/students",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as {
        page?: string; pageSize?: string;
        search?: string; searchBy?: string;
        classId?: string; status?: string; gender?: string;
      };

      const page = Math.max(1, parseInt(q.page ?? "1"));
      const pageSize = parseInt(q.pageSize ?? "20");
      const skip = (page - 1) * pageSize;

      // Build where clause
      const where: any = { schoolId };

      if (q.status === "ACTIVE") where.isActive = true;
      else if (q.status === "INACTIVE") where.isActive = false;

      if (q.classId) where.classId = parseInt(q.classId);

      if (q.gender) where.user = { ...where.user, gender: q.gender };

      if (q.search?.trim()) {
        const s = q.search.trim();
        const by = q.searchBy ?? "name";
        if (by === "name") {
          where.user = { ...where.user, name: { contains: s, mode: "insensitive" } };
        } else if (by === "phone") {
          where.user = { ...where.user, phone: { contains: s } };
        } else if (by === "rollNumber") {
          where.rollNumber = { contains: s, mode: "insensitive" };
        } else if (by === "admissionNumber") {
          where.admissionNumber = { contains: s, mode: "insensitive" };
        } else if (by === "fatherName") {
          // Search via parentDetail
          const parents = await prisma.parentDetail.findMany({
            where: { schoolId, fatherName: { contains: s, mode: "insensitive" } },
            select: { studentId: true },
          });
          where.id = { in: parents.map(p => p.studentId) };
        }
      }

      const [students, total] = await Promise.all([
        prisma.student.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: [{ class: { classNumber: "asc" } }, { rollNumber: "asc" }],
          include: {
            user: {
              select: {
                id: true, name: true, phone: true, email: true,
                gender: true, avatarUrl: true, isActive: true,
              },
            },
            class: {
              select: {
                id: true, name: true, section: true,
                classNumber: true, academicYear: true,
              },
            },
            parentDetail: {
              select: {
                fatherName: true, fatherPhone: true,
                motherName: true, motherPhone: true,
                primaryGuardian: true,
              },
            },
          },
        }),
        prisma.student.count({ where }),
      ]);

      // Transform to match frontend StudentRow format
      // Frontend expects `parents` array — build from parentDetail
      const transformed = students.map(s => ({
        id: s.id,
        rollNumber: s.rollNumber,
        admissionNumber: s.admissionNumber,
        dateOfBirth: s.dateOfBirth?.toISOString() ?? null,
        admissionDate: s.admissionDate.toISOString(),
        user: s.user,
        class: s.class ?? null,
        // Build parents array from parentDetail
        parents: s.parentDetail
          ? [
              ...(s.parentDetail.fatherName ? [{ id: 0, name: s.parentDetail.fatherName, phone: s.parentDetail.fatherPhone, email: null, relation: "father" }] : []),
              ...(s.parentDetail.motherName ? [{ id: 1, name: s.parentDetail.motherName, phone: s.parentDetail.motherPhone, email: null, relation: "mother" }] : []),
            ]
          : [],
      }));

      return reply.send({
        success: true,
        data: {
          students: transformed,
          meta: {
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
          },
        },
      });
    }
  );

  // ── GET /admin/students/:id ───────────────────────────────
  app.get("/admin/students/:id",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const student = await prisma.student.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          user: true,
          class: true,
          parentDetail: true,
          admissionDocuments: true,
        },
      });

      if (!student) return reply.status(404).send({ success: false, message: "Student not found." });

      return reply.send({ success: true, data: { student } });
    }
  );

  // ── PUT /admin/students/:id ───────────────────────────────
  // Updates the student's own fields, their ParentDetail record (upsert —
  // not every student has one yet), and the small set of User fields
  // that are safe to edit here (name/phone/email — not password/role).
  app.put("/admin/students/:id",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const b = request.body as any;
      const studentId = parseInt(id);

      const existing = await prisma.student.findFirst({ where: { id: studentId, schoolId } });
      if (!existing) return reply.status(404).send({ success: false, message: "Student not found." });

      try {
        const student = await prisma.$transaction(async (tx) => {
          if (b.userName || b.userPhone || b.userEmail || b.avatarUrl !== undefined) {
            await tx.user.update({
              where: { id: existing.userId },
              data: {
                ...(b.userName ? { name: b.userName } : {}),
                ...(b.userPhone !== undefined ? { phone: b.userPhone || null } : {}),
                ...(b.userEmail !== undefined ? { email: b.userEmail || null } : {}),
                ...(b.avatarUrl !== undefined ? { avatarUrl: b.avatarUrl || null } : {}),
              },
            });
          }

          const updated = await tx.student.update({
            where: { id: studentId },
            data: {
              classId: b.classId !== undefined ? (b.classId ? Number(b.classId) : null) : undefined,
              rollNumber: b.rollNumber, dateOfBirth: b.dateOfBirth ? new Date(b.dateOfBirth) : undefined,
              bloodGroup: b.bloodGroup, address: b.address,
              houseAssignment: b.houseAssignment,
              previousSchool: b.previousSchool, previousBoard: b.previousBoard,
              previousTcNumber: b.previousTcNumber, previousClass: b.previousClass,
              previousPercent: b.previousPercent !== undefined ? (b.previousPercent === "" ? null : Number(b.previousPercent)) : undefined,
              firstName: b.firstName, middleName: b.middleName, lastName: b.lastName,
              category: b.category, religion: b.religion, caste: b.caste, subCaste: b.subCaste,
              motherTongue: b.motherTongue, placeOfBirth: b.placeOfBirth, nationality: b.nationality,
              aadhaarNumber: b.aadhaarNumber, isBPL: b.isBPL, isRTE: b.isRTE,
              studentPhone: b.studentPhone, studentEmail: b.studentEmail, photoUrl: b.photoUrl, rfidNumber: b.rfidNumber,
              height: b.height !== undefined ? (b.height === "" ? null : Number(b.height)) : undefined,
              weight: b.weight !== undefined ? (b.weight === "" ? null : Number(b.weight)) : undefined,
              medicalHistory: b.medicalHistory, allergies: b.allergies,
              currentMedication: b.currentMedication, doctorContact: b.doctorContact, disabilityInfo: b.disabilityInfo,
              bankName: b.bankName, bankAccountHolder: b.bankAccountHolder,
              bankAccountNumber: b.bankAccountNumber, bankIfsc: b.bankIfsc,
              scholarshipType: b.scholarshipType,
              scholarshipAmount: b.scholarshipAmount !== undefined ? (b.scholarshipAmount === "" ? null : Number(b.scholarshipAmount)) : undefined,
            },
            include: { user: true, class: true, parentDetail: true },
          });

          if (b.parentDetail) {
            const pd = b.parentDetail;
            await tx.parentDetail.upsert({
              where: { studentId },
              create: {
                schoolId, studentId,
                fatherName: pd.fatherName, fatherPhone: pd.fatherPhone, fatherOccupation: pd.fatherOccupation,
                motherName: pd.motherName, motherPhone: pd.motherPhone, motherOccupation: pd.motherOccupation,
                guardianName: pd.guardianName, guardianRelation: pd.guardianRelation, guardianPhone: pd.guardianPhone,
                primaryGuardian: pd.primaryGuardian ?? "Father",
                emergencyContact: pd.emergencyContact, emergencyPhone: pd.emergencyPhone, emergencyRelation: pd.emergencyRelation,
                currentAddress: pd.currentAddress, permanentAddress: pd.permanentAddress,
                whatsappNumber: pd.whatsappNumber, commPreference: pd.commPreference ?? "SMS",
              },
              update: {
                fatherName: pd.fatherName, fatherPhone: pd.fatherPhone, fatherOccupation: pd.fatherOccupation,
                motherName: pd.motherName, motherPhone: pd.motherPhone, motherOccupation: pd.motherOccupation,
                guardianName: pd.guardianName, guardianRelation: pd.guardianRelation, guardianPhone: pd.guardianPhone,
                primaryGuardian: pd.primaryGuardian, emergencyContact: pd.emergencyContact,
                emergencyPhone: pd.emergencyPhone, emergencyRelation: pd.emergencyRelation,
                currentAddress: pd.currentAddress, permanentAddress: pd.permanentAddress,
                whatsappNumber: pd.whatsappNumber, commPreference: pd.commPreference,
              },
            });
          }

          return updated;
        });

        return reply.send({ success: true, message: "Student updated successfully.", data: { student } });
      } catch (err: any) {
        console.error("[students] update failed:", err?.message ?? err);
        return reply.status(500).send({ success: false, message: "Couldn't update the student. Please check the form and try again." });
      }
    }
  );

  // ── PATCH /admin/students/:id/toggle-status ───────────────
  app.patch("/admin/students/:id/toggle-status",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const student = await prisma.student.findFirst({
        where: { id: parseInt(id), schoolId },
        include: { user: true },
      });
      if (!student) return reply.status(404).send({ success: false, message: "Student not found." });

      const newStatus = !student.isActive;
      await prisma.$transaction([
        prisma.student.update({ where: { id: parseInt(id) }, data: { isActive: newStatus } }),
        prisma.user.update({ where: { id: student.userId }, data: { isActive: newStatus } }),
      ]);

      return reply.send({
        success: true,
        message: `Student ${newStatus ? "enabled" : "disabled"} successfully.`,
      });
    }
  );

  // ── DELETE /admin/students/:id ────────────────────────────
  app.delete("/admin/students/:id",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const student = await prisma.student.findFirst({
        where: { id: parseInt(id), schoolId },
      });
      if (!student) return reply.status(404).send({ success: false, message: "Student not found." });

      // Soft delete — mark as deleted
      await prisma.$transaction([
        prisma.student.update({ where: { id: parseInt(id) }, data: { isActive: false } }),
        prisma.user.update({ where: { id: student.userId }, data: { isActive: false, isDeleted: true } }),
      ]);

      return reply.send({ success: true, message: "Student deleted." });
    }
  );
}