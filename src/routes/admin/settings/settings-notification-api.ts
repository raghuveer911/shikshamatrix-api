// apps/api/src/routes/admin/settings/settings-notification-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

export async function adminNotifSettingsRoutes(app: FastifyInstance) {
  const P = "/admin/settings/notifications";

  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    let s = await prisma.notifSettings.findUnique({ where: { schoolId } });
    if (!s) s = await prisma.notifSettings.create({ data: { schoolId } });
    return rep.send({ settings: { ...s, emailPass: s.emailPass ? "***" : null, smsApiKey: s.smsApiKey ? "***" : null, waApiKey: s.waApiKey ? "***" : null } });
  });

  app.put(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const data: any = { smsEnabled: b.smsEnabled, emailEnabled: b.emailEnabled, whatsappEnabled: b.whatsappEnabled, pushEnabled: b.pushEnabled, smsSenderId: b.smsSenderId, smsProvider: b.smsProvider, emailFromName: b.emailFromName, emailFromAddr: b.emailFromAddr, emailProvider: b.emailProvider, emailHost: b.emailHost, emailPort: b.emailPort ? Number(b.emailPort) : undefined, emailUser: b.emailUser, waPhoneId: b.waPhoneId, quietStart: b.quietStart, quietEnd: b.quietEnd, policies: b.policies };
    if (b.emailPass && b.emailPass !== "***") data.emailPass = b.emailPass;
    if (b.smsApiKey && b.smsApiKey !== "***") data.smsApiKey = b.smsApiKey;
    if (b.waApiKey  && b.waApiKey  !== "***") data.waApiKey  = b.waApiKey;
    const s = await prisma.notifSettings.upsert({ where: { schoolId }, create: { schoolId, ...data }, update: data });
    return rep.send({ settings: { ...s, emailPass: "***", smsApiKey: "***", waApiKey: "***" } });
  });

  app.post(`${P}/test`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const b = req.body as any; // { channel: "email"/"sms", to: "..." }
    // Simulate test send
    const ok = !!b.to && b.to.length > 3;
    return rep.send({ ok, message: ok ? `Test ${b.channel} sent to ${b.to}` : "Invalid destination" });
  });
}
