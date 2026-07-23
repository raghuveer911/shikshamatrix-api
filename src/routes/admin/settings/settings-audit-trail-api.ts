// apps/api/src/routes/admin/settings/settings-audit-trail-api.ts
// Uses EXISTING AuditLog model (more complete than new one)
// Existing fields: module(AuditModule enum), actionType(AuditActionType enum), 
//   entityId, entityLabel, beforeValue/afterValue, riskLevel, isSuspicious, occurredAt
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

export async function adminAuditTrailRoutes(app: FastifyInstance) {
  const P = "/admin/settings/audit";

  // LIST with filters
  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const q    = req.query as any;
    const page = Number(q.page ?? 1);
    const limit = 50;

    const where: any = { schoolId };

    // Use existing model fields (module=AuditModule enum, actionType=AuditActionType enum)
    if (q.module)     where.module     = q.module;     // AuditModule enum value
    if (q.actionType) where.actionType = q.actionType; // AuditActionType enum value
    if (q.userId)     where.userId     = Number(q.userId);
    if (q.riskLevel !== undefined) where.riskLevel = Number(q.riskLevel);
    if (q.isSuspicious === "true")  where.isSuspicious = true;

    if (q.from || q.to) {
      where.occurredAt = {};  // existing uses occurredAt not createdAt
      if (q.from) where.occurredAt.gte = new Date(q.from);
      if (q.to)   where.occurredAt.lte = new Date(q.to);
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { occurredAt: "desc" },   // existing uses occurredAt
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: { name: true, email: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return rep.send({ logs, total, page, pages: Math.ceil(total / limit) });
  });

  // CREATE audit log — called internally by other APIs
  app.post(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const b = req.body as any;

    const log = await prisma.auditLog.create({
      data: {
        schoolId,
        userId:      Number(userId),
        module:      b.module      as any,  // AuditModule enum
        actionType:  b.actionType  as any,  // AuditActionType enum
        action:      b.action      ?? b.description ?? "Action",
        entityId:    b.entityId    ? Number(b.entityId)  : null,
        entityType:  b.entityType  ?? null,
        entityLabel: b.entityLabel ?? null,
        beforeValue: b.beforeValue ?? b.oldValue ?? undefined,
        afterValue:  b.afterValue  ?? b.newValue ?? undefined,
        changeReason:b.changeReason ?? null,
        description: b.description  ?? null,
        ipAddress:   (req.headers["x-forwarded-for"] as string)?.split(",")[0] ?? req.ip ?? null,
        userAgent:   req.headers["user-agent"] ?? null,
        riskLevel:   b.riskLevel    ?? 0,
        metadata:    b.metadata     ?? undefined,
      },
    });
    return rep.code(201).send({ log });
  });

  // SUMMARY (30-day overview)
  app.get(`${P}/summary`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const from = new Date(Date.now() - 30 * 86400000);

    const [byModule, byActionType, byRiskLevel, suspicious, totalLogs] = await Promise.all([
      prisma.auditLog.groupBy({
        by: ["module"],
        where: { schoolId, occurredAt: { gte: from } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
      }),
      prisma.auditLog.groupBy({
        by: ["actionType"],
        where: { schoolId, occurredAt: { gte: from } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      }),
      prisma.auditLog.groupBy({
        by: ["riskLevel"],
        where: { schoolId, occurredAt: { gte: from } },
        _count: { id: true },
      }),
      prisma.auditLog.count({ where: { schoolId, isSuspicious: true, occurredAt: { gte: from } } }),
      prisma.auditLog.count({ where: { schoolId, occurredAt: { gte: from } } }),
    ]);

    // Active users (most activity)
    const topUsers = await prisma.auditLog.groupBy({
      by: ["userId"],
      where: { schoolId, occurredAt: { gte: from } },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 5,
    });
    const userIds = topUsers.map(u => u.userId).filter(Boolean) as number[];
    const users   = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } });
    const uMap    = Object.fromEntries(users.map(u => [u.id, u]));

    return rep.send({
      byModule,
      byActionType,
      byRiskLevel,
      suspicious,
      totalLogs,
      topUsers: topUsers.map(u => ({ ...u, user: u.userId ? uMap[u.userId] : null })),
    });
  });

  // GET available module enum values
  app.get(`${P}/meta`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    // These come from existing AuditModule and AuditActionType enums in your schema
    return rep.send({
      modules: [
        "STUDENTS","FEES","EXAMS","ATTENDANCE","HR","LIBRARY","HOSTEL",
        "TRANSPORT","INVENTORY","COMMUNICATION","ADMISSIONS","SETTINGS","HELP_CENTER","AUTH"
      ],
      actionTypes: [
        "CREATE","READ","UPDATE","DELETE","LOGIN","LOGOUT","EXPORT","IMPORT",
        "APPROVE","REJECT","PROMOTE","TRANSFER","PAYMENT","REFUND","PERMISSION_CHANGE"
      ],
      riskLevels: [
        { value:0, label:"Low" },
        { value:1, label:"Medium" },
        { value:2, label:"High" },
        { value:3, label:"Critical" },
      ],
    });
  });

  // SUSPICIOUS activity feed
  app.get(`${P}/suspicious`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const logs = await prisma.auditLog.findMany({
      where: { schoolId, isSuspicious: true },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { occurredAt: "desc" },
      take: 20,
    });
    return rep.send({ logs });
  });
}
