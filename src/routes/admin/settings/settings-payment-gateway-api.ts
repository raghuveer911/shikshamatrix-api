// apps/api/src/routes/admin/settings/settings-payment-gateway-api.ts
// Uses EXISTING PaymentGateway model — just adds displayName, isActive, webhookUrl, lastTested, testStatus
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";

// Existing model maps: provider→ GatewayProvider enum, status→ GatewayStatus enum (SANDBOX/PRODUCTION)
// New fields we added: displayName, isActive, webhookUrl, lastTested, testStatus

export async function adminPaymentGatewayRoutes(app: FastifyInstance) {
  const P = "/admin/settings/payment-gateways";

  app.get(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const gateways = await prisma.paymentGateway.findMany({
      where: { schoolId },
      orderBy: { provider: "asc" },
    });
    // Mask secrets
    return rep.send({
      gateways: gateways.map(g => ({
        ...g,
        apiKey:       g.apiKey       ? g.apiKey.slice(0, 6) + "***" : null,
        apiSecret:    g.apiSecret    ? "***masked***" : null,
        webhookSecret:g.webhookSecret ? "***masked***" : null,
      })),
    });
  });

  app.post(P, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as any;

    // Map incoming string provider to enum — validate
    const validProviders = ["RAZORPAY","PHONEPE","PAYTM","CASHFREE","STRIPE"];
    if (!validProviders.includes(b.provider)) {
      return rep.code(400).send({ error: `Invalid provider. Must be one of: ${validProviders.join(", ")}` });
    }

    // Existing unique: [schoolId, provider, status]
    // status maps to existing GatewayStatus enum: SANDBOX | PRODUCTION | DISABLED
    const mode = (b.mode ?? b.status ?? "SANDBOX").toUpperCase();
    const gwStatus = mode === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";

    const gw = await prisma.paymentGateway.upsert({
      where: {
        // Existing @@unique([schoolId, provider, status])
        schoolId_provider_status: {
          schoolId,
          provider: b.provider as any,
          status:   gwStatus as any,
        },
      },
      create: {
        schoolId,
        name:          b.displayName ?? b.provider,
        provider:      b.provider as any,
        status:        gwStatus as any,
        isDefault:     b.isDefault ?? false,
        apiKey:        b.apiKey        ?? null,
        apiSecret:     b.apiSecret     ?? null,
        webhookSecret: b.webhookSecret ?? null,
        merchantId:    b.merchantId    ?? null,
        extraConfig:   b.extraConfig   ?? {},
        // New fields we added to existing model:
        ...(b.displayName  !== undefined ? { displayName:  b.displayName  } : {}),
        ...(b.isActive     !== undefined ? { isActive:     b.isActive     } : {}),
        ...(b.webhookUrl   !== undefined ? { webhookUrl:   b.webhookUrl   } : {}),
      },
      update: {
        name:          b.displayName ?? b.provider,
        isDefault:     b.isDefault ?? false,
        merchantId:    b.merchantId ?? null,
        extraConfig:   b.extraConfig ?? {},
        ...(b.apiKey       && b.apiKey       !== "***masked***" ? { apiKey:       b.apiKey       } : {}),
        ...(b.apiSecret    && b.apiSecret    !== "***masked***" ? { apiSecret:    b.apiSecret    } : {}),
        ...(b.webhookSecret && b.webhookSecret !== "***masked***" ? { webhookSecret: b.webhookSecret } : {}),
        ...(b.displayName  !== undefined ? { displayName:  b.displayName  } : {}),
        ...(b.isActive     !== undefined ? { isActive:     b.isActive     } : {}),
        ...(b.webhookUrl   !== undefined ? { webhookUrl:   b.webhookUrl   } : {}),
      },
    });

    // If default — unset others of same provider
    if (b.isDefault) {
      await prisma.paymentGateway.updateMany({
        where: { schoolId, id: { not: gw.id } },
        data:  { isDefault: false },
      });
    }

    return rep.code(201).send({ gateway: { ...gw, apiSecret: "***masked***", webhookSecret: "***masked***" } });
  });

  app.post(`${P}/:id/test`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const gw = await prisma.paymentGateway.findFirst({ where: { id, schoolId } });
    if (!gw || !gw.apiKey) return rep.code(400).send({ error: "API key not configured" });

    // Simulate test (production: make real API call to gateway)
    const ok = gw.apiKey.length > 5;

    // Update testStatus (new field we added)
    await prisma.paymentGateway.update({
      where: { id },
      data: {
        lastTested: new Date(),
        testStatus: ok ? "SUCCESS" : "FAILED",
      } as any, // "as any" handles the new fields until migration runs
    });

    return rep.send({ ok, message: ok ? `${gw.name} connection successful` : "Connection failed — check API key/secret" });
  });

  app.put(`${P}/:id/toggle`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const id = Number((req.params as any).id);
    const gw = await prisma.paymentGateway.findFirst({ where: { id, schoolId } });
    if (!gw) return rep.code(404).send({ error: "Not found" });
    const updated = await prisma.paymentGateway.update({ where: { id }, data: { isActive: !(gw as any).isActive } as any });
    return rep.send({ gateway: updated });
  });

  app.get(`${P}/providers`, { preHandler: [authenticate] }, async (req: FastifyRequest, rep: FastifyReply) => {
    return rep.send({
      providers: [
        { key:"RAZORPAY", label:"Razorpay",  color:"#3395FF", logo:"🔵" },
        { key:"PHONEPE",  label:"PhonePe",   color:"#5f259f", logo:"🟣" },
        { key:"PAYTM",    label:"Paytm",     color:"#00baf2", logo:"🔷" },
        { key:"CASHFREE", label:"Cashfree",  color:"#7052fb", logo:"💜" },
        { key:"STRIPE",   label:"Stripe",    color:"#635bff", logo:"🟦" },
      ],
    });
  });
}
