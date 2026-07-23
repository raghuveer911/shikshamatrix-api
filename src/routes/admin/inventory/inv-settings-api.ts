// apps/api/src/routes/admin/inventory/inv-settings-api.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminInvSettingsRoutes(app: FastifyInstance) {
  const P = "/admin/inventory/settings";

  app.get(P, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    let settings = await prisma.invSettings.findUnique({ where: { schoolId } });
    if (!settings) settings = await prisma.invSettings.create({ data: { schoolId } });
    return rep.send({ settings });
  });

  app.put(P, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;
    const settings = await prisma.invSettings.upsert({
      where: { schoolId },
      create: { schoolId, ...b },
      update: {
        itemCodePrefix: b.itemCodePrefix, vendorCodePrefix: b.vendorCodePrefix,
        requestCodePrefix: b.requestCodePrefix, maintenanceCodePrefix: b.maintenanceCodePrefix, auditCodePrefix: b.auditCodePrefix,
        requireApproval: b.requireApproval, approvalLevels: b.approvalLevels ? Number(b.approvalLevels) : undefined,
        purchaseOrderRequired: b.purchaseOrderRequired,
        defaultMinimumStock: b.defaultMinimumStock ? Number(b.defaultMinimumStock) : undefined,
        defaultReorderLevel: b.defaultReorderLevel ? Number(b.defaultReorderLevel) : undefined,
        autoLowStockAlert: b.autoLowStockAlert,
        requireReturnDate: b.requireReturnDate, allowSelfAssignment: b.allowSelfAssignment,
        maxAssignmentsPerStaff: b.maxAssignmentsPerStaff ? Number(b.maxAssignmentsPerStaff) : undefined,
        warrantyAlertDays: b.warrantyAlertDays ? Number(b.warrantyAlertDays) : undefined,
        amcRenewalAlertDays: b.amcRenewalAlertDays ? Number(b.amcRenewalAlertDays) : undefined,
        auditFrequencyMonths: b.auditFrequencyMonths ? Number(b.auditFrequencyMonths) : undefined,
        requireAuditApproval: b.requireAuditApproval,
        rolePermissions: b.rolePermissions,
        notifyLowStock: b.notifyLowStock, notifyWarrantyExpiry: b.notifyWarrantyExpiry,
        notifyAmcRenewal: b.notifyAmcRenewal, notifyPurchaseApproval: b.notifyPurchaseApproval,
      },
    });
    return rep.send({ settings });
  });

  app.post(`${P}/reset`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    await prisma.invSettings.deleteMany({ where: { schoolId } });
    const settings = await prisma.invSettings.create({ data: { schoolId } });
    return rep.send({ settings, message: "Settings reset to defaults" });
  });

  app.get(`${P}/integrations`, { preHandler: [authenticate, requireCapability('inventory.core')] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const [staff, vendors, commTemplates, items] = await Promise.all([
      prisma.staff.count({ where: { schoolId, isActive: true } }),
      prisma.invVendor.count({ where: { schoolId, status: "ACTIVE" } }),
      prisma.commTemplate.count({ where: { schoolId, isActive: true } }).catch(() => 0),
      prisma.invItem.count({ where: { schoolId, isActive: true } }),
    ]);
    return rep.send({ integrations: {
      hrModule:          { connected: true,  count: staff,        label: "Staff & Teachers (HR)" },
      vendorDirectory:   { connected: vendors > 0, count: vendors, label: "Vendor Directory" },
      commEngine:        { connected: true,  count: commTemplates, label: "Communication Engine" },
      inventoryCore:     { connected: true,  count: items,        label: "Inventory Core Engine" },
      accountsModule:    { connected: false, count: 0,            label: "Accounts (Vendor Payments)" },
      libraryModule:     { connected: false, count: 0,            label: "Library Assets" },
    }});
  });
}
