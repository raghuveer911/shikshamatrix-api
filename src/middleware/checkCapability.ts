// middleware/checkCapability.ts
// Usage: fastify.get('/api/library/digital', { preHandler: requireCapability('library.digital') }, handler)

import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';

type CapabilityMap = Record<string, boolean>;

const planCache = new Map<number, { capabilities: CapabilityMap; status: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 min — avoids a DB hit on every single request

export function requireCapability(capabilityKey: string) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    const { schoolId } = request.user as { schoolId: number };

    let cached = planCache.get(schoolId);
    if (!cached || cached.expiresAt < Date.now()) {
      const sub = await prisma.schoolSubscription.findUnique({
        where: { schoolId },
        include: { plan: true },
      });

      if (!sub) {
        return reply.code(402).send({ error: 'NO_SUBSCRIPTION', message: 'No active subscription found.' });
      }

      cached = {
        capabilities: sub.plan.capabilities as CapabilityMap,
        status: sub.status,
        expiresAt: Date.now() + CACHE_TTL_MS,
      };
      planCache.set(schoolId, cached);
    }

    if (cached.status === 'EXPIRED' || cached.status === 'CANCELLED') {
      return reply.code(402).send({
        error: 'SUBSCRIPTION_INACTIVE',
        message: 'Your subscription has expired. Please renew to continue.',
      });
    }

    if (!cached.capabilities[capabilityKey]) {
      return reply.code(403).send({
        error: 'FEATURE_LOCKED',
        message: 'This feature requires a higher plan.',
        requiredCapability: capabilityKey,
      });
    }
  };
}

// Call this whenever a plan is upgraded/downgraded/renewed so the cache doesn't
// serve stale capabilities for up to a minute after a change.
export function invalidateCapabilityCache(schoolId: number) {
  planCache.delete(schoolId);
}