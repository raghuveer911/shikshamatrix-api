import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authenticateSuperAdmin } from "../../middleware/authenticate.js";
import { prisma } from "../../lib/prisma.js";

export async function superAdminDiscountRoutes(app: FastifyInstance) {

  // ── GET /superadmin/discounts ───────────────────────────
  // List all discount codes with quick redemption stats.
  app.get(
    "/superadmin/discounts",
    { preHandler: [authenticateSuperAdmin] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const codes = await prisma.discountCode.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          targetSchool: { select: { id: true, name: true } },
          _count: { select: { redemptions: true } },
        },
      });

      return reply.send({ success: true, data: { codes } });
    }
  );

  // ── GET /superadmin/discounts/:id ───────────────────────
  // Full detail + redemption history for one code.
  app.get(
    "/superadmin/discounts/:id",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const code = await prisma.discountCode.findUnique({
        where: { id: parseInt(id) },
        include: {
          targetSchool: { select: { id: true, name: true } },
          redemptions: {
            orderBy: { redeemedAt: "desc" },
            include: { school: { select: { id: true, name: true } } },
          },
        },
      });

      if (!code) {
        return reply.status(404).send({ success: false, message: "Discount code not found." });
      }

      return reply.send({ success: true, data: { code } });
    }
  );

  // ── POST /superadmin/discounts ──────────────────────────
  // Create a new discount code — either a global campaign code or a
  // one-off code targeted at a single school.
  app.post(
    "/superadmin/discounts",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { superAdminId } = request.user as any;
      const body = request.body as {
        code: string;
        type: "PERCENTAGE" | "FLAT";
        value: number;
        scope: "GLOBAL" | "SCHOOL_SPECIFIC";
        targetSchoolId?: number;
        minTier?: "ECONOMY" | "ESSENTIAL" | "PROFESSIONAL";
        maxRedemptions?: number | null;
        maxRedemptionsPerSchool?: number;
        applyTo?: "FIRST_CYCLE" | "LIFETIME";
        validFrom?: string;
        validTo?: string | null;
        note?: string;
      };

      if (!body.code?.trim() || !body.type || body.value == null || !body.scope) {
        return reply.status(400).send({ success: false, message: "code, type, value, and scope are required." });
      }
      if (body.scope === "SCHOOL_SPECIFIC" && !body.targetSchoolId) {
        return reply.status(400).send({ success: false, message: "targetSchoolId is required for a school-specific code." });
      }
      if (body.type === "PERCENTAGE" && (body.value <= 0 || body.value > 100)) {
        return reply.status(400).send({ success: false, message: "Percentage value must be between 1 and 100." });
      }

      const normalizedCode = body.code.trim().toUpperCase();

      const existing = await prisma.discountCode.findUnique({ where: { code: normalizedCode } });
      if (existing) {
        return reply.status(409).send({ success: false, message: `Code "${normalizedCode}" already exists.` });
      }

      const created = await prisma.discountCode.create({
        data: {
          code: normalizedCode,
          type: body.type,
          value: body.value,
          scope: body.scope,
          targetSchoolId: body.scope === "SCHOOL_SPECIFIC" ? body.targetSchoolId : null,
          minTier: body.minTier ?? null,
          maxRedemptions: body.maxRedemptions ?? null,
          maxRedemptionsPerSchool: body.maxRedemptionsPerSchool ?? 1,
          applyTo: body.applyTo ?? "FIRST_CYCLE",
          validFrom: body.validFrom ? new Date(body.validFrom) : new Date(),
          validTo: body.validTo ? new Date(body.validTo) : null,
          note: body.note ?? null,
          createdByAdminId: superAdminId,
        },
      });

      return reply.send({ success: true, message: `Discount code "${normalizedCode}" created.`, data: { code: created } });
    }
  );

  // ── PATCH /superadmin/discounts/:id ─────────────────────
  // Update a code — most commonly toggling isActive (kill-switch) or
  // adjusting expiry/limits. The code string itself and past redemptions
  // are never altered here.
  app.patch(
    "/superadmin/discounts/:id",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        isActive?: boolean;
        validTo?: string | null;
        maxRedemptions?: number | null;
        maxRedemptionsPerSchool?: number;
        note?: string;
      };

      const existing = await prisma.discountCode.findUnique({ where: { id: parseInt(id) } });
      if (!existing) {
        return reply.status(404).send({ success: false, message: "Discount code not found." });
      }

      const updated = await prisma.discountCode.update({
        where: { id: parseInt(id) },
        data: {
          ...(body.isActive !== undefined && { isActive: body.isActive }),
          ...(body.validTo !== undefined && { validTo: body.validTo ? new Date(body.validTo) : null }),
          ...(body.maxRedemptions !== undefined && { maxRedemptions: body.maxRedemptions }),
          ...(body.maxRedemptionsPerSchool !== undefined && { maxRedemptionsPerSchool: body.maxRedemptionsPerSchool }),
          ...(body.note !== undefined && { note: body.note }),
        },
      });

      return reply.send({ success: true, message: "Discount code updated.", data: { code: updated } });
    }
  );

  // ── DELETE /superadmin/discounts/:id ────────────────────
  // Only allowed if the code has never been redeemed — otherwise the
  // audit trail would break. Deactivate instead (PATCH isActive:false)
  // for a code that's already been used.
  app.delete(
    "/superadmin/discounts/:id",
    { preHandler: [authenticateSuperAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const discountId = parseInt(id);

      const redemptionCount = await prisma.discountRedemption.count({ where: { discountCodeId: discountId } });
      if (redemptionCount > 0) {
        return reply.status(409).send({
          success: false,
          message: "This code has already been redeemed and can't be deleted — deactivate it instead.",
        });
      }

      await prisma.discountCode.delete({ where: { id: discountId } });
      return reply.send({ success: true, message: "Discount code deleted." });
    }
  );
}
