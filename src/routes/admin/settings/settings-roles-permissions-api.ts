// apps/api/src/routes/admin/settings/settings-roles-permissions-api.ts
// Uses RoleAssignment model (renamed from UserRole to avoid enum conflict)
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

const SYSTEM_ROLES = [
  { name:"Super Admin", slug:"super_admin",   color:"#ef4444", isSystem:true },
  { name:"Principal",   slug:"principal",      color:"#6366f1", isSystem:true },
  { name:"Teacher",     slug:"teacher",        color:"#10b981", isSystem:true },
  { name:"Accountant",  slug:"accountant",     color:"#f59e0b", isSystem:true },
  { name:"Librarian",   slug:"librarian",      color:"#0ea5e9", isSystem:true },
  { name:"Receptionist",slug:"receptionist",   color:"#8b5cf6", isSystem:true },
];

const ALL_MODULES  = ["students","fees","exams","hr","library","hostel","transport","inventory","communication","admissions","help_center","settings"];
const ALL_ACTIONS  = ["view","create","edit","delete","export","approve"];

export async function adminRolesPermissionsRoutes(app: FastifyInstance) {
  const P = "/admin/settings/roles";

  // LIST roles
  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const roles = await prisma.role.findMany({
      where: { schoolId, isActive: true },
      include: {
        permissions: true,
        _count: { select: { assignments: true } },  // ← renamed relation
      },
      orderBy: { name: "asc" },
    });
    return rep.send({ roles, modules: ALL_MODULES, allActions: ALL_ACTIONS });
  });

  // GET one role
  app.get(`${P}/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const role = await prisma.role.findFirst({
      where: { id, schoolId },
      include: {
        permissions: true,
        assignments: {  // ← renamed from userRoles
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
    if (!role) return rep.code(404).send({ error: "Role not found" });
    return rep.send({ role });
  });

  // CREATE role
  app.post(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_|_$)/g, "");
    const existing = await prisma.role.findFirst({ where: { schoolId, slug } });
    if (existing) return rep.code(409).send({ error: "Role with this name already exists" });
    const role = await prisma.role.create({
      data: { schoolId, name: b.name, slug, description: b.description ?? null, color: b.color ?? "#6366f1" },
    });
    return rep.code(201).send({ role });
  });

  // UPDATE role
  app.put(`${P}/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const role = await prisma.role.findFirst({ where: { id, schoolId } });
    if (role?.isSystem && (b.name || b.slug)) return rep.code(409).send({ error: "Cannot rename system roles" });
    const updated = await prisma.role.update({
      where: { id },
      data: { name: b.name, description: b.description, color: b.color, isActive: b.isActive },
    });
    return rep.send({ role: updated });
  });

  // DELETE role (soft)
  app.delete(`${P}/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const role = await prisma.role.findFirst({ where: { id, schoolId } });
    if (!role) return rep.code(404).send({ error: "Not found" });
    if (role.isSystem) return rep.code(409).send({ error: "Cannot delete system roles" });
    const usersCount = await prisma.roleAssignment.count({ where: { roleId: id } });
    if (usersCount > 0) return rep.code(409).send({ error: `Cannot delete — ${usersCount} users have this role` });
    await prisma.role.update({ where: { id }, data: { isActive: false } });
    return rep.send({ ok: true });
  });

  // SAVE permissions (full replace)
  app.put(`${P}/:id/permissions`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const id = Number((req.params as any).id);
    const b  = req.body as any; // { permissions: [{ module, actions }] }
    await prisma.rolePermission.deleteMany({ where: { roleId: id } });
    if (b.permissions?.length) {
      await prisma.rolePermission.createMany({
        data: (b.permissions as any[]).map(p => ({ roleId: id, module: p.module, actions: p.actions ?? [] })),
      });
    }
    const perms = await prisma.rolePermission.findMany({ where: { roleId: id } });
    return rep.send({ permissions: perms });
  });

  // ASSIGN role to user
  app.post(`${P}/:id/assign`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const roleId = Number((req.params as any).id);
    const b      = req.body as any;
    // Using RoleAssignment model (renamed from UserRole)
    const assignment = await prisma.roleAssignment.upsert({
      where: { userId_roleId_schoolId: { userId: Number(b.userId), roleId, schoolId } },
      create: { userId: Number(b.userId), roleId, schoolId },
      update: {},
    });
    return rep.code(201).send({ assignment });
  });

  // REMOVE role from user
  app.delete(`${P}/:id/assign/:userId`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const roleId = Number((req.params as any).id);
    const userId = Number((req.params as any).userId);
    await prisma.roleAssignment.deleteMany({ where: { roleId, userId, schoolId } });
    return rep.send({ ok: true });
  });

  // GET users with their role assignments
  app.get(`${P}/users`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const users = await prisma.user.findMany({
      where: { schoolId },
      select: {
        id: true, name: true, email: true, avatarUrl: true,
        roleAssignments: {   // ← field added via User model update (userRoles → roleAssignments)
          where: { schoolId },
          include: { role: { select: { id: true, name: true, color: true } } },
        },
      },
      orderBy: { name: "asc" },
      take: 200,
    });
    return rep.send({ users });
  });

  // SEED system roles
  app.post(`${P}/seed`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    let created = 0;
    for (const r of SYSTEM_ROLES) {
      const exists = await prisma.role.findFirst({ where: { schoolId, slug: r.slug } });
      if (!exists) {
        await prisma.role.create({ data: { schoolId, ...r } });
        created++;
      }
    }
    return rep.send({ created, message: `${created} system roles seeded` });
  });
}
