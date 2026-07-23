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
        { department: { contains: query.search, mode: "insensitive" } },
        { designation: { contains: query.search, mode: "insensitive" } },
      ];
    }

    if (query.department) {
      where.department = { contains: query.department, mode: "insensitive" };
    }

    const staff = await prisma.staff.findMany({
      where,
      take: query.limit ? parseInt(query.limit) : undefined,
      include: {
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
        subjects: {
          select: { id: true, name: true },
          where: { isActive: true },
        },
      },
      orderBy: { user: { name: "asc" } },
    });

    return reply.send({ success: true, data: { staff, total: staff.length } });
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
        ["Designation", "YES", "Text", "e.g. Teacher, Principal, Librarian"],
        ["Department", "YES", "Text", "e.g. Mathematics, Science, Administration"],
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
      const VALID_EMP_TYPES = ["PERMANENT", "CONTRACT", "PART_TIME", "SUBSTITUTE"];

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
          const empType = VALID_EMP_TYPES.includes(row.employmentType?.toUpperCase() ?? "")
            ? (row.employmentType!.toUpperCase() as any)
            : "PERMANENT";

          await prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
              data: {
                schoolId,
                name: row.name.trim(),
                phone,
                email: row.email?.toLowerCase() || null,
                passwordHash: await hashPassword(phone),
                role: "TEACHER",
                gender: mapGender(row.gender), // ← Fixed!
                isActive: true,
              },
            });

            await tx.staff.create({
              data: {
                userId: user.id,
                schoolId,
                employeeId: row.employeeId.trim(),
                designation: row.designation.trim(),
                department: row.department.trim(),
                qualification: row.qualification?.trim() || null,
                experienceYears: row.experienceYears ? parseInt(row.experienceYears) : 0,
                employmentType: empType,
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
          subjects: {
            select: { id: true, name: true, code: true },
            where: { isActive: true },
          },
        },
      });

      if (!staff) {
        return reply.status(404).send({
          success: false,
          message: "Staff member not found.",
        });
      }

      return reply.send({ success: true, data: { staff } });
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

      const VALID_EMP_TYPES = ["PERMANENT", "CONTRACT", "PART_TIME", "SUBSTITUTE"];
      const empType = VALID_EMP_TYPES.includes(body.employmentType?.toUpperCase() ?? "")
        ? (body.employmentType!.toUpperCase() as any)
        : "PERMANENT";

      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            schoolId,
            name: body.name.trim(),
            phone: body.phone ?? null,
            email: body.email?.toLowerCase() ?? null,
            passwordHash,
            role: "TEACHER",
            gender: mapGender(body.gender), // ← Fixed!
            isActive: true,
          },
        });

        const staff = await tx.staff.create({
          data: {
            userId: user.id,
            schoolId,
            employeeId: body.employeeId.trim(),
            designation: body.designation.trim(),
            department: body.department.trim(),
            qualification: body.qualification?.trim() ?? null,
            experienceYears: body.experienceYears ?? 0,
            employmentType: empType,
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

      const VALID_EMP_TYPES = ["PERMANENT", "CONTRACT", "PART_TIME", "SUBSTITUTE"];
      const empType = body.employmentType && VALID_EMP_TYPES.includes(body.employmentType.toUpperCase())
        ? (body.employmentType.toUpperCase() as any)
        : undefined;

      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: staff.userId },
          data: {
            ...(body.name && { name: body.name.trim() }),
            ...(body.phone && { phone: body.phone }),
            ...(body.email && { email: body.email.toLowerCase() }),
            ...(body.gender !== undefined && { gender: mapGender(body.gender) }), // ← Fixed!
          },
        });

        await tx.staff.update({
          where: { id: parseInt(id) },
          data: {
            ...(body.designation && { designation: body.designation.trim() }),
            ...(body.department && { department: body.department.trim() }),
            ...(body.qualification !== undefined && { qualification: body.qualification }),
            ...(body.experienceYears !== undefined && { experienceYears: body.experienceYears }),
            ...(empType && { employmentType: empType }),
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
