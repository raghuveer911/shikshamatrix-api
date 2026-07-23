import { FastifyInstance, FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";

export async function registerSecurity(app: FastifyInstance) {
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    errorResponseBuilder: (
      _req: FastifyRequest,
      context: { ttl: number }
    ) => ({
      success: false,
      error: "Rate limit exceeded",
      message: `Too many requests. Try again in ${Math.ceil(
        context.ttl / 1000
      )} seconds.`,
    }),
  });

  await app.register(sensible);
}