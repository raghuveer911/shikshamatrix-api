// apps/api/src/routes/admin/settings/settings-module-management-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

const ALL_MODULES = [
  { key:"library",       name:"Library",          icon:"Library",     deps:[] },
  { key:"hostel",        name:"Hostel",            icon:"Building2",   deps:[] },
  { key:"transport",     name:"Transport",         icon:"Bus",         deps:[] },
  { key:"hr",            name:"HR & Staff",        icon:"Briefcase",   deps:[] },
  { key:"inventory",     name:"Inventory",         icon:"Package",     deps:[] },
  { key:"communication", name:"Communication",     icon:"MessageSquare",deps:[] },
  { key:"help_center",   name:"Help Center",       icon:"HelpCircle",  deps:[] },
  { key:"admissions",    name:"Admissions",        icon:"UserPlus",    deps:[] },
  { key:"fees",          name:"Finance & Fees",    icon:"Banknote",    deps:[] },
  { key:"exams",         name:"Exams",             icon:"ClipboardCheck",deps:[] },
  { key:"attendance",    name:"Attendance",        icon:"Calendar",    deps:[] },
  { key:"timetable",     name:"Timetable",         icon:"Clock",       deps:[] },
  { key:"study_center",  name:"Study Center",      icon:"BookOpen",    deps:[] },
  { key:"certificate",   name:"Certificate Center",icon:"Award",       deps:[] },
];

const DEPS: Record<string, string[]> = { inventory: ["fees"], hostel: ["fees"], transport: ["fees"] };

export async function adminModuleManagementRoutes(app: FastifyInstance) {
  const P = "/admin/settings/modules";

  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const configs = await prisma.moduleConfig.findMany({ where: { schoolId } });
    const configMap = Object.fromEntries(configs.map(c => [c.moduleKey, c]));
    const modules = ALL_MODULES.map(m => ({
      ...m,
      isEnabled: configMap[m.key]?.isEnabled ?? true,
      enabledAt: configMap[m.key]?.enabledAt ?? null,
      config:    configMap[m.key]?.config ?? {},
    }));
    return rep.send({ modules });
  });

  app.put(`${P}/:moduleKey`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const moduleKey = (req.params as any).moduleKey;
    const b = req.body as any;
    const isEnabled = b.isEnabled;

    // Dependency check on disable
    if (!isEnabled) {
      const dependents = ALL_MODULES.filter(m => (DEPS[m.key] ?? []).includes(moduleKey) && m.key !== moduleKey);
      const enabledDeps = [];
      for (const dep of dependents) {
        const cfg = await prisma.moduleConfig.findFirst({ where: { schoolId, moduleKey: dep.key } });
        if (cfg?.isEnabled !== false) enabledDeps.push(dep.name);
      }
      if (enabledDeps.length > 0) {
        return rep.code(409).send({ error: `Cannot disable — required by: ${enabledDeps.join(", ")}. Disable those first.` });
      }
    }

    const cfg = await prisma.moduleConfig.upsert({
      where: { schoolId_moduleKey: { schoolId, moduleKey } },
      create: { schoolId, moduleKey, isEnabled, enabledAt: isEnabled ? new Date() : null, config: b.config ?? {} },
      update: { isEnabled, enabledAt: isEnabled ? new Date() : undefined, config: b.config ?? {} },
    });
    return rep.send({ config: cfg });
  });

  app.put(`${P}/bulk`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any; // { modules: [{ key, isEnabled }] }
    for (const m of b.modules ?? []) {
      await prisma.moduleConfig.upsert({ where: { schoolId_moduleKey: { schoolId, moduleKey: m.key } }, create: { schoolId, moduleKey: m.key, isEnabled: m.isEnabled }, update: { isEnabled: m.isEnabled } });
    }
    return rep.send({ ok: true });
  });
}
