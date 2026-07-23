// apps/api/src/routes/admin/settings/settings-biometric-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

export async function adminBiometricRoutes(app: FastifyInstance) {
  const P = "/admin/settings/biometric";

  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const devices = await prisma.biometricDevice.findMany({ where: { schoolId }, orderBy: { deviceName: "asc" } });
    return rep.send({ devices });
  });

  app.post(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const count = await prisma.biometricDevice.count({ where: { schoolId } });
    const code  = b.deviceCode ?? `BIO-${String(count + 1).padStart(3, "0")}`;
    const device = await prisma.biometricDevice.create({ data: { schoolId, deviceName: b.deviceName, deviceCode: code, brand: b.brand ?? "ZKTECO", model: b.model ?? null, ipAddress: b.ipAddress, port: b.port ? Number(b.port) : 4370, location: b.location ?? null, purpose: b.purpose ?? "BOTH" } });
    return rep.code(201).send({ device });
  });

  app.put(`${P}/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const b  = req.body as any;
    const device = await prisma.biometricDevice.update({ where: { id, schoolId }, data: { deviceName: b.deviceName, brand: b.brand, model: b.model, ipAddress: b.ipAddress, port: b.port ? Number(b.port) : undefined, location: b.location, purpose: b.purpose, isActive: b.isActive } });
    return rep.send({ device });
  });

  app.post(`${P}/:id/sync`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    // Simulate sync (real impl: TCP connection to ZKTeco)
    const ok = true;
    await prisma.biometricDevice.update({ where: { id, schoolId }, data: { lastSync: new Date(), syncStatus: ok ? "SUCCESS" : "FAILED", syncMessage: ok ? "Sync completed — 42 new records" : "Connection refused", totalLogs: { increment: ok ? 42 : 0 } } });
    return rep.send({ ok, message: ok ? "Sync completed" : "Sync failed" });
  });

  app.delete(`${P}/:id`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    await prisma.biometricDevice.update({ where: { id, schoolId }, data: { isActive: false } });
    return rep.send({ ok: true });
  });
}
