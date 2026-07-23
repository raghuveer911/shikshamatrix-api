// apps/api/src/routes/admin/settings/settings-custom-fields-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

function toKey(name: string) { return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_|_$)/g, ""); }

export async function adminCustomFieldsRoutes(app: FastifyInstance) {
  const P = "/admin/settings/custom-fields";

  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q = req.query as any;
    const where: any = { schoolId, isActive: true };
    if (q.module) where.module = q.module;
    const fields = await prisma.customField.findMany({ where, orderBy: [{ module: "asc" }, { sortOrder: "asc" }], include: { _count: { select: { values: true } } } });
    return rep.send({ fields });
  });

  app.post(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const fieldKey = b.fieldKey ?? toKey(b.fieldName);
    const maxOrder = await prisma.customField.aggregate({ where: { schoolId, module: b.module }, _max: { sortOrder: true } });
    const field = await prisma.customField.upsert({
      where: { schoolId_module_fieldKey: { schoolId, module: b.module, fieldKey } },
      create: { schoolId, module: b.module, fieldName: b.fieldName, fieldKey, fieldType: b.fieldType as any ?? "TEXT", options: b.options ?? [], isRequired: b.isRequired ?? false, placeholder: b.placeholder ?? null, helpText: b.helpText ?? null, sortOrder: (maxOrder._max.sortOrder ?? 0) + 1 },
      update: { fieldName: b.fieldName, fieldType: b.fieldType as any, options: b.options, isRequired: b.isRequired, placeholder: b.placeholder, helpText: b.helpText },
    });
    return rep.code(201).send({ field });
  });

  app.put(`${P}/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const field = await prisma.customField.update({ where: { id, schoolId }, data: { fieldName: b.fieldName, fieldType: b.fieldType as any, options: b.options, isRequired: b.isRequired, placeholder: b.placeholder, helpText: b.helpText, sortOrder: b.sortOrder !== undefined ? Number(b.sortOrder) : undefined, isActive: b.isActive } });
    return rep.send({ field });
  });

  app.delete(`${P}/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    await prisma.customField.update({ where: { id, schoolId }, data: { isActive: false } });
    return rep.send({ ok: true });
  });

  // Set value for a record
  app.post(`${P}/:id/values`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const val = await prisma.customFieldValue.upsert({ where: { customFieldId_recordId: { customFieldId: id, recordId: Number(b.recordId) } }, create: { customFieldId: id, recordId: Number(b.recordId), value: b.value ?? null }, update: { value: b.value ?? null } });
    return rep.send({ value: val });
  });

  // Get values for a record
  app.get(`${P}/values/:module/:recordId`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { module, recordId } = req.params as any;
    const fields = await prisma.customField.findMany({ where: { schoolId, module, isActive: true }, include: { values: { where: { recordId: Number(recordId) } } }, orderBy: { sortOrder: "asc" } });
    return rep.send({ fields: fields.map(f => ({ ...f, value: f.values[0]?.value ?? null })) });
  });
}
