// apps/api/src/routes/admin/settings/settings-backup-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

export async function adminBackupRoutes(app: FastifyInstance) {
  const P = "/admin/settings/backup";

  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [logs, schedule] = await Promise.all([
      prisma.backupLog.findMany({ where: { schoolId }, orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.backupSchedule.findUnique({ where: { schoolId } }),
    ]);
    return rep.send({ logs, schedule });
  });

  app.post(`${P}/manual`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const b = req.body as any;
    const log = await prisma.backupLog.create({ data: { schoolId, backupType: b.backupType ?? "DATABASE", trigger: "MANUAL", status: "PENDING", initiatedBy: Number(userId) } });
    // Simulate async completion (in prod, queue a job)
    setTimeout(async () => {
      await prisma.backupLog.update({ where: { id: log.id }, data: { status: "SUCCESS", completedAt: new Date(), sizeBytes: BigInt(Math.floor(Math.random() * 50000000) + 1000000) } });
    }, 3000);
    return rep.code(201).send({ log, message: "Backup initiated" });
  });

  app.put(`${P}/schedule`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const next = new Date(); next.setDate(next.getDate() + (b.frequency === "WEEKLY" ? 7 : b.frequency === "MONTHLY" ? 30 : 1));
    const sched = await prisma.backupSchedule.upsert({
      where: { schoolId },
      create: { schoolId, frequency: b.frequency ?? "DAILY", backupType: b.backupType ?? "DATABASE", runAt: b.runAt ?? "02:00", isEnabled: b.isEnabled ?? true, nextRun: next },
      update: { frequency: b.frequency, backupType: b.backupType, runAt: b.runAt, isEnabled: b.isEnabled, nextRun: next },
    });
    return rep.send({ schedule: sched });
  });
}
