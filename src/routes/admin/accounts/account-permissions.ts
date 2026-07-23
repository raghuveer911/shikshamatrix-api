// apps/api/src/routes/admin/account-permissions.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// Default permission sets per role
const ROLE_DEFAULTS: Record<string, any> = {
  SUPER_ADMIN: {
    payrollPerms:  { view:true, create:true, edit:true, delete:true, approve:true },
    salaryPerms:   { view:true, create:true, edit:true, delete:true, approve:true },
    vendorPerms:   { view:true, create:true, edit:true, delete:true, approve:true },
    loanPerms:     { view:true, create:true, edit:true, delete:true, approve:true },
    expensePerms:  { view:true, create:true, edit:true, delete:true, approve:true },
    reimPerms:     { view:true, create:true, edit:true, delete:true, approve:true },
    docPerms:      { view:true, create:true, edit:true, delete:true, approve:true },
    salaryVisibility:"ALL", canViewAuditLogs:true, canAccessDocuments:true,
    canApproveVendors:true, canApproveSalary:true, canApproveExpense:true,
  },
  MANAGEMENT: {
    payrollPerms:  { view:true, create:false, edit:false, delete:false, approve:true },
    salaryPerms:   { view:true, create:false, edit:false, delete:false, approve:true },
    vendorPerms:   { view:true, create:false, edit:false, delete:false, approve:true },
    loanPerms:     { view:true, create:false, edit:false, delete:false, approve:true },
    expensePerms:  { view:true, create:false, edit:false, delete:false, approve:true },
    reimPerms:     { view:true, create:false, edit:false, delete:false, approve:true },
    docPerms:      { view:true, create:false, edit:false, delete:false, approve:false },
    salaryVisibility:"ALL", canViewAuditLogs:true, canAccessDocuments:true,
    canApproveVendors:true, canApproveSalary:true, canApproveExpense:true,
  },
  PRINCIPAL: {
    payrollPerms:  { view:true, create:false, edit:false, delete:false, approve:true },
    salaryPerms:   { view:true, create:false, edit:false, delete:false, approve:true },
    vendorPerms:   { view:true, create:false, edit:false, delete:false, approve:true },
    loanPerms:     { view:true, create:false, edit:false, delete:false, approve:true },
    expensePerms:  { view:true, create:false, edit:false, delete:false, approve:true },
    reimPerms:     { view:true, create:false, edit:false, delete:false, approve:true },
    docPerms:      { view:true, create:false, edit:false, delete:false, approve:false },
    salaryVisibility:"ALL", canViewAuditLogs:true, canAccessDocuments:true,
    canApproveVendors:true, canApproveSalary:true, canApproveExpense:true,
  },
  ACCOUNT_MANAGER: {
    payrollPerms:  { view:true, create:true, edit:true, delete:false, approve:true },
    salaryPerms:   { view:true, create:true, edit:true, delete:false, approve:true },
    vendorPerms:   { view:true, create:true, edit:true, delete:false, approve:true },
    loanPerms:     { view:true, create:true, edit:true, delete:false, approve:true },
    expensePerms:  { view:true, create:true, edit:true, delete:false, approve:true },
    reimPerms:     { view:true, create:true, edit:true, delete:false, approve:true },
    docPerms:      { view:true, create:true, edit:true, delete:false, approve:true },
    salaryVisibility:"ALL", canViewAuditLogs:true, canAccessDocuments:true,
    canApproveVendors:true, canApproveSalary:true, canApproveExpense:true,
  },
  ACCOUNTANT: {
    payrollPerms:  { view:true, create:true, edit:true, delete:false, approve:false },
    salaryPerms:   { view:true, create:true, edit:true, delete:false, approve:false },
    vendorPerms:   { view:true, create:true, edit:true, delete:false, approve:false },
    loanPerms:     { view:true, create:true, edit:false, delete:false, approve:false },
    expensePerms:  { view:true, create:true, edit:false, delete:false, approve:false },
    reimPerms:     { view:true, create:true, edit:false, delete:false, approve:false },
    docPerms:      { view:true, create:true, edit:false, delete:false, approve:false },
    salaryVisibility:"ALL", canViewAuditLogs:false, canAccessDocuments:true,
    canApproveVendors:false, canApproveSalary:false, canApproveExpense:false,
  },
  HR_MANAGER: {
    payrollPerms:  { view:true, create:false, edit:false, delete:false, approve:false },
    salaryPerms:   { view:true, create:false, edit:false, delete:false, approve:true },
    vendorPerms:   { view:false, create:false, edit:false, delete:false, approve:false },
    loanPerms:     { view:true, create:true, edit:false, delete:false, approve:false },
    expensePerms:  { view:false, create:false, edit:false, delete:false, approve:false },
    reimPerms:     { view:true, create:true, edit:false, delete:false, approve:false },
    docPerms:      { view:true, create:true, edit:false, delete:false, approve:false },
    salaryVisibility:"DEPARTMENT", canViewAuditLogs:false, canAccessDocuments:true,
    canApproveVendors:false, canApproveSalary:true, canApproveExpense:false,
  },
  AUDITOR: {
    payrollPerms:  { view:true, create:false, edit:false, delete:false, approve:false },
    salaryPerms:   { view:true, create:false, edit:false, delete:false, approve:false },
    vendorPerms:   { view:true, create:false, edit:false, delete:false, approve:false },
    loanPerms:     { view:true, create:false, edit:false, delete:false, approve:false },
    expensePerms:  { view:true, create:false, edit:false, delete:false, approve:false },
    reimPerms:     { view:true, create:false, edit:false, delete:false, approve:false },
    docPerms:      { view:true, create:false, edit:false, delete:false, approve:false },
    salaryVisibility:"ALL", canViewAuditLogs:true, canAccessDocuments:true,
    canApproveVendors:false, canApproveSalary:false, canApproveExpense:false,
  },
  DATA_ENTRY: {
    payrollPerms:  { view:false, create:false, edit:false, delete:false, approve:false },
    salaryPerms:   { view:false, create:false, edit:false, delete:false, approve:false },
    vendorPerms:   { view:true,  create:true,  edit:false, delete:false, approve:false },
    loanPerms:     { view:false, create:false, edit:false, delete:false, approve:false },
    expensePerms:  { view:true,  create:true,  edit:false, delete:false, approve:false },
    reimPerms:     { view:true,  create:true,  edit:false, delete:false, approve:false },
    docPerms:      { view:true,  create:true,  edit:false, delete:false, approve:false },
    salaryVisibility:"OWN", canViewAuditLogs:false, canAccessDocuments:true,
    canApproveVendors:false, canApproveSalary:false, canApproveExpense:false,
  },
};

