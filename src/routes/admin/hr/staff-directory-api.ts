import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";
import { assertStorageLimitNotExceeded, StorageLimitError } from "../../../services/storage.service.js";
import bcrypt from "bcryptjs";
import { UserRole } from "@prisma/client";

const STAFF_INCLUDE = {
  user:        { select: { id: true, name: true, email: true, phone: true, avatarUrl: true, isActive: true, role: true } },
  departmentRef:  { select:{ id:true,name:true } },
  designationRef: { select:{ id:true,name:true,employeeType:true } },
  documents:   { select: { id: true, docType: true, fileName: true, verification: true, expiryDate: true } },
} as const;

export async function adminStaffDirectoryRoutes(app: FastifyInstance) {

  // ─── DEPARTMENTS ───────────────────────────────────────────
  app.get("/admin/hr/departments", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const depts = await prisma.department.findMany({
        where:   { schoolId, isActive: true },
        orderBy: { name: "asc" },
        include: {_count: { select:{ staffMembers:true }}},
      });
      return reply.send({
        success: true,
        data:    { departments: depts.map(d => ({ ...d, staffCount: d._count.staffMembers })) },
      });
    }
  );

  app.post("/admin/hr/departments", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { name, code, description, headUserId } = req.body as {
        name: string; code?: string; description?: string; headUserId?: number;
      };
      if (!name) return reply.status(400).send({ success: false, message: "name required." });
      const existing = await prisma.department.findFirst({ where: { schoolId, name } });
      if (existing) return reply.status(409).send({ success: false, message: "Department already exists." });
      const d = await prisma.department.create({
        data: { schoolId, name, code: code ?? null, description: description ?? null, headUserId: headUserId ?? null },
      });
      return reply.status(201).send({ success: true, data: { id: d.id } });
    }
  );

  app.put("/admin/hr/departments/:id", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.department.updateMany({ where: { id: parseInt(id), schoolId }, data: req.body as any });
      return reply.send({ success: true });
    }
  );

  app.delete("/admin/hr/departments/:id", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const hasStaff = await prisma.staff.count({
        where: { schoolId, departmentId: parseInt(id), status: { in: ["ACTIVE", "PROBATION"] } },
      });
      if (hasStaff > 0) {
        return reply.status(400).send({ success: false, message: `Cannot delete — ${hasStaff} active staff in this department.` });
      }
      await prisma.department.updateMany({ where: { id: parseInt(id), schoolId }, data: { isActive: false } });
      return reply.send({ success: true });
    }
  );

  // ─── DESIGNATIONS ──────────────────────────────────────────
  app.get("/admin/hr/designations", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { departmentId } = req.query as { departmentId?: string };
      const where: any = { schoolId, isActive: true };
      if (departmentId) where.departmentId = parseInt(departmentId);
      const desig = await prisma.designation.findMany({ where, orderBy: { name: "asc" } });
      return reply.send({ success: true, data: { designations: desig } });
    }
  );

  app.post("/admin/hr/designations", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { name, departmentId, employeeType } = req.body as {
        name: string; departmentId?: number; employeeType?: string;
      };
      if (!name) return reply.status(400).send({ success: false, message: "name required." });
      const d = await prisma.designation.create({
        data: { schoolId, name, departmentId: departmentId ?? null, employeeType: employeeType as any ?? "TEACHING" },
      });
      return reply.status(201).send({ success: true, data: { id: d.id } });
    }
  );

  app.put("/admin/hr/designations/:id", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.designation.updateMany({ where: { id: parseInt(id), schoolId }, data: req.body as any });
      return reply.send({ success: true });
    }
  );

  // ─── STAFF LISTING ─────────────────────────────────────────
  app.get("/admin/hr/staff", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as {
        page?: string; search?: string; departmentId?: string;
        designationId?: string; employeeType?: string; status?: string; groupId?: string;
      };
      const page  = Math.max(1, parseInt(q.page ?? "1"));
      const limit = 20;
      const where: any = { schoolId };
      if (q.departmentId)  where.departmentId  = parseInt(q.departmentId);
      if (q.designationId) where.designationId = parseInt(q.designationId);
      if (q.employeeType)  where.employmentType  = q.employeeType;
      if (q.status)        where.status        = q.status;
      if (q.groupId)       where.groupMemberships   = { some: { groupId: parseInt(q.groupId) } };
      if (q.search) {
        where.OR = [
          { user:          { name:  { contains: q.search, mode: "insensitive" } } },
          { employeeId:    { contains: q.search, mode: "insensitive" } },
          { user:          { phone: { contains: q.search } } },
          { user:          { email: { contains: q.search, mode: "insensitive" } } },
          { aadhaarNumber: { contains: q.search } },
        ];
      }
      const [staff, total] = await Promise.all([
        prisma.staff.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" }, include: STAFF_INCLUDE }),
        prisma.staff.count({ where }),
      ]);
      return reply.send({ success: true, data: { staff, total, totalPages: Math.ceil(total / limit) } });
    }
  );

  // ─── ADD STAFF ─────────────────────────────────────────────
  app.post("/admin/hr/staff", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as {
        name: string; email?: string; phone: string; role?: UserRole; password?: string;
        departmentId?: number; designationId?: number; employeeType?: string;
        joinDate: string; gender?: string; dob?: string; bloodGroup?: string;
        maritalStatus?: string; currentAddress?: string; permanentAddress?: string;
        emergencyName?: string; emergencyPhone?: string; emergencyRelation?: string;
        bankName?: string; bankAccount?: string; ifscCode?: string; bankBranch?: string;
        aadhaarNumber?: string; panNumber?: string;
        qualifications?: any[]; experience?: any[];
        probationEnd?: string; contractEnd?: string; hrNotes?: string;
      };

      if (!body.name || !body.phone || !body.joinDate) {
        return reply.status(400).send({ success: false, message: "name, phone, joinDate required." });
      }

      const existingPhone = await prisma.user.findFirst({ where: { phone: body.phone, schoolId } });
      if (existingPhone) {
        return reply.status(409).send({ success: false, message: "Staff with this phone already exists." });
      }
      if (body.email?.trim()) {
      const existingEmail = await prisma.user.findFirst({
      where: {email: body.email.trim().toLowerCase(),},});
      if (existingEmail) {
      return reply.status(409).send({uccess: false,message: "Staff with this email already exists.",});}}

      if (body.aadhaarNumber) {
        const existingAadhaar = await prisma.staff.findFirst({
          where: { schoolId, aadhaarNumber: body.aadhaarNumber },
        });
        if (existingAadhaar) {
          return reply.status(409).send({ success: false, message: "Staff with this Aadhaar already exists." });
        }
      }

      const count      = await prisma.staff.count({ where: { schoolId } });
      const employeeId = `EMP-${String(count + 1).padStart(4, "0")}`;
      const hashed     = await bcrypt.hash(body.password ?? body.phone, 10);

      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            schoolId,
            name:     body.name,
            email: body.email?.trim()? body.email.trim().toLowerCase(): null,
            phone:    body.phone,
            role: body.role ?? UserRole.TEACHER,
            passwordHash: hashed,
            isActive: true,
          },
        });
        const profile = await tx.staff.create({
          data: {
            schoolId,
            userId:           user.id,
            employeeId,
            departmentId:     body.departmentId  ?? null,
            designationId:    body.designationId ?? null,
            employeeType:     body.employeeType as any ?? "TEACHING",
            joinDate:         new Date(body.joinDate),
            gender:           body.gender        ?? null,
            dob:              body.dob ? new Date(body.dob) : null,
            bloodGroup:       body.bloodGroup    ?? null,
            maritalStatus:    body.maritalStatus ?? null,
            currentAddress:   body.currentAddress   ?? null,
            permanentAddress: body.permanentAddress ?? null,
            emergencyName:    body.emergencyName     ?? null,
            emergencyPhone:   body.emergencyPhone    ?? null,
            emergencyRelation: body.emergencyRelation ?? null,
            bankName:         body.bankName    ?? null,
            bankAccount:      body.bankAccount ?? null,
            ifscCode:         body.ifscCode    ?? null,
            bankBranch:       body.bankBranch  ?? null,
            aadhaarNumber:    body.aadhaarNumber ?? null,
            panNumber:        body.panNumber    ?? null,
            qualifications:   body.qualifications ?? undefined,
            experience:       body.experience    ?? undefined,
            probationEnd:     body.probationEnd ? new Date(body.probationEnd) : null,
            contractEnd:      body.contractEnd  ? new Date(body.contractEnd)  : null,
            hrNotes:          body.hrNotes ?? null,
            status:           "ACTIVE",
          },
        });
        return { userId: user.id, profileId: profile.id, employeeId };
      });

      return reply.status(201).send({
        success: true,
        message: `Staff added. Employee ID: ${employeeId}`,
        data:    result,
      });
    }
  );

  // ─── GET SINGLE STAFF PROFILE ──────────────────────────────
  app.get("/admin/hr/staff/:id", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const profile = await prisma.staff.findFirst({
        where: { id: parseInt(id), schoolId },
        include: {
          ...STAFF_INCLUDE,
          groupMemberships:      { include: { group: { select: { id: true, name: true } } } },
          shiftAssignments: { where: { isActive: true }, include: { shift: true }, take: 1, orderBy: { createdAt: "desc" } },
        },
      });
      if (!profile) return reply.status(404).send({ success: false, message: "Staff not found." });
      return reply.send({ success: true, data: { profile } });
    }
  );

  // ─── UPDATE STAFF PROFILE ──────────────────────────────────
  app.put("/admin/hr/staff/:id", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, any>;

      const profile = await prisma.staff.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!profile) return reply.status(404).send({ success: false, message: "Not found." });

      const USER_KEYS  = ["name", "email", "phone", "avatarUrl", "isActive", "role"];
      const DATE_KEYS  = ["dob", "joinDate", "probationEnd", "contractEnd"];
      const userFields: Record<string, any>    = {};
      const profileFields: Record<string, any> = {};

      Object.entries(body).forEach(([k, v]) => {
        if (USER_KEYS.includes(k))       userFields[k]   = v;
        else if (DATE_KEYS.includes(k))  profileFields[k] = v ? new Date(v as string) : null;
        else                             profileFields[k] = v;
      });

      await prisma.$transaction(async (tx) => {
        if (Object.keys(userFields).length > 0) {
          await tx.user.updateMany({ where: { id: profile.userId }, data: userFields });
        }
        if (Object.keys(profileFields).length > 0) {
          await tx.staff.updateMany({ where: { id: parseInt(id), schoolId }, data: profileFields });
        }
      });
      return reply.send({ success: true, message: "Profile updated." });
    }
  );

  // ─── STATUS CHANGE ─────────────────────────────────────────
  app.patch("/admin/hr/staff/:id/status", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { status, reason } = req.body as { status: string; reason?: string };
      await prisma.staff.updateMany({
        where: { id: parseInt(id), schoolId },
        data:  {
          status: status as any,
          hrNotes: reason
            ? `[STATUS ${new Date().toLocaleDateString("en-IN")}]: ${reason}`
            : undefined,
        },
      });
      return reply.send({ success: true, message: `Status updated to ${status}.` });
    }
  );

  // ─── STAFF DOCUMENTS ───────────────────────────────────────
  app.get("/admin/hr/staff/:id/documents", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const docs = await prisma.staffDocument.findMany({
        where: { staffId: parseInt(id), schoolId },
        orderBy: { createdAt: "desc" },
      });
      return reply.send({ success: true, data: { documents: docs } });
    }
  );

  app.post("/admin/hr/staff/:id/documents", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { docType, fileName, fileUrl, fileSize, expiryDate, remarks } = req.body as {
        docType: string; fileName: string; fileUrl?: string;
        fileSize?: number; expiryDate?: string; remarks?: string;
      };
      if (!docType || !fileName) {
        return reply.status(400).send({ success: false, message: "docType and fileName required." });
      }
      try {
        await assertStorageLimitNotExceeded(schoolId, fileSize ?? 0);
      } catch (err) {
        if (err instanceof StorageLimitError) return reply.status(507).send({ success: false, message: err.message });
        throw err;
      }
      const doc = await prisma.staffDocument.create({
        data: {
          schoolId, staffId: parseInt(id), docType: docType as any,
          fileName, fileUrl: fileUrl ?? null, fileSize: fileSize ?? null,
          expiryDate: expiryDate ? new Date(expiryDate) : null,
          remarks: remarks ?? null,
        },
      });
      return reply.status(201).send({ success: true, data: { id: doc.id } });
    }
  );

  app.patch("/admin/hr/staff/documents/:docId/verify", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { docId } = req.params as { docId: string };
      const { status, remarks } = req.body as { status: string; remarks?: string };
      await prisma.staffDocument.updateMany({
        where: { id: parseInt(docId), schoolId },
        data:  { verification: status as any, verifiedById: userId, remarks: remarks ?? null },
      });
      return reply.send({ success: true });
    }
  );

  // ─── STAFF GROUPS ──────────────────────────────────────────
  app.get("/admin/hr/groups", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const groups = await prisma.staffGroup.findMany({
        where: { schoolId, isActive: true },
        include: { _count: { select: { members: true } } },
      });
      return reply.send({
        success: true,
        data:    { groups: groups.map(g => ({ ...g, memberCount: g._count.members })) },
      });
    }
  );

  app.post("/admin/hr/groups", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { name, description } = req.body as { name: string; description?: string };
      if (!name) return reply.status(400).send({ success: false, message: "name required." });
      const g = await prisma.staffGroup.create({
        data: { schoolId, name, description: description ?? null },
      });
      return reply.status(201).send({ success: true, data: { id: g.id } });
    }
  );

  app.post("/admin/hr/groups/:id/members", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const { staffIds } = req.body as { staffIds: number[] };
      for (const staffId of staffIds) {
        await prisma.staffGroupMember.upsert({
          where:  { groupId_staffId: { groupId: parseInt(id), staffId } },
          update: {},
          create: { groupId: parseInt(id), staffId },
        });
      }
      return reply.send({ success: true, message: `${staffIds.length} member(s) added.` });
    }
  );

  app.delete("/admin/hr/groups/:id/members/:staffId", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id, staffId } = req.params as { id: string; staffId: string };
      await prisma.staffGroupMember.deleteMany({
        where: { groupId: parseInt(id), staffId: parseInt(staffId) },
      });
      return reply.send({ success: true });
    }
  );

  // ─── STAFF DIRECTORY REPORT ────────────────────────────────
  app.get("/admin/hr/staff/reports/directory", { preHandler: [authenticate, requireCapability('hr.staffCore')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { departmentId, employeeType, status } = req.query as {
        departmentId?: string; employeeType?: string; status?: string;
      };
      const where: any = { schoolId };
      if (departmentId)  where.departmentId  = parseInt(departmentId);
      if (employeeType)  where.employmentType  = employeeType;
      if (status)        where.status        = status;
      const staff = await prisma.staff.findMany({
        where, include: STAFF_INCLUDE, orderBy: { employeeId: "asc" },
      });
      return reply.send({
        success: true,
        data:    { staff, total: staff.length, generatedAt: new Date().toISOString() },
      });
    }
  );
}