// apps/api/src/routes/admin/inventory/inv-purchase-requests-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

async function nextCode(schoolId: number, prefix: string, model: any): Promise<string> {
  const count = await model.count({ where: { schoolId } });
  return `${prefix}-${String(count + 1).padStart(5, "0")}`;
}

export async function adminInvPurchaseRequestRoutes(app: FastifyInstance) {
  const P = "/admin/inventory/purchase-requests";

  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [draft, pending, approved, ordered, rejected] = await Promise.all([
        prisma.invPurchaseRequest.count({ where: { schoolId, status: "DRAFT" } }),
        prisma.invPurchaseRequest.count({ where: { schoolId, status: "PENDING" } }),
        prisma.invPurchaseRequest.count({ where: { schoolId, status: "APPROVED" } }),
        prisma.invPurchaseRequest.count({ where: { schoolId, status: "ORDERED" } }),
        prisma.invPurchaseRequest.count({ where: { schoolId, status: "REJECTED" } }),
      ]);
      const budgetAgg = await prisma.invPurchaseRequest.aggregate({ where: { schoolId, status: { in: ["APPROVED","ORDERED","RECEIVED"] } }, _sum: { approvedBudget: true, actualCost: true } });
      const recentReqs = await prisma.invPurchaseRequest.findMany({ where: { schoolId }, include: { items: true, requestedBy: { include: { user: { select: { name: true } } } } }, orderBy: { createdAt: "desc" }, take: 8 });
      return rep.send({ kpis: { draft, pending, approved, ordered, rejected, totalApprovedBudget: Number(budgetAgg._sum.approvedBudget ?? 0), totalActualCost: Number(budgetAgg._sum.actualCost ?? 0) }, recentReqs });
    }
  );

  app.get(P, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const where: any = { schoolId };
      if (q.status)   where.status   = q.status;
      if (q.priority) where.priority = q.priority;
      if (q.search)   where.OR = [{ title: { contains: q.search, mode: "insensitive" } }, { requestCode: { contains: q.search } }];
      const [requests, total] = await Promise.all([
        prisma.invPurchaseRequest.findMany({ where, include: { items: true, vendor: { select: { name: true } }, requestedBy: { include: { user: { select: { name: true } } } } }, orderBy: [{ priority: "desc" }, { createdAt: "desc" }], skip: (Number(q.page ?? 1) - 1) * 50, take: 50 }),
        prisma.invPurchaseRequest.count({ where }),
      ]);
      return rep.send({ requests, total });
    }
  );

  app.post(P, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const settings = await prisma.invSettings.findUnique({ where: { schoolId } });
      const code = await nextCode(schoolId, settings?.requestCodePrefix ?? "PR", prisma.invPurchaseRequest);
      const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId }, select: { id: true } });
      const req_ = await prisma.invPurchaseRequest.create({
        data: {
          schoolId, requestCode: code, title: b.title, requestSource: b.requestSource ?? "Administration",
          departmentName: b.departmentName ?? null, priority: b.priority as any ?? "MEDIUM",
          status: b.status as any ?? "DRAFT", justification: b.justification ?? null,
          estimatedCost: b.estimatedCost ? Number(b.estimatedCost) : null, requestedById: staff?.id ?? null,
          notes: b.notes ?? null,
          items: { create: (b.items ?? []).map((i: any) => ({ itemId: i.itemId ? Number(i.itemId) : null, itemName: i.itemName ?? i.name ?? "", quantity: Number(i.quantity), unitPrice: i.unitPrice ? Number(i.unitPrice) : null, totalPrice: i.unitPrice ? Number(i.unitPrice) * Number(i.quantity) : null })) },
        },
        include: { items: true },
      });
      return rep.code(201).send({ request: req_ });
    }
  );

  app.put(`${P}/:id`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const b = req.body as any;
      const req_ = await prisma.invPurchaseRequest.update({
        where: { id, schoolId },
        data: { title: b.title, requestSource: b.requestSource, priority: b.priority as any, justification: b.justification, estimatedCost: b.estimatedCost ? Number(b.estimatedCost) : undefined, notes: b.notes, vendorId: b.vendorId ? Number(b.vendorId) : undefined, invoiceNo: b.invoiceNo },
      });
      return rep.send({ request: req_ });
    }
  );

  // Workflow transitions
  const workflowAction = (action: string) => async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId, userId } = req.user as any;
    const id = Number((req.params as any).id);
    const b = req.body as any;
    const staff = await prisma.staff.findFirst({ where: { userId: Number(userId), schoolId }, select: { id: true } });
    const now = new Date();
    const data: any = {};
    if (action === "submit")   { data.status = "PENDING"; }
    if (action === "approve")  { data.status = "APPROVED";  data.approvedById = staff?.id; data.approvedAt = now; data.approvedBudget = b.approvedBudget ? Number(b.approvedBudget) : undefined; }
    if (action === "reject")   { data.status = "REJECTED";  data.rejectedById = staff?.id; data.rejectedAt = now; data.rejectionNote = b.reason ?? "Rejected"; }
    if (action === "order")    { data.status = "ORDERED";   data.orderedAt = now; data.vendorId = b.vendorId ? Number(b.vendorId) : undefined; data.invoiceNo = b.invoiceNo; }
    if (action === "receive")  { data.status = "RECEIVED";  data.receivedAt = now; data.actualCost = b.actualCost ? Number(b.actualCost) : undefined; }
    if (action === "close")    { data.status = "CLOSED";    data.closedAt = now; }
    const req_ = await prisma.invPurchaseRequest.update({ where: { id, schoolId }, data });
    return rep.send({ request: req_ });
  };

  app.post(`${P}/:id/submit`,  { preHandler: [authenticate, requireCapability('inventory.core')] }, workflowAction("submit"));
  app.post(`${P}/:id/approve`, { preHandler: [authenticate, requireCapability('inventory.core')] }, workflowAction("approve"));
  app.post(`${P}/:id/reject`,  { preHandler: [authenticate, requireCapability('inventory.core')] }, workflowAction("reject"));
  app.post(`${P}/:id/order`,   { preHandler: [authenticate, requireCapability('inventory.core')] }, workflowAction("order"));
  app.post(`${P}/:id/receive`, { preHandler: [authenticate, requireCapability('inventory.core')] }, workflowAction("receive"));
  app.post(`${P}/:id/close`,   { preHandler: [authenticate, requireCapability('inventory.core')] }, workflowAction("close"));

  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('inventory.core')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const byStatus = await prisma.invPurchaseRequest.groupBy({ by: ["status"], where: { schoolId }, _count: { id: true }, _sum: { estimatedCost: true, actualCost: true } });
      const byPriority = await prisma.invPurchaseRequest.groupBy({ by: ["priority"], where: { schoolId }, _count: { id: true } });
      const bySource = await prisma.invPurchaseRequest.groupBy({ by: ["requestSource"], where: { schoolId }, _count: { id: true }, orderBy: { _count: { id: "desc" } } });
      return rep.send({ byStatus, byPriority, bySource });
    }
  );
}