export async function adminAccountPermissionRoutes(app: FastifyInstance) {

  // GET /admin/account-permissions — list all
  app.get("/admin/account-permissions", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const perms = await prisma.accountPermission.findMany({
        where: { schoolId },
        include: { user: { select: { name: true, email: true } }, createdBy: { select: { name: true } } },
        orderBy: { accountRole: "asc" },
      });
      const availableStaff = await prisma.staff.findMany({ where: { schoolId, isActive: true }, include: { user: { select: { id: true, name: true } } }, take: 100 });
      return reply.send({ success: true, data: { permissions: perms, availableStaff } });
    }
  );

  // GET /admin/account-permissions/user/:userId
  app.get("/admin/account-permissions/user/:userId", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { userId } = req.params as { userId: string };
      const perm = await prisma.accountPermission.findFirst({
        where: { schoolId, userId: parseInt(userId) },
        include: { user: { select: { name: true } } },
      });
      return reply.send({ success: true, data: { permission: perm } });
    }
  );

  // POST /admin/account-permissions — assign
  app.post("/admin/account-permissions", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId: createdById } = req.user as any;
      const body = req.body as { userId: number; accountRole: string; expiresAt?: string; notes?: string };
      if (!body.userId || !body.accountRole) return reply.status(400).send({ success: false, message: "userId and accountRole required." });

      const defaults = ROLE_DEFAULTS[body.accountRole] ?? ROLE_DEFAULTS.DATA_ENTRY;
      const perm = await prisma.accountPermission.upsert({
        where: { schoolId_userId: { schoolId, userId: body.userId } },
        create: { schoolId, createdById, userId: body.userId, accountRole: body.accountRole as any, ...defaults, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, notes: body.notes ?? null },
        update: { accountRole: body.accountRole as any, ...defaults, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, notes: body.notes ?? null },
      });

      // Log
      await prisma.accountActivityLog.create({ data: { schoolId, userId: createdById, action: "PERMISSION_ASSIGNED", module: "PERMISSIONS", details: { targetUserId: body.userId, role: body.accountRole } } });

      return reply.send({ success: true, message: `${body.accountRole} permissions assigned.`, data: { permId: perm.id } });
    }
  );

  // PUT /admin/account-permissions/:id — custom update
  app.put("/admin/account-permissions/:id", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId: actorId } = req.user as any;
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const allowed = ["payrollPerms","salaryPerms","vendorPerms","loanPerms","expensePerms","reimPerms","docPerms","salaryVisibility","canViewAuditLogs","canAccessDocuments","canApproveVendors","canApproveSalary","canApproveExpense","isActive","expiresAt","notes"];
      const data: any = {};
      allowed.forEach(k => { if (body[k] !== undefined) data[k] = body[k]; });
      await prisma.accountPermission.updateMany({ where: { id: parseInt(id), schoolId }, data });
      await prisma.accountActivityLog.create({ data: { schoolId, userId: actorId, action: "PERMISSION_UPDATED", module: "PERMISSIONS", entityId: parseInt(id) } });
      return reply.send({ success: true, message: "Permissions updated." });
    }
  );

  // POST /admin/account-permissions/:id/apply-role-defaults
  app.post("/admin/account-permissions/:id/apply-role-defaults", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { accountRole } = req.body as { accountRole: string };
      const defaults = ROLE_DEFAULTS[accountRole] ?? ROLE_DEFAULTS.DATA_ENTRY;
      await prisma.accountPermission.updateMany({ where: { id: parseInt(id), schoolId }, data: { accountRole: accountRole as any, ...defaults } });
      return reply.send({ success: true, message: "Role defaults applied." });
    }
  );

  // DELETE /admin/account-permissions/:id — revoke
  app.delete("/admin/account-permissions/:id", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.accountPermission.deleteMany({ where: { id: parseInt(id), schoolId } });
      return reply.send({ success: true, message: "Permissions revoked." });
    }
  );

  // GET /admin/account-permissions/activity-logs
  app.get("/admin/account-permissions/activity-logs", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?: string; module?: string; userId?: string };
      const page = Math.max(1, parseInt(q.page ?? "1")); const limit = 30;
      const where: any = { schoolId };
      if (q.module) where.module = q.module;
      if (q.userId) where.userId = parseInt(q.userId);
      const [logs, total] = await Promise.all([
        prisma.accountActivityLog.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { occurredAt: "desc" }, include: { user: { select: { name: true } } } }),
        prisma.accountActivityLog.count({ where }),
      ]);
      return reply.send({ success: true, data: { logs, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // POST /admin/account-permissions/log — track action
  app.post("/admin/account-permissions/log", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { action, module: mod, entityId, entityType, details } = req.body as { action: string; module: string; entityId?: number; entityType?: string; details?: any };
      await prisma.accountActivityLog.create({ data: { schoolId, userId, action, module: mod, entityId: entityId ?? null, entityType: entityType ?? null, details: details ?? null, ipAddress: (req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? null) } });
      return reply.send({ success: true });
    }
  );

  // GET /admin/account-permissions/role-defaults/:role
  app.get("/admin/account-permissions/role-defaults/:role", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const { role } = (_req.params as any);
      const defaults = ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS.DATA_ENTRY;
      return reply.send({ success: true, data: { defaults } });
    }
  );
}
