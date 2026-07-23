import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";
import { hashPassword } from "../../utils/auth.js";
import * as XLSX from "xlsx";

// Canonical class-level sequence — pre-primary levels aren't numeric, so
// any sort involving classNumber must rank against this list rather than
// relying on string/DB ordering (which would put "10" before "2" and
// scatter PN/NUR/LKG/UKG alphabetically).
export const CLASS_LEVEL_ORDER = ["PN", "NUR", "LKG", "UKG", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

// ── Helper: normalize phone ────────────────────────────────
function normalizePhone(phone: string): string {
  let p = String(phone).replace(/\s+/g, "").replace(/-/g, "");
  if (p.startsWith("+91")) p = p.slice(3);
  if (p.startsWith("91") && p.length === 12) p = p.slice(2);
  return p;
}

// ── Helper: format date ────────────────────────────────────
function parseDate(val: any): Date | null {
  if (!val) return null;
  if (val instanceof Date) return val;
  const str = String(val).trim();
  // DD/MM/YYYY or DD-MM-YYYY
  const parts = str.split(/[\/\-]/);
  if (parts.length === 3) {
    const [d, m, y] = parts;
    const date = new Date(`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`);
    if (!isNaN(date.getTime())) return date;
  }
  const date = new Date(str);
  return isNaN(date.getTime()) ? null : date;
}

// ── Helper: DOB → DDMMYYYY, same convention as admission's Step2 ──
function dobToPassword(dob: Date): string {
  const dd = String(dob.getDate()).padStart(2, "0");
  const mm = String(dob.getMonth() + 1).padStart(2, "0");
  const yyyy = dob.getFullYear();
  return `${dd}${mm}${yyyy}`;
}

function normalizeGender(g?: string): "MALE" | "FEMALE" | "OTHER" | null {
  if (!g) return null;
  const v = g.trim().toLowerCase();
  if (v === "male" || v === "m") return "MALE";
  if (v === "female" || v === "f") return "FEMALE";
  return "OTHER";
}

interface ImportRow {
  rollNo: string; name: string; gender?: string; dob?: string; phone?: string;
  email?: string; bloodGroup?: string; category?: string; religion?: string;
  nationality?: string; motherTongue?: string; house?: string; aadhaarNumber?: string;
  currentAddress?: string; permanentAddress?: string;
  previousSchool?: string; previousBoard?: string; previousClass?: string; previousPercent?: string;
  fatherName?: string; fatherPhone?: string; fatherOccupation?: string;
  motherName?: string; motherPhone?: string; motherOccupation?: string;
  guardianName?: string; guardianPhone?: string; guardianRelation?: string;
  emergencyContactName?: string; emergencyContactPhone?: string;
}

export async function adminClassRoutes(app: FastifyInstance) {

  // ── GET /admin/classes ────────────────────────────────────
  app.get(
    "/admin/classes",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const query = request.query as {
        search?: string;
        shift?: string;
        academicYear?: string;
      };

      const where: any = {
        schoolId,
        isActive: true,
      };

      if (query.academicYear) where.academicYear = query.academicYear;
      if (query.shift && query.shift !== "ALL") where.shift = query.shift;
      if (query.search) {
        where.OR = [
          { name: { contains: query.search, mode: "insensitive" } },
          { room: { contains: query.search, mode: "insensitive" } },
        ];
      }

      const classes = await prisma.class.findMany({
        where,
        orderBy: [{ section: "asc" }],
        include: {
          classTeacher: {
            include: {
              user: { select: { name: true, avatarUrl: true } },
            },
          },
          subjects: {
            select: { id: true, name: true, code: true },
          },
          _count: {
            select: { students: true, attendance: true },
          },
        },
      });

      // classNumber includes non-numeric pre-primary levels (PN/NUR/LKG/UKG)
      // alongside "1".."12" — a plain string/DB sort would put "10" before
      // "2" and scatter the pre-primary levels alphabetically, so rank
      // against the real school sequence instead.
      const rank = (n: string) => {
        const idx = CLASS_LEVEL_ORDER.indexOf(n);
        return idx === -1 ? CLASS_LEVEL_ORDER.length : idx;
      };
      classes.sort((a, b) => rank(a.classNumber) - rank(b.classNumber));

      // Get academic years for this school
      const academicYears = await prisma.academicYear.findMany({
        where: { schoolId },
        orderBy: { startDate: "desc" },
        select: { id: true, name: true, isCurrent: true },
      });

      // Group by class number
      const grouped: Record<string, typeof classes> = {};
      for (const cls of classes) {
        const key = cls.classNumber;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(cls);
      }

      return reply.send({
        success: true,
        data: {
          classes,
          grouped,
          academicYears,
          total: classes.length,
        },
      });
    }
  );

  // ── GET /admin/classes/:id ────────────────────────────────
  app.get(
    "/admin/classes/:id",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const cls = await prisma.class.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          classTeacher: {
            include: {
              user: { select: { id: true, name: true, avatarUrl: true } },
            },
          },
          subjects: {
            select: { id: true, name: true, code: true, teacherId: true },
          },
          students: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true, phone: true, email: true,
                  gender: true, avatarUrl: true,
                },
              },
            },
            orderBy: { rollNumber: "asc" },
          },
          _count: { select: { students: true } },
        },
      });

      if (!cls) {
        return reply.status(404).send({
          success: false,
          message: "Class not found.",
        });
      }

      return reply.send({ success: true, data: { class: cls } });
    }
  );

  // ── POST /admin/classes ───────────────────────────────────
  app.post(
    "/admin/classes",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        classNumber: string;
        sections: string[]; // ["A","B","C","D"] or subset
        stream?: string; // "ARTS" | "SCIENCE" | "COMMERCE" — only meaningful for classNumber 11/12
        room?: string;
        shift?: "MORNING" | "AFTERNOON" | "EVENING";
        academicYear: string;
        capacity?: number;
        classTeacherId?: number;
        subjects?: string[]; // subject names
        customFields?: Record<string, string>;
      };

      // Stream only applies to Class 11/12 — ignore it silently for any
      // other class level rather than erroring, since the frontend simply
      // won't show the field for those and a stray value shouldn't block
      // class creation.
      const streamValue = ["11", "12"].includes(body.classNumber) && body.stream ? body.stream : null;

      const created = [];
      const errors = [];

      for (const section of body.sections) {
        const name = `${body.classNumber}-${section}`;

        // Check if already exists
        const existing = await prisma.class.findFirst({
          where: {
            schoolId,
            classNumber: body.classNumber,
            section,
            academicYear: body.academicYear,
            isActive: true,
          },
        });

        if (existing) {
          errors.push(`Class ${name} already exists`);
          continue;
        }

        const cls = await prisma.class.create({
          data: {
            schoolId,
            name,
            classNumber: body.classNumber,
            section,
            stream: streamValue,
            room: body.room ?? null,
            shift: body.shift ?? "MORNING",
            academicYear: body.academicYear,
            capacity: body.capacity ?? 40,
            classTeacherId: body.classTeacherId ?? null,
            isActive: true,
          },
        });

        // Create subjects if provided
        if (body.subjects && body.subjects.length > 0) {
          await prisma.subject.createMany({
            data: body.subjects.map((name) => ({
              schoolId,
              classId: cls.id,
              name,
              code: null,
              teacherId: null,
              isActive: true,
            })),
            skipDuplicates: true,
          });
        }

        created.push(cls);
      }

      return reply.status(201).send({
        success: true,
        message: `${created.length} class(es) created successfully.${errors.length ? ` ${errors.join(", ")}` : ""}`,
        data: { created, errors },
      });
    }
  );

  // ── PUT /admin/classes/:id ────────────────────────────────
  app.put(
    "/admin/classes/:id",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as {
        room?: string;
        shift?: "MORNING" | "AFTERNOON" | "EVENING";
        capacity?: number;
        classTeacherId?: number | null;
        stream?: string | null;
        subjects?: { id?: number; name: string; code?: string; teacherId?: number | null }[];
      };

      const cls = await prisma.class.findFirst({
        where: { id: parseInt(id), schoolId },
      });
      if (!cls) {
        return reply.status(404).send({
          success: false,
          message: "Class not found.",
        });
      }

      // Update class
      const updated = await prisma.class.update({
        where: { id: parseInt(id) },
        data: {
          room: body.room,
          shift: body.shift,
          capacity: body.capacity,
          classTeacherId: body.classTeacherId ?? null,
          ...(body.stream !== undefined ? { stream: ["11", "12"].includes(cls.classNumber) ? body.stream : null } : {}),
        },
      });

      // Update subjects — delete all then recreate
      if (body.subjects !== undefined) {
        await prisma.subject.deleteMany({
          where: { classId: parseInt(id) },
        });
        if (body.subjects.length > 0) {
          await prisma.subject.createMany({
            data: body.subjects.map((s) => ({
              schoolId,
              classId: parseInt(id),
              name: s.name,
              code: s.code ?? null,
              teacherId: s.teacherId ?? null,
              isActive: true,
            })),
          });
        }
      }

      return reply.send({
        success: true,
        message: "Class updated successfully.",
        data: { class: updated },
      });
    }
  );

  // ── DELETE /admin/classes/:id ─────────────────────────────
  app.delete(
    "/admin/classes/:id",
    { preHandler: [authenticate, requireCapability('academics.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const cls = await prisma.class.findFirst({
        where: { id: parseInt(id), schoolId },
        include: { _count: { select: { students: true } } },
      });

      if (!cls) {
        return reply.status(404).send({ success: false, message: "Class not found." });
      }

      if (cls._count.students > 0) {
        return reply.status(400).send({
          success: false,
          message: `Cannot delete class with ${cls._count.students} students. Move students first.`,
        });
      }

      await prisma.class.update({
        where: { id: parseInt(id) },
        data: { isActive: false },
      });

      return reply.send({
        success: true,
        message: `Class ${cls.name} deleted successfully.`,
      });
    }
  );

  // ══════════════════════════════════════════════════════════
  // ── GET /admin/students/import-template ──────────────────
  // ══════════════════════════════════════════════════════════
  app.get(
    "/admin/students/import-template",
    { preHandler: [authenticate, requireCapability('students.bulkTools')] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const wb = XLSX.utils.book_new();

      const headers = [
        [
          "Roll No*", "Student Name*", "Gender*", "Date of Birth*", "Student Phone (optional)",
          "Email", "Blood Group", "Category", "Religion", "Nationality", "Mother Tongue", "House", "Aadhaar Number",
          "Current Address", "Permanent Address",
          "Previous School", "Previous Board", "Previous Class", "Previous %",
          "Father Name", "Father Phone", "Father Occupation",
          "Mother Name", "Mother Phone", "Mother Occupation",
          "Guardian Name", "Guardian Phone", "Guardian Relation",
          "Emergency Contact Name", "Emergency Contact Phone",
        ],
        [
          "1", "Aarav Sharma", "Male", "15/01/2010", "",
          "aarav@gmail.com", "O+", "General", "Hindu", "Indian", "Hindi", "Red House", "123456789012",
          "123 MG Road, City", "123 MG Road, City",
          "", "", "", "",
          "Raj Sharma", "9876543211", "Business",
          "Sunita Sharma", "9876543212", "Homemaker",
          "", "", "",
          "Raj Sharma", "9876543211",
        ],
      ];

      const ws = XLSX.utils.aoa_to_sheet(headers);
      ws["!cols"] = headers[0].map(() => ({ wch: 16 }));
      XLSX.utils.book_append_sheet(wb, ws, "Students");

      const instructions = [
        ["FIELD", "REQUIRED", "FORMAT", "NOTES"],
        ["Roll No", "YES", "Number/Text", "Must be unique within the selected class"],
        ["Student Name", "YES", "Text", "Full name of student"],
        ["Gender", "YES", "Male/Female/Other", ""],
        ["Date of Birth", "YES", "DD/MM/YYYY", "e.g. 15/01/2010 — also becomes the student's login password (DDMMYYYY, no slashes)"],
        ["Student Phone", "NO", "10 digits", "Only if the student has their own number (common for older students) — becomes their login identifier"],
        ["Father/Mother/Guardian Phone", "NO", "10 digits", "Also becomes that person's login password. If a phone matches an existing parent (sibling already enrolled), that account is reused instead of duplicated."],
      ];
      const wsInstr = XLSX.utils.aoa_to_sheet(instructions);
      wsInstr["!cols"] = [{ wch: 22 }, { wch: 10 }, { wch: 18 }, { wch: 60 }];
      XLSX.utils.book_append_sheet(wb, wsInstr, "Instructions");

      const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", "attachment; filename=student-import-template.xlsx")
        .send(buffer);
    }
  );

  // ══════════════════════════════════════════════════════════
  // ── POST /admin/students/import ───────────────────────────
  // ══════════════════════════════════════════════════════════
  app.post(
    "/admin/students/import",
    { preHandler: [authenticate, requireCapability('students.bulkTools')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as { classId: number; rows: ImportRow[] };

      if (!body.classId || !body.rows?.length) {
        return reply.status(400).send({
          success: false,
          message: "classId and rows are required.",
        });
      }

      const cls = await prisma.class.findFirst({
        where: { id: body.classId, schoolId, isActive: true },
      });
      if (!cls) {
        return reply.status(404).send({
          success: false,
          message: "Class not found.",
        });
      }

      const results = {
        success: [] as number[],
        errors: [] as { row: number; reason: string }[],
        skipped: [] as { row: number; reason: string }[],
        credentials: [] as { row: number; name: string; loginPhoneOrEmail: string | null; password: string }[],
      };

      for (let i = 0; i < body.rows.length; i++) {
        const row = body.rows[i];
        const rowNum = i + 2; // Excel row (1=header, 2=first data)

        // ── Required field validation ─────────────────────────
        if (!row.name?.trim()) {
          results.errors.push({ row: rowNum, reason: "Student name is required" });
          continue;
        }
        if (!row.rollNo?.trim()) {
          results.errors.push({ row: rowNum, reason: "Roll number is required" });
          continue;
        }
        if (!row.gender?.trim()) {
          results.errors.push({ row: rowNum, reason: "Gender is required" });
          continue;
        }
        const dob = parseDate(row.dob);
        if (!dob) {
          results.errors.push({ row: rowNum, reason: "Valid Date of Birth is required (DD/MM/YYYY)" });
          continue;
        }

        // ── Roll number uniqueness within THIS class ──────────
        const rollExists = await prisma.student.findFirst({
          where: { classId: body.classId, rollNumber: row.rollNo.trim() },
        });
        if (rollExists) {
          results.skipped.push({
            row: rowNum,
            reason: `Roll no ${row.rollNo} already exists in this class`,
          });
          continue;
        }

        // ── Student's own phone/email — OPTIONAL ──────────────
        let studentPhone: string | null = null;
        if (row.phone?.trim()) {
          studentPhone = normalizePhone(row.phone);
          if (!/^\d{10}$/.test(studentPhone)) {
            results.errors.push({ row: rowNum, reason: `Invalid student phone: ${row.phone}` });
            continue;
          }
          const phoneExists = await prisma.user.findFirst({ where: { phone: studentPhone } });
          if (phoneExists) {
            results.skipped.push({ row: rowNum, reason: `Student phone ${studentPhone} already registered` });
            continue;
          }
        }

        let studentEmail: string | null = row.email?.trim().toLowerCase() || null;
        if (studentEmail) {
          const emailExists = await prisma.user.findFirst({ where: { email: studentEmail } });
          if (emailExists) {
            results.skipped.push({ row: rowNum, reason: `Email ${studentEmail} already registered` });
            continue;
          }
        }

        try {
          // Password convention — same as manual admission (Step2):
          // student = DOB as DDMMYYYY, parents = their own phone number.
          const studentPassword = dobToPassword(dob);
          const studentPasswordHash = await hashPassword(studentPassword);

          await prisma.$transaction(async (tx) => {
            // ── 1. Student User ──────────────────────────────
            const user = await tx.user.create({
              data: {
                schoolId,
                name: row.name.trim(),
                phone: studentPhone,
                email: studentEmail,
                passwordHash: studentPasswordHash,
                role: "STUDENT",
                gender: normalizeGender(row.gender),
                isActive: true,
              },
            });

            // ── 2. Student record — full field set ───────────
            // NOTE: `user` must be connected via relation object, not
            // the scalar `userId` — Prisma rejected the scalar form
            // for this 1:1 relation (see earlier error). Capture the
            // return value as `student` — its own `.id` (NOT the
            // User's id) is what ParentDetail.studentId points to.
            const student = await tx.student.create({
              data: {
                user: { connect: { id: user.id } },
                school: { connect: { id: schoolId } },
                ...(body.classId ? { class: { connect: { id: body.classId } } } : {}),
                rollNumber: row.rollNo.trim(),
                admissionNumber: `EXIST-${Date.now()}-${i}`,
                dateOfBirth: dob,
                admissionDate: new Date(),
                bloodGroup: row.bloodGroup?.trim() || null,
                category: row.category?.trim() || null,
                religion: row.religion?.trim() || null,
                nationality: row.nationality?.trim() || null,
                motherTongue: row.motherTongue?.trim() || null,
                houseAssignment: row.house?.trim() || null,
                aadhaarNumber: row.aadhaarNumber?.trim() || null,
                address: row.currentAddress?.trim() || null,
                ...(row.previousSchool && { previousSchool: row.previousSchool.trim() }),
                ...(row.previousBoard && { previousBoard: row.previousBoard.trim() }),
                ...(row.previousClass && { previousClass: row.previousClass.trim() }),
                ...(row.previousPercent && { previousPercent: parseFloat(row.previousPercent) }),
              } as any,
            });

            // ── 3. ParentDetail — descriptive info, always stored ──
            if (row.fatherName || row.motherName || row.guardianName) {
              await tx.parentDetail.create({
                data: {
                  schoolId,
                  studentId: student.id, // Student's OWN id — NOT user.id (different table, different id convention)
                  fatherName: row.fatherName?.trim() || null,
                  fatherPhone: row.fatherPhone ? normalizePhone(row.fatherPhone) : null,
                  fatherOccupation: row.fatherOccupation?.trim() || null,
                  motherName: row.motherName?.trim() || null,
                  motherPhone: row.motherPhone ? normalizePhone(row.motherPhone) : null,
                  motherOccupation: row.motherOccupation?.trim() || null,
                  guardianName: row.guardianName?.trim() || null,
                  guardianPhone: row.guardianPhone ? normalizePhone(row.guardianPhone) : null,
                  guardianRelation: row.guardianRelation?.trim() || null,
                  // Correct field names confirmed via Prisma error —
                  // model has emergencyContact/emergencyPhone, not
                  // emergencyContactName/emergencyContactPhone.
                  emergencyContact: row.emergencyContactName?.trim() || null,
                  emergencyPhone: row.emergencyContactPhone ? normalizePhone(row.emergencyContactPhone) : null,
                  // ParentDetail carries its own address pair too
                  // (separate from Student.address) — fill both from
                  // the same import columns for consistency.
                  currentAddress: row.currentAddress?.trim() || null,
                  permanentAddress: row.permanentAddress?.trim() || null,
                  sameAddress: !!(row.currentAddress && row.permanentAddress &&
                    row.currentAddress.trim() === row.permanentAddress.trim()),
                } as any,
              });
            }

            // ── 4. Father/Mother/Guardian — own phone = own password ──
            // Reuses an existing parent User by phone (sibling already
            // enrolled) instead of creating a duplicate.
            const linkParent = async (name: string | undefined, phone: string | undefined, relation: string) => {
              if (!phone) return;
              const normalized = normalizePhone(phone);
              if (!/^\d{10}$/.test(normalized)) return;

              let parentUser = await tx.user.findFirst({ where: { phone: normalized } });
              if (!parentUser) {
                const parentPasswordHash = await hashPassword(normalized);
                parentUser = await tx.user.create({
                  data: {
                    schoolId,
                    name: name?.trim() || relation,
                    phone: normalized,
                    passwordHash: parentPasswordHash,
                    role: "PARENT",
                    isActive: true,
                  },
                });
                results.credentials.push({
                  row: rowNum, name: parentUser.name,
                  loginPhoneOrEmail: normalized, password: normalized,
                });
              }

              const alreadyLinked = await tx.parentStudent.findFirst({
                where: { parentId: parentUser.id, studentId: user.id },
              });
              if (!alreadyLinked) {
                await tx.parentStudent.create({
                  data: { parentId: parentUser.id, studentId: user.id, relation },
                });
              }
            };

            await linkParent(row.fatherName, row.fatherPhone, "Father");
            await linkParent(row.motherName, row.motherPhone, "Mother");
            if (row.guardianPhone) {
              await linkParent(row.guardianName, row.guardianPhone, row.guardianRelation || "Guardian");
            }
          });

          results.success.push(rowNum);
          results.credentials.unshift({
            row: rowNum, name: row.name.trim(),
            loginPhoneOrEmail: studentPhone ?? studentEmail, password: studentPassword,
          });
        } catch (err: any) {
          console.log(`[students/import] row ${rowNum} failed:`, err?.message ?? err);

          let reason = "Couldn't save this row — please check the data and try again.";
          if (err?.code === "P2002") {
            // Unique constraint violation — err.meta.target tells us which
            // field(s) collided, so we can name the actual problem instead
            // of a generic "database error".
            const target: string[] = err.meta?.target ?? [];
            if (target.includes("rollNumber")) {
              reason = `Roll no ${row.rollNo} already exists in this class.`;
            } else if (target.includes("admissionNumber")) {
              reason = "Admission number already exists — this is auto-generated, please retry.";
            } else if (target.includes("phone")) {
              reason = `Phone number already registered to another user.`;
            } else if (target.includes("email")) {
              reason = `Email already registered to another user.`;
            } else {
              reason = `Duplicate entry (${target.join(", ") || "unknown field"}).`;
            }
          } else if (err?.code === "P2003") {
            // Foreign key violation — e.g. classId doesn't actually exist.
            reason = "Invalid reference — the selected class may have been removed.";
          } else if (err?.code === "P2000") {
            // Value too long for the column.
            reason = "One of the fields is too long — please shorten it and retry.";
          } else if (err?.name === "PrismaClientValidationError") {
            // Missing/extra/wrong-type field in the data we sent to Prisma —
            // a genuine bug on our side, not a data problem, so keep this
            // one generic for the school but detailed in the server log.
            reason = "Couldn't save this row due to a system error. Our team has been notified.";
          }

          results.errors.push({ row: rowNum, reason });
        }
      }

      return reply.send({
        success: true,
        message: `Import complete. ${results.success.length} students added.`,
        data: {
          imported: results.success.length,
          errors: results.errors,
          skipped: results.skipped,
          credentials: results.credentials,
          total: body.rows.length,
        },
      });
    }
  );
}