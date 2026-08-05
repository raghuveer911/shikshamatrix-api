import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";
import bcrypt from "bcryptjs";

export async function adminStudentAdmissionRoutes(app: FastifyInstance) {

  // ── GET /admin/admissions/meta ────────────────────────────
  app.get("/admin/admissions/meta",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const [currentYear, classes, lastStudent] = await Promise.all([
        prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } }),
        prisma.class.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          select: {
            id: true, name: true, classNumber: true, section: true,
            academicYear: true, capacity: true,
            _count: { select: { students: true } },
          },
        }),
        prisma.student.findFirst({
          where: { schoolId },
          orderBy: { id: "desc" },
          select: { admissionNumber: true },
        }),
      ]);

      const year = new Date().getFullYear();
      const lastNum = lastStudent?.admissionNumber
        ? parseInt(lastStudent.admissionNumber.replace(/\D/g, "").slice(-5)) || 0
        : 0;
      const nextAdmissionNumber = `ADM-${year}-${String(lastNum + 1).padStart(5, "0")}`;

      return reply.send({
        success: true,
        data: {
          currentSession: currentYear?.name ?? `${year}-${year + 1}`,
          classes,
          nextAdmissionNumber,
        },
      });
    }
  );

  // ── GET /admin/admissions/roll-numbers ─────────────────────
  // Powers the roll-number picker on the admission form — shows what's
  // already taken in this class so nobody has to guess-and-fail.
  app.get("/admin/admissions/roll-numbers",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { classId } = request.query as { classId?: string };
      if (!classId) return reply.status(400).send({ success: false, message: "classId is required." });

      const students = await prisma.student.findMany({
        where: { schoolId, classId: parseInt(classId) },
        select: { rollNumber: true, user: { select: { name: true } } },
        orderBy: { rollNumber: "asc" },
      });

      const taken = students.map(s => ({ rollNumber: s.rollNumber, studentName: s.user.name }));
      const takenNumeric = new Set(students.map(s => parseInt(s.rollNumber)).filter(n => !isNaN(n)));
      let nextAvailable = 1;
      while (takenNumeric.has(nextAvailable)) nextAvailable++;

      return reply.send({ success: true, data: { taken, nextAvailable: String(nextAvailable) } });
    }
  );

  // ── POST /admin/admissions/check-duplicate ────────────────
  app.post("/admin/admissions/check-duplicate",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as {
        aadhaar?: string; admissionNumber?: string; phone?: string;
      };

      const checks: { field: string; exists: boolean }[] = [];

      if (body.aadhaar) {
        const exists = await prisma.student.findFirst({
          where: { schoolId, aadhaarNumber: body.aadhaar } as any,
        });
        checks.push({ field: "Aadhaar", exists: !!exists });
      }
      if (body.admissionNumber) {
        const exists = await prisma.student.findFirst({
          where: { schoolId, admissionNumber: body.admissionNumber },
        });
        checks.push({ field: "Admission Number", exists: !!exists });
      }
      if (body.phone) {
        const exists = await prisma.user.findFirst({
          where: { phone: body.phone, schoolId },
        });
        checks.push({ field: "Phone", exists: !!exists });
      }

      const duplicates = checks.filter(c => c.exists);
      return reply.send({
        success: true,
        data: { hasDuplicate: duplicates.length > 0, duplicates },
      });
    }
  );

  // ── POST /admin/admissions ────────────────────────────────
  app.post("/admin/admissions",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as any;

      // ── Required field validation ─────────────────────────
      if (!body.academic?.admissionNumber || !body.academic?.classId || !body.student?.firstName) {
        return reply.status(400).send({
          success: false,
          message: "Required fields missing: admission number, class, student first name.",
        });
      }

      // ── Credential validation ─────────────────────────────
      const creds = body.credentials as {
        student: { phone: string; email?: string | null; password: string };
        parent:  { phone: string; email?: string | null; password: string; relation: string; name: string } | null;
      } | undefined;

      if (!creds?.student?.phone || !creds?.student?.password) {
        return reply.status(400).send({
          success: false,
          message: "Student login credentials (phone + password) are required.",
        });
      }

      // ── Duplicate checks ─────────────────────────────────
      const rollNumber = body.academic.rollNumber?.trim();

const [dupAdm, dupStudentPhone, dupRoll] = await Promise.all([
  prisma.student.findFirst({
    where: {
      schoolId,
      admissionNumber: body.academic.admissionNumber,
    },
  }),

  prisma.user.findFirst({
    where: {
      schoolId,
      phone: creds.student.phone,
    },
  }),

  rollNumber
    ? prisma.student.findFirst({
        where: {
          schoolId,
          classId: parseInt(body.academic.classId),
          rollNumber,
        },
      })
    : Promise.resolve(null),
]);

      if (dupAdm) {
        return reply.status(409).send({
          success: false,
          message: `Admission number ${body.academic.admissionNumber} already exists.`,
        });
      }
      if (dupStudentPhone) {
        return reply.status(409).send({
          success: false,
          message: `Phone ${creds.student.phone} is already registered as a student.`,
        });
      }
      if (dupRoll) {
  return reply.status(409).send({
    success: false,
    message: `Roll Number ${body.academic.rollNumber} already exists in this class.`,
  });
}

      const studentName = [
        body.student.firstName,
        body.student.middleName,
        body.student.lastName,
      ].filter(Boolean).join(" ");

      const isDraft = body.isDraft ?? false;

      let result;
      try {
        result = await prisma.$transaction(async (tx) => {

        // 1. Create Student User with provided credentials
        const studentPasswordHash = await bcrypt.hash(creds.student.password, 10);
        const studentUser = await tx.user.create({
          data: {
            schoolId,
            name:         studentName,
            phone:        creds.student.phone,
            email:        creds.student.email ?? null,
            passwordHash: studentPasswordHash,
            role:         "STUDENT",
            gender:       body.student.gender ?? null,
            avatarUrl:    body.student.photoUrl ?? null,
            isActive:     !isDraft,
          },
        });
      
        // 2. Create Student record
        const student = await tx.student.create({
          data: {
            schoolId,
            userId:          studentUser.id,
            classId:         parseInt(body.academic.classId),
            rollNumber:      body.academic.rollNumber ?? null,
            admissionNumber: body.academic.admissionNumber,
            dateOfBirth:     body.student.dateOfBirth ? new Date(body.student.dateOfBirth) : null,
            bloodGroup:      body.student.bloodGroup ?? null,
            address:         body.parent?.currentAddress ?? null,
            admissionDate:   body.academic.admissionDate
              ? new Date(body.academic.admissionDate)
              : new Date(),
            isActive: !isDraft,
            // Extended academic fields
            ...(body.academic.admissionSource    && { admissionSource:    body.academic.admissionSource }),
            ...(body.academic.houseAssignment    && { houseAssignment:    body.academic.houseAssignment }),
            ...(body.academic.openingDueBalance  && { openingDueBalance:  parseFloat(body.academic.openingDueBalance) }),
            ...(body.academic.previousSchool     && { previousSchool:     body.academic.previousSchool }),
            ...(body.academic.previousBoard      && { previousBoard:      body.academic.previousBoard }),
            ...(body.academic.previousTcNumber   && { previousTcNumber:   body.academic.previousTcNumber }),
            ...(body.academic.previousClass      && { previousClass:      body.academic.previousClass }),
            // Student personal
            ...(body.student.firstName     && { firstName:     body.student.firstName }),
            ...(body.student.middleName    && { middleName:    body.student.middleName }),
            ...(body.student.lastName      && { lastName:      body.student.lastName }),
            ...(body.student.category      && { category:      body.student.category }),
            ...(body.student.religion      && { religion:      body.student.religion }),
            ...(body.student.aadhaarNumber && { aadhaarNumber: body.student.aadhaarNumber }),
            ...(body.student.motherTongue  && { motherTongue:  body.student.motherTongue }),
            ...(body.student.nationality   && { nationality:   body.student.nationality }),
            ...(body.student.placeOfBirth  && { placeOfBirth:  body.student.placeOfBirth }),
            ...(body.student.caste         && { caste:         body.student.caste }),
            ...(body.student.subCaste      && { subCaste:      body.student.subCaste }),
            ...(body.student.isBPL !== undefined && { isBPL:   body.student.isBPL }),
            ...(body.student.isRTE !== undefined && { isRTE:   body.student.isRTE }),
            ...(body.student.photoUrl      && { photoUrl:      body.student.photoUrl }),
            // Health (flat on student model)
            ...(body.health?.height              && { height:              parseFloat(body.health.height) }),
            ...(body.health?.weight              && { weight:              parseFloat(body.health.weight) }),
            ...(body.health?.medicalHistory      && { medicalHistory:      body.health.medicalHistory }),
            ...(body.health?.allergies           && { allergies:           body.health.allergies }),
            ...(body.health?.currentMedication   && { currentMedication:   body.health.currentMedication }),
            ...(body.health?.doctorContact       && { doctorContact:       body.health.doctorContact }),
            ...(body.health?.disabilityInfo      && { disabilityInfo:      body.health.disabilityInfo }),
            // Bank
            ...(body.bank?.bankName          && { bankName:          body.bank.bankName }),
            ...(body.bank?.bankAccountHolder && { bankAccountHolder: body.bank.bankAccountHolder }),
            ...(body.bank?.bankAccountNumber && { bankAccountNumber: body.bank.bankAccountNumber }),
            ...(body.bank?.bankIfsc          && { bankIfsc:          body.bank.bankIfsc }),
            ...(body.bank?.scholarshipType   && { scholarshipType:   body.bank.scholarshipType }),
            ...(body.bank?.scholarshipAmount && { scholarshipAmount: parseFloat(body.bank.scholarshipAmount) }),
            isDraft,
          } as any,
        });

        // 3. Create ParentDetail record (flat info table)
        if (body.parent) {
          await tx.parentDetail.create({
            data: {
              schoolId,
              studentId:           student.id,
              fatherName:          body.parent.fatherName          ?? null,
              fatherPhone:         body.parent.fatherPhone         ?? null,
              fatherOccupation:    body.parent.fatherOccupation    ?? null,
              fatherQualification: body.parent.fatherQualification ?? null,
              fatherAadhaar:       body.parent.fatherAadhaar       ?? null,
              fatherIncome:        body.parent.fatherIncome
                ? parseFloat(body.parent.fatherIncome) : null,
              motherName:          body.parent.motherName          ?? null,
              motherPhone:         body.parent.motherPhone         ?? null,
              motherOccupation:    body.parent.motherOccupation    ?? null,
              motherQualification: body.parent.motherQualification ?? null,
              motherAadhaar:       body.parent.motherAadhaar       ?? null,
              guardianName:        body.parent.guardianName        ?? null,
              guardianRelation:    body.parent.guardianRelation    ?? null,
              guardianPhone:       body.parent.guardianPhone       ?? null,
              primaryGuardian:     body.parent.primaryGuardian     ?? "Father",
              emergencyContact:    body.parent.emergencyContact    ?? null,
              emergencyPhone:      body.parent.emergencyPhone      ?? null,
              emergencyRelation:   body.parent.emergencyRelation   ?? null,
              currentAddress:      body.parent.currentAddress      ?? null,
              permanentAddress:    body.parent.sameAddress
                ? body.parent.currentAddress
                : (body.parent.permanentAddress ?? null),
              sameAddress:         body.parent.sameAddress ?? false,
              whatsappNumber:      body.parent.whatsappNumber      ?? null,
              commPreference:      body.parent.commPreference      ?? "SMS",
            },
          });
        }

        // 4. Create PRIMARY Parent User (from credentials) + ParentStudent link
        let primaryParentUserId: number | null = null;

        if (creds?.parent?.phone && creds.parent.password) {
          // Existing parent? (sibling scenario — same phone already registered)
          const existingPrimary = await tx.user.findFirst({
            where: { phone: creds.parent.phone, schoolId },
          });

          let primaryParentUser;
          if (existingPrimary) {
            // Reuse existing parent account
            primaryParentUser = existingPrimary;
          } else {
            const parentHash = await bcrypt.hash(creds.parent.password, 10);
            primaryParentUser = await tx.user.create({
              data: {
                schoolId,
                name:         creds.parent.name || body.parent?.fatherName || "Parent",
                phone:        creds.parent.phone,
                email:        creds.parent.email ?? null,
                passwordHash: parentHash,
                role:         "PARENT",
                isActive:     true,
              },
            });
          }

          primaryParentUserId = primaryParentUser.id;

          // Link parent ↔ student (upsert handles sibling case)
          await tx.parentStudent.upsert({
            where: {
              parentId_studentId: {
                parentId:  primaryParentUser.id,
                studentId: studentUser.id,
              },
            },
            create: {
              parentId:  primaryParentUser.id,
              studentId: studentUser.id,
              relation:  creds.parent.relation?.toLowerCase() ?? "parent",
            },
            update: {}, // already linked — don't overwrite
          });
        }

        // 5. Also create MOTHER user if she has a different phone (secondary account)
        const motherPhone = body.parent?.motherPhone;
        const fatherPhone = body.parent?.fatherPhone;
        const primaryPhone = creds?.parent?.phone;

        if (
          motherPhone &&
          motherPhone !== primaryPhone &&
          motherPhone !== fatherPhone
        ) {
          const existingMother = await tx.user.findFirst({
            where: { phone: motherPhone, schoolId },
          });

          let motherUser;
          if (existingMother) {
            motherUser = existingMother;
          } else {
            // Default mother password = admission number (alphanumeric)
            const motherPwd  = body.academic.admissionNumber.replace(/[^a-zA-Z0-9]/g, "");
            const motherHash = await bcrypt.hash(motherPwd, 10);
            motherUser = await tx.user.create({
              data: {
                schoolId,
                name:         body.parent?.motherName ?? "Mother",
                phone:        motherPhone,
                email:        null,
                passwordHash: motherHash,
                role:         "PARENT",
                isActive:     true,
              },
            });
          }

          await tx.parentStudent.upsert({
            where: {
              parentId_studentId: {
                parentId:  motherUser.id,
                studentId: studentUser.id,
              },
            },
            create: {
              parentId:  motherUser.id,
              studentId: studentUser.id,
              relation:  "mother",
            },
            update: {},
          });
        }

        // 6. Admission Documents
        if (body.documents?.length) {
          await tx.admissionDocument.createMany({
            data: (body.documents as any[]).map((d) => ({
              schoolId,
              studentId:    student.id,
              documentName: d.documentName,
              fileUrl:      d.fileUrl   ?? null,
              fileName:     d.fileName  ?? null,
              fileType:     d.fileType  ?? null,
              status:       d.fileUrl ? "UPLOADED" : "PENDING",
            })),
          });
        }

        return {
          studentId:       student.id,
          studentUserId:   studentUser.id,
          parentUserId:    primaryParentUserId,
          admissionNumber: student.admissionNumber,
        };
        });
      } catch (err: any) {
        // P2002 = unique constraint violation. Two admissions submitted
        // at nearly the same moment can both pass the earlier duplicate
        // check before either has committed — this is the real, final
        // safety net, so the person always gets a clear message instead
        // of a raw database error.
        if (err?.code === "P2002") {
          const fields: string[] = err?.meta?.target ?? [];
          if (fields.includes("rollNumber")) {
            return reply.status(409).send({
              success: false,
              message: `Roll Number ${body.academic.rollNumber} was just taken in this class — please choose another.`,
              field: "rollNumber",
            });
          }
          if (fields.includes("admissionNumber")) {
            return reply.status(409).send({
              success: false,
              message: `Admission number ${body.academic.admissionNumber} was just taken — please refresh and try again.`,
              field: "admissionNumber",
            });
          }
          if (fields.includes("phone")) {
            return reply.status(409).send({
              success: false,
              message: "This phone number was just registered by someone else — please use a different number.",
              field: "phone",
            });
          }
          return reply.status(409).send({
            success: false,
            message: "This record conflicts with an existing one — please review and try again.",
          });
        }

        request.log.error({ err }, "Admission creation failed");
        return reply.status(500).send({
          success: false,
          message: "Something went wrong while saving the admission. Please try again, and contact support if it keeps happening.",
        });
      }

      return reply.status(201).send({
        success: true,
        message: isDraft
          ? "Admission draft saved."
          : `Student "${studentName}" admitted successfully.`,
        data: {
          studentId:       result.studentId,
          studentUserId:   result.studentUserId,
          parentUserId:    result.parentUserId,
          admissionNumber: result.admissionNumber,
          // Echo back resolved credentials for the success modal
          credentials: {
            student: {
              phone:    creds.student.phone,
              password: creds.student.password,
            },
            parent: creds?.parent?.phone ? {
              phone:    creds.parent.phone,
              password: creds.parent.password,
            } : null,
          },
        },
      });
    }
  );

  // ── GET /admin/admissions ─────────────────────────────────
  app.get("/admin/admissions",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const q = request.query as {
        search?: string; classId?: string; session?: string;
        status?: string; page?: string; isDraft?: string;
      };

      const page  = parseInt(q.page ?? "1");
      const limit = 15;

      const where: any = {
        schoolId,
        ...(q.classId ? { classId: parseInt(q.classId) } : {}),
        ...(q.isDraft === "true"  ? { isDraft: true  } : {}),
        ...(q.isDraft === "false" ? { isDraft: false } : {}),
        ...(q.search ? {
          OR: [
            { user:            { name:            { contains: q.search, mode: "insensitive" } } },
            { admissionNumber: { contains: q.search, mode: "insensitive" } },
            { rollNumber:      { contains: q.search, mode: "insensitive" } },
          ],
        } : {}),
      };

      const [students, total] = await Promise.all([
        prisma.student.findMany({
          where,
          skip:    (page - 1) * limit,
          take:    limit,
          orderBy: { id: "desc" },
          include: {
            user:  { select: { id: true, name: true, phone: true, email: true, gender: true, avatarUrl: true } },
            class: { select: { id: true, name: true, classNumber: true, section: true } },
            parentDetail: {
              select: { fatherName: true, fatherPhone: true, motherName: true, motherPhone: true },
            },
            admissionDocuments: { select: { id: true, documentName: true, status: true } },
          },
        }),
        prisma.student.count({ where }),
      ]);

      return reply.send({
        success: true,
        data: { students, total, page, totalPages: Math.ceil(total / limit) },
      });
    }
  );

  // ── GET /admin/admissions/:id ─────────────────────────────
  app.get("/admin/admissions/:id",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const student = await prisma.student.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          user:               true,
          class:              true,
          parentDetail:       true,
          admissionDocuments: true,
          // linked parent accounts
          parentStudents: {
            include: {
              parent: {
                select: { id: true, name: true, phone: true, email: true, role: true },
              },
            },
          },
        },
      });

      if (!student) {
        return reply.status(404).send({ success: false, message: "Student not found." });
      }
      return reply.send({ success: true, data: { student } });
    }
  );

  // ── GET /admin/admissions/:id/credentials ────────────────
  // Returns phone/email only — passwords are never retrievable
  app.get("/admin/admissions/:id/credentials",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const student = await prisma.student.findFirst({
        where: { id: parseInt(id), schoolId },
        select: {
          admissionNumber: true,
          user: { select: { name: true, phone: true, email: true } },
          parentStudents: {
            include: {
              parent: { select: { name: true, phone: true, email: true } },
            },
          },
        },
      });

      if (!student) {
        return reply.status(404).send({ success: false, message: "Student not found." });
      }

      return reply.send({
        success: true,
        data: {
          admissionNumber: student.admissionNumber,
          student: {
            name:  student.user.name,
            phone: student.user.phone,
            email: student.user.email,
          },
          parents: student.parentStudents.map((ps: any) => ({
            name:     ps.parent.name,
            phone:    ps.parent.phone,
            email:    ps.parent.email,
            relation: ps.relation,
          })),
          note: "Passwords cannot be retrieved. Use 'Reset Password' from student profile if needed.",
        },
      });
    }
  );

  // ── PUT /admin/admissions/:id ─────────────────────────────
  app.put("/admin/admissions/:id",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as any;

      const student = await prisma.student.findFirst({
        where: { id: parseInt(id), schoolId },
      });
      if (!student) {
        return reply.status(404).send({ success: false, message: "Student not found." });
      }

      await prisma.$transaction(async (tx) => {
        // Update User name / gender / avatar
        if (body.student) {
          const parts = [body.student.firstName, body.student.middleName, body.student.lastName];
          const name  = parts.filter(Boolean).join(" ");
          await tx.user.update({
            where: { id: student.userId },
            data: {
              ...(name && { name }),
              ...(body.student.gender   && { gender:    body.student.gender }),
              ...(body.student.photoUrl && { avatarUrl: body.student.photoUrl }),
              ...(body.student.email    && { email:     body.student.email }),
            },
          });
        }

        // Update Student record
        await tx.student.update({
          where: { id: parseInt(id) },
          data:  {
            ...body.academic,
            ...body.student,
            ...body.health,
            ...body.bank,
            ...(body.health?.height && { height: parseFloat(body.health.height) }),
            ...(body.health?.weight && { weight: parseFloat(body.health.weight) }),
          } as any,
        });

        // Upsert ParentDetail
        if (body.parent) {
          await tx.parentDetail.upsert({
            where:  { studentId: parseInt(id) },
            create: { schoolId, studentId: parseInt(id), ...body.parent },
            update: body.parent,
          });
        }
      });

      return reply.send({ success: true, message: "Admission updated." });
    }
  );

  // ── PATCH /admin/admissions/:id/publish ──────────────────
  app.patch("/admin/admissions/:id/publish",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const student = await prisma.student.findFirst({
        where: { id: parseInt(id), schoolId },
      });
      if (!student) {
        return reply.status(404).send({ success: false, message: "Not found." });
      }

      await prisma.$transaction([
        prisma.student.update({
          where: { id: parseInt(id) },
          data:  { isActive: true, isDraft: false } as any,
        }),
        prisma.user.update({
          where: { id: student.userId },
          data:  { isActive: true },
        }),
      ]);

      return reply.send({ success: true, message: "Student admission confirmed." });
    }
  );

  // ── PATCH /admin/admissions/:id/reset-password ───────────
  // Reset student OR parent password
  app.patch("/admin/admissions/:id/reset-password",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const { role, newPassword } = request.body as {
        role: "student" | "parent"; newPassword: string;
      };

      if (!newPassword || newPassword.length < 4) {
        return reply.status(400).send({ success: false, message: "Password too short." });
      }

      const student = await prisma.student.findFirst({
        where: { id: parseInt(id), schoolId },
        select: { userId: true },
      });
      if (!student) {
        return reply.status(404).send({ success: false, message: "Not found." });
      }

      const hash = await bcrypt.hash(newPassword, 10);

      if (role === "student") {
        await prisma.user.update({
          where: { id: student.userId },
          data:  { passwordHash: hash },
        });
      } else {
        // ParentStudent.studentId references the student's USER id, not Student.id
        const links = await prisma.parentStudent.findMany({
          where: { studentId: student.userId },
          select: { parentId: true },
        });
        const parentIds = links.map((l) => l.parentId);
        if (parentIds.length === 0) {
          return reply.status(400).send({ success: false, message: "This student has no linked parent account." });
        }
        await prisma.user.updateMany({
          where: { id: { in: parentIds } },
          data:  { passwordHash: hash },
        });
      }

      return reply.send({ success: true, message: `${role} password reset successfully.` });
    }
  );

  // ── POST /admin/admissions/:id/documents ─────────────────
  app.post("/admin/admissions/:id/documents",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as {
        documentName: string; fileUrl?: string;
        fileName?: string; fileType?: string;
      };

      const doc = await prisma.admissionDocument.create({
        data: {
          schoolId,
          studentId:    parseInt(id),
          documentName: body.documentName,
          fileUrl:      body.fileUrl  ?? null,
          fileName:     body.fileName ?? null,
          fileType:     body.fileType ?? null,
          status:       body.fileUrl ? "UPLOADED" : "PENDING",
        },
      });

      return reply.status(201).send({ success: true, data: { document: doc } });
    }
  );

  // ── DELETE /admin/admissions/:studentId/documents/:docId ─
  app.delete("/admin/admissions/:studentId/documents/:docId",
    { preHandler: [authenticate, requireCapability('students.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { docId } = request.params as { studentId: string; docId: string };

      await prisma.admissionDocument.deleteMany({
        where: { id: parseInt(docId), schoolId },
      });
      return reply.send({ success: true, message: "Document deleted." });
    }
  );
}