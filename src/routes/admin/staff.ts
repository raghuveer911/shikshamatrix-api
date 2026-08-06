import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";

// ── Gender helper ─────────────────────────────────────────
function mapGender(g?: string): "MALE" | "FEMALE" | "OTHER" | null {
  if (!g) return null;
  const u = g.toUpperCase().trim();
  if (u === "MALE" || u === "M") return "MALE";
  if (u === "FEMALE" || u === "F") return "FEMALE";
  if (u === "OTHER") return "OTHER";
  return null;
}

// ── Date parser ───────────────────────────────────────────
function parseDate(val: string): Date | null {
  if (!val) return null;
  const parts = val.split(/[\/\-]/);
  if (parts.length === 3) {
    const [d, m, y] = parts;
    const date = new Date(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`);
    if (!isNaN(date.getTime())) return date;
  }
  const date = new Date(val);
  return isNaN(date.getTime()) ? null : date;
}

/* ── Department / Designation / EmployeeType helpers ──────────
   FIXED: this file used to write `department` and `designation`
   as if they were plain string columns on Staff, and `employmentType`
   as if it matched the EmployeeType enum's values. Neither is true —
   department/designation are separate lookup tables (Staff links to
   them via departmentId/designationId), and the EmployeeType enum is
   TEACHING | NON_TEACHING | TRANSPORT | MANAGEMENT | CONTRACT | PART_TIME,
   not PERMANENT/CONTRACT/PART_TIME/SUBSTITUTE. Every create/update was
   throwing a Prisma "Unknown argument" or invalid-enum error.

   Fix strategy: keep the API contract exactly as the frontend already
   sends/expects it (plain `department` and `designation` name strings,
   `employmentType` as one of the old four labels) — resolve names to
   IDs on write, and flatten IDs back to names on read, entirely inside
   this file. Nothing outside this file needs to change. */

async function resolveDepartmentId(schoolId: number, name?: string | null): Promise<number | null> {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const existing = await prisma.department.findFirst({
    where: { schoolId, name: { equals: trimmed, mode: "insensitive" } },
  });
  if (existing) return existing.id;
  const created = await prisma.department.create({ data: { schoolId, name: trimmed } });
  return created.id;
}

async function resolveDesignationId(
  schoolId: number, name?: string | null, departmentId?: number | null,
): Promise<number | null> {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const existing = await prisma.designation.findFirst({
    where: { schoolId, name: { equals: trimmed, mode: "insensitive" } },
  });
  if (existing) return existing.id;
  const created = await prisma.designation.create({
    data: { schoolId, name: trimmed, departmentId: departmentId ?? null },
  });
  return created.id;
}

/** Old UI offers PERMANENT/CONTRACT/PART_TIME/SUBSTITUTE; the real
 *  EmployeeType enum is TEACHING/NON_TEACHING/TRANSPORT/MANAGEMENT/
 *  CONTRACT/PART_TIME. CONTRACT and PART_TIME pass straight through;
 *  PERMANENT and SUBSTITUTE are mapped to the closest real value so
 *  old requests keep working. Ask the person if they'd rather the
 *  dropdown itself be updated to the real enum values instead. */
const EMP_TYPE_MAP: Record<string, string> = {
  PERMANENT: "TEACHING",
  CONTRACT: "CONTRACT",
  PART_TIME: "PART_TIME",
  SUBSTITUTE: "PART_TIME",
  TEACHING: "TEACHING",
  NON_TEACHING: "NON_TEACHING",
  TRANSPORT: "TRANSPORT",
  MANAGEMENT: "MANAGEMENT",
};
function resolveEmployeeType(val?: string): "TEACHING" | "NON_TEACHING" | "TRANSPORT" | "MANAGEMENT" | "CONTRACT" | "PART_TIME" {
  const key = val?.toUpperCase().trim() ?? "";
  return (EMP_TYPE_MAP[key] ?? "TEACHING") as any;
}

/** Flattens a Prisma staff row (with departmentRef/designationRef/
 *  subjectAssignments included) into the flat shape the frontend
 *  already expects: department, designation as plain strings,
 *  employmentType as the old label, subjects as [{id,name,code}]. */
function flattenStaff(s: any) {
  const { departmentRef, designationRef, subjectAssignments, employeeType, ...rest } = s;
  return {
    ...rest,
    department: departmentRef?.name ?? null,
    designation: designationRef?.name ?? null,
    employmentType: employeeType,
    subjects: (subjectAssignments ?? []).map((a: any) => a.subject).filter(Boolean),
  };
}

const STAFF_LIST_INCLUDE = {
  user: {
    select: {
      id: true, name: true, phone: true, email: true,
      gender: true, avatarUrl: true, isActive: true, lastLoginAt: true,
    },
  },
  classesAsTeacher: {
    select: { id: true, name: true, academicYear: true },
    where: { isActive: true },
  },
  departmentRef: { select: { name: true } },
  designationRef: { select: { name: true } },
  subjectAssignments: {
    where: { isActive: true },
    select: { subject: { select: { id: true, name: true } } },
  },
} as const;

export async function adminStaffRoutes(app: FastifyInstance) {

  // ── GET /admin/staff ──────────────────────────────────────
  app.get(
  "/admin/staff",
  { preHandler: [authenticate] },
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { schoolId } = request.user as any;
    const query = request.query as {
      search?: string;
      department?: string;
      status?: string;
      limit?: string;
    };

    const where: any = { schoolId };

    // Status filter
    if (query.status === "ACTIVE") where.isActive = true;
    else if (query.status === "INACTIVE") where.isActive = false;
    // else: no filter → return all

    if (query.search) {
      where.OR = [
        { user: { name: { contains: query.search, mode: "insensitive" } } },
        { employeeId: { contains: query.search, mode: "insensitive" } },
        { departmentRef: { name: { contains: query.search, mode: "insensitive" } } },
        { designationRef: { name: { contains: query.search, mode: "insensitive" } } },
      ];
    }

    if (query.department) {
      where.departmentRef = { name: { contains: query.department, mode: "insensitive" } };
    }

    const staff = await prisma.staff.findMany({
      where,
      take: query.limit ? parseInt(query.limit) : undefined,
      include: STAFF_LIST_INCLUDE,
      orderBy: { user: { name: "asc" } },
    });

    return reply.send({ success: true, data: { staff: staff.map(flattenStaff), total: staff.length } });
  }
);

  // ── GET /admin/staff/import-template ─────────────────────
  // NOTE: Must be defined BEFORE /admin/staff/:id to avoid route conflict
  app.get(
    "/admin/staff/import-template",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();

      const headers = [
        [
          "Employee ID*", "Full Name*", "Phone*", "Email",
          "Gender", "Designation*", "Department*",
          "Qualification", "Experience Years", "Employment Type",
          "Salary", "Join Date",
        ],
        [
          "EMP001", "Priya Verma", "9876543210", "priya@school.edu",
          "Female", "Senior Teacher", "Mathematics",
          "M.Sc B.Ed", "8", "PERMANENT", "45000", "01/04/2025",
        ],
        [
          "EMP002", "Rakesh Kumar", "9876543211", "rakesh@school.edu",
          "Male", "Teacher", "Science",
          "M.Sc B.Ed", "5", "PERMANENT", "38000", "01/04/2025",
        ],
      ];

      const ws = XLSX.utils.aoa_to_sheet(headers);
      ws["!cols"] = [
        { wch: 13 }, { wch: 20 }, { wch: 13 }, { wch: 25 },
        { wch: 10 }, { wch: 18 }, { wch: 15 },
        { wch: 18 }, { wch: 18 }, { wch: 16 },
        { wch: 10 }, { wch: 12 },
      ];
      XLSX.utils.book_append_sheet(wb, ws, "Staff");

      const instructions = [
        ["FIELD", "REQUIRED", "FORMAT / OPTIONS", "NOTES"],
        ["Employee ID", "YES", "Text", "Must be unique in school"],
        ["Full Name", "YES", "Text", "Full name of staff member"],
        ["Phone", "YES", "10 digits", "Unique mobile number (used as default password)"],
        ["Email", "NO", "email@example.com", "Optional"],
        ["Gender", "NO", "Male / Female / Other", ""],
        ["Designation", "YES", "Text", "e.g. Teacher, Principal, Librarian — created automatically if new"],
        ["Department", "YES", "Text", "e.g. Mathematics, Science, Administration — created automatically if new"],
        ["Qualification", "NO", "Text", "e.g. M.Sc B.Ed"],
        ["Experience Years", "NO", "Number", "e.g. 5"],
        ["Employment Type", "NO", "PERMANENT / CONTRACT / PART_TIME / SUBSTITUTE", "Default: PERMANENT"],
        ["Salary", "NO", "Number", "Monthly salary in rupees"],
        ["Join Date", "NO", "DD/MM/YYYY", "e.g. 01/04/2025"],
      ];
      const wsInstr = XLSX.utils.aoa_to_sheet(instructions);
      wsInstr["!cols"] = [{ wch: 18 }, { wch: 12 }, { wch: 40 }, { wch: 35 }];
      XLSX.utils.book_append_sheet(wb, wsInstr, "Instructions");

      const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", "attachment; filename=staff-import-template.xlsx")
        .send(buffer);
    }
  );

  // ── POST /admin/staff/import ──────────────────────────────
  // NOTE: Must be defined BEFORE /admin/staff/:id to avoid route conflict
  app.post(
    "/admin/staff/import",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as {
        rows: Array<{
          employeeId: string;
          name: string;
          phone: string;
          email?: string;
          gender?: string;
          designation: string;
          department: string;
          qualification?: string;
          experienceYears?: string;
          employmentType?: string;
          salary?: string;
          joinDate?: string;
        }>;
      };

      if (!body.rows?.length) {
        return reply.status(400).send({
          success: false,
          message: "No rows provided.",
        });
      }

      const { hashPassword } = await import("../../utils/auth.js");

      const results = {
        success: [] as number[],
        errors: [] as { row: number; reason: string }[],
        skipped: [] as { row: number; reason: string }[],
      };

      for (let i = 0; i < body.rows.length; i++) {
        const row = body.rows[i];
        const rowNum = i + 2;

        // Validate mandatory fields
        if (!row.employeeId?.trim()) {
          results.errors.push({ row: rowNum, reason: "Employee ID is required" });
          continue;
        }
        if (!row.name?.trim()) {
          results.errors.push({ row: rowNum, reason: "Name is required" });
          continue;
        }
        if (!row.phone?.trim()) {
          results.errors.push({ row: rowNum, reason: "Phone is required" });
          continue;
        }
        if (!row.designation?.trim()) {
          results.errors.push({ row: rowNum, reason: "Designation is required" });
          continue;
        }
        if (!row.department?.trim()) {
          results.errors.push({ row: rowNum, reason: "Department is required" });
          continue;
        }

        const phone = row.phone.replace(/\s+/g, "").replace(/-/g, "");
        if (!/^\d{10}$/.test(phone)) {
          results.errors.push({ row: rowNum, reason: `Invalid phone: ${row.phone}` });
          continue;
        }

        // Check Employee ID unique
        const empExists = await prisma.staff.findFirst({
          where: { schoolId, employeeId: row.employeeId.trim() },
        });
        if (empExists) {
          results.skipped.push({
            row: rowNum,
            reason: `Employee ID ${row.employeeId} already exists`,
          });
          continue;
        }

        // Check phone unique
        const phoneExists = await prisma.user.findFirst({ where: { phone } });
        if (phoneExists) {
          results.skipped.push({
            row: rowNum,
            reason: `Phone ${phone} already registered`,
          });
          continue;
        }

        // Check email unique
        if (row.email?.trim()) {
          const emailExists = await prisma.user.findFirst({
            where: { email: row.email.toLowerCase() },
          });
          if (emailExists) {
            results.skipped.push({
              row: rowNum,
              reason: `Email ${row.email} already registered`,
            });
            continue;
          }
        }

        try {
          const departmentId = await resolveDepartmentId(schoolId, row.department);
          const designationId = await resolveDesignationId(schoolId, row.designation, departmentId);
          const empType = resolveEmployeeType(row.employmentType);

          await prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
              data: {
                schoolId,
                name: row.name.trim(),
                phone,
                email: row.email?.toLowerCase() || null,
                passwordHash: await hashPassword(phone),
                role: "TEACHER",
                gender: mapGender(row.gender),
                isActive: true,
              },
            });

            await tx.staff.create({
              data: {
                userId: user.id,
                schoolId,
                employeeId: row.employeeId.trim(),
                designationId,
                departmentId,
                qualification: row.qualification?.trim() || null,
                experienceYears: row.experienceYears ? parseInt(row.experienceYears) : 0,
                employeeType: empType as any,
                salary: row.salary ? parseFloat(row.salary) : null,
                joinDate: parseDate(row.joinDate ?? "") ?? new Date(),
                isActive: true,
              },
            });
          });

          results.success.push(rowNum);
        } catch (err) {
          console.error(`Row ${rowNum} error:`, err);
          results.errors.push({ row: rowNum, reason: "Database error while saving" });
        }
      }

      return reply.send({
        success: true,
        message: `Import complete. ${results.success.length} staff members added.`,
        data: {
          imported: results.success.length,
          errors: results.errors,
          skipped: results.skipped,
          total: body.rows.length,
        },
      });
    }
  );

  // ── GET /admin/staff/:id ──────────────────────────────────
  app.get(
    "/admin/staff/:id",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const staff = await prisma.staff.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          user: {
            select: {
              id: true, name: true, phone: true, email: true,
              gender: true, avatarUrl: true, isActive: true,
              createdAt: true, lastLoginAt: true,
            },
          },
          classesAsTeacher: {
            select: { id: true, name: true, section: true, academicYear: true },
            where: { isActive: true },
          },
          departmentRef: { select: { name: true } },
          designationRef: { select: { name: true } },
          subjectAssignments: {
            where: { isActive: true },
            select: { subject: { select: { id: true, name: true, code: true } } },
          },
        },
      });

      if (!staff) {
        return reply.status(404).send({
          success: false,
          message: "Staff member not found.",
        });
      }

      return reply.send({ success: true, data: { staff: flattenStaff(staff) } });
    }
  );

  // ── POST /admin/staff ─────────────────────────────────────
  app.post(
    "/admin/staff",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as {
        name: string;
        phone?: string;
        email?: string;
        gender?: string;
        employeeId: string;
        designation: string;
        department: string;
        qualification?: string;
        experienceYears?: number;
        employmentType?: string;
        salary?: number;
        joinDate?: string;
        password?: string;
      };

      if (!body.name?.trim()) {
        return reply.status(400).send({ success: false, message: "Name is required." });
      }
      if (!body.phone && !body.email) {
        return reply.status(400).send({ success: false, message: "Phone or email is required." });
      }
      if (!body.employeeId?.trim()) {
        return reply.status(400).send({ success: false, message: "Employee ID is required." });
      }
      if (!body.designation?.trim()) {
        return reply.status(400).send({ success: false, message: "Designation is required." });
      }
      if (!body.department?.trim()) {
        return reply.status(400).send({ success: false, message: "Department is required." });
      }

      // Duplicate checks
      const empExists = await prisma.staff.findFirst({
        where: { schoolId, employeeId: body.employeeId.trim() },
      });
      if (empExists) {
        return reply.status(409).send({
          success: false,
          error: "EMPLOYEE_ID_EXISTS",
          message: `Employee ID ${body.employeeId} already exists.`,
        });
      }

      if (body.phone) {
        const phoneExists = await prisma.user.findFirst({ where: { phone: body.phone } });
        if (phoneExists) {
          return reply.status(409).send({
            success: false,
            error: "PHONE_EXISTS",
            message: "This phone number is already registered.",
          });
        }
      }

      if (body.email) {
        const emailExists = await prisma.user.findFirst({
          where: { email: body.email.toLowerCase() },
        });
        if (emailExists) {
          return reply.status(409).send({
            success: false,
            error: "EMAIL_EXISTS",
            message: "This email is already registered.",
          });
        }
      }

      const { hashPassword } = await import("../../utils/auth.js");
      const passwordHash = await hashPassword(body.password ?? body.phone ?? "Teacher@123");
      const empType = resolveEmployeeType(body.employmentType);
      const departmentId = await resolveDepartmentId(schoolId, body.department);
      const designationId = await resolveDesignationId(schoolId, body.designation, departmentId);

      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            schoolId,
            name: body.name.trim(),
            phone: body.phone ?? null,
            email: body.email?.toLowerCase() ?? null,
            passwordHash,
            role: "TEACHER",
            gender: mapGender(body.gender),
            isActive: true,
          },
        });

        const staff = await tx.staff.create({
          data: {
            userId: user.id,
            schoolId,
            employeeId: body.employeeId.trim(),
            designationId,
            departmentId,
            qualification: body.qualification?.trim() ?? null,
            experienceYears: body.experienceYears ?? 0,
            employeeType: empType as any,
            salary: body.salary ?? null,
            joinDate: body.joinDate ? new Date(body.joinDate) : new Date(),
            isActive: true,
          },
        });

        return { user, staff };
      });

      return reply.status(201).send({
        success: true,
        message: `${body.name} added successfully.`,
        data: {
          staffId: result.staff.id,
          userId: result.user.id,
          defaultPassword: body.password ?? body.phone ?? "Teacher@123",
        },
      });
    }
  );

  // ── PUT /admin/staff/:id ──────────────────────────────────
  app.put(
    "/admin/staff/:id",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        phone?: string;
        email?: string;
        gender?: string;
        designation?: string;
        department?: string;
        qualification?: string;
        experienceYears?: number;
        employmentType?: string;
        salary?: number;
      };

      const staff = await prisma.staff.findFirst({
        where: { id: parseInt(id), schoolId },
        include: { user: true },
      });

      if (!staff) {
        return reply.status(404).send({ success: false, message: "Staff member not found." });
      }

      const empType = body.employmentType ? resolveEmployeeType(body.employmentType) : undefined;
      const departmentId = body.department !== undefined ? await resolveDepartmentId(schoolId, body.department) : undefined;
      const designationId = body.designation !== undefined ? await resolveDesignationId(schoolId, body.designation, departmentId ?? undefined) : undefined;

      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: staff.userId },
          data: {
            ...(body.name && { name: body.name.trim() }),
            ...(body.phone && { phone: body.phone }),
            ...(body.email && { email: body.email.toLowerCase() }),
            ...(body.gender !== undefined && { gender: mapGender(body.gender) }),
          },
        });

        await tx.staff.update({
          where: { id: parseInt(id) },
          data: {
            ...(designationId !== undefined && { designationId }),
            ...(departmentId !== undefined && { departmentId }),
            ...(body.qualification !== undefined && { qualification: body.qualification }),
            ...(body.experienceYears !== undefined && { experienceYears: body.experienceYears }),
            ...(empType && { employeeType: empType as any }),
            ...(body.salary !== undefined && { salary: body.salary }),
          },
        });
      });

      return reply.send({ success: true, message: "Staff member updated successfully." });
    }
  );

  // ── PATCH /admin/staff/:id/status ─────────────────────────
  app.patch(
    "/admin/staff/:id/status",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const { isActive } = request.body as { isActive: boolean };

      const staff = await prisma.staff.findFirst({
        where: { id: parseInt(id), schoolId },
      });

      if (!staff) {
        return reply.status(404).send({ success: false, message: "Staff member not found." });
      }

      await prisma.$transaction(async (tx) => {
        await tx.staff.update({ where: { id: parseInt(id) }, data: { isActive } });
        await tx.user.update({ where: { id: staff.userId }, data: { isActive } });
      });

      return reply.send({
        success: true,
        message: `Staff member ${isActive ? "activated" : "deactivated"} successfully.`,
      });
    }
  );

  // ── DELETE /admin/staff/:id ───────────────────────────────
  app.delete(
    "/admin/staff/:id",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const staff = await prisma.staff.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          user: { select: { name: true } },
          classesAsTeacher: { where: { isActive: true } },
        },
      });

      if (!staff) {
        return reply.status(404).send({ success: false, message: "Staff member not found." });
      }

      if (staff.classesAsTeacher.length > 0) {
        return reply.status(400).send({
          success: false,
          message: `Cannot delete. Teacher is class teacher of ${staff.classesAsTeacher.length} class(es). Reassign first.`,
        });
      }

      // Soft delete
      await prisma.$transaction(async (tx) => {
        await tx.staff.update({ where: { id: parseInt(id) }, data: { isActive: false } });
        await tx.user.update({
          where: { id: staff.userId },
          data: { isActive: false, isDeleted: true },
        });
      });

      return reply.send({
        success: true,
        message: `${staff.user.name} has been removed.`,
      });
    }
  );
}