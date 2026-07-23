// apps/api/src/routes/admin/settings/settings-admission-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

export async function adminAdmissionSettingsRoutes(app: FastifyInstance) {
  const P = "/admin/settings/admissions";

  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    let s = await prisma.admissionSettings.findUnique({ where: { schoolId } });
    if (!s) s = await prisma.admissionSettings.create({ data: { schoolId } });
    return rep.send({ settings: s });
  });

  app.put(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const s = await prisma.admissionSettings.upsert({
      where: { schoolId },
      create: { schoolId, ...b },
      update: { admissionNoFormat: b.admissionNoFormat, rollNoFormat: b.rollNoFormat, defaultStatus: b.defaultStatus, workflowSteps: b.workflowSteps, mandatoryDocs: b.mandatoryDocs, autoApprove: b.autoApprove, requireApproval: b.requireApproval, allowOnlineAdmission: b.allowOnlineAdmission, sequenceStart: b.sequenceStart ? Number(b.sequenceStart) : undefined },
    });
    return rep.send({ settings: s });
  });

  app.post(`${P}/preview-number`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const s = await prisma.admissionSettings.findUnique({ where: { schoolId } });
    const year = new Date().getFullYear();
    const session = `${year}-${String(year + 1).slice(2)}`;
    const preview = (s?.admissionNoFormat ?? "ADM-{SESSION}-{NUMBER}").replace("{SESSION}", session).replace("{NUMBER}", String(s?.sequenceStart ?? 1).padStart(4, "0"));
    return rep.send({ preview });
  });
}
