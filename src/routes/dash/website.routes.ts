
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma";
import { appAuth } from "../../middleware/appAuth";

// ── Simple in-memory rate limiter for the public endpoint ──
// (per-IP: max 5 inquiries / 10 min — enough for real users, blocks spam bursts)
const hits = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 5;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_HITS;
}
// periodic cleanup so the Map never grows unbounded
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
}, WINDOW_MS).unref();

// ── Validation helpers ──
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[0-9+\-\s()]{8,15}$/;
const INQUIRY_TYPES = ["DEMO_REQUEST", "CONTACT", "PRICING", "PARTNERSHIP"] as const;
const STATUSES = ["NEW", "CONTACTED", "DEMO_SCHEDULED", "CONVERTED", "CLOSED"] as const;

interface InquiryBody {
  type?: string;
  schoolName?: string;
  contactName?: string;
  designation?: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
  studentCount?: number | string;
  message?: string;
  source?: string;
  utmCampaign?: string;
  website?: string; // honeypot — real users never fill this hidden field
}

function validateInquiry(b: InquiryBody): { ok: true; data: any } | { ok: false; error: string } {
  if (b.website) return { ok: false, error: "Invalid submission" }; // bot filled the honeypot

  const schoolName = (b.schoolName || "").trim();
  const contactName = (b.contactName || "").trim();
  const email = (b.email || "").trim().toLowerCase();
  const phone = (b.phone || "").trim();

  if (schoolName.length < 3 || schoolName.length > 150) return { ok: false, error: "School name is required (3–150 chars)" };
  if (contactName.length < 2 || contactName.length > 100) return { ok: false, error: "Contact name is required" };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "A valid email is required" };
  if (!PHONE_RE.test(phone)) return { ok: false, error: "A valid phone number is required" };

  const type = INQUIRY_TYPES.includes(b.type as any) ? b.type : "CONTACT";
  const studentCount = b.studentCount != null && b.studentCount !== "" ? Math.max(0, Math.min(100000, Number(b.studentCount) || 0)) : null;

  return {
    ok: true,
    data: {
      type,
      schoolName,
      contactName,
      designation: (b.designation || "").trim().slice(0, 80) || null,
      email,
      phone,
      city: (b.city || "").trim().slice(0, 80) || null,
      state: (b.state || "").trim().slice(0, 80) || null,
      studentCount,
      message: (b.message || "").trim().slice(0, 2000) || null,
      source: (b.source || "").trim().slice(0, 60) || null,
      utmCampaign: (b.utmCampaign || "").trim().slice(0, 120) || null,
    },
  };
}

export default async function websiteRoutes(app: FastifyInstance) {
  // ═══════════════════════════════════════════════════════════
  // PUBLIC — no auth (marketing website calls these)
  // ═══════════════════════════════════════════════════════════

  // Submit an inquiry / book a demo
  app.post("/api/website/inquiry", async (req: FastifyRequest, reply: FastifyReply) => {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip;
    if (rateLimited(ip)) {
      return reply.code(429).send({ success: false, message: "Too many requests. Please try again in a few minutes." });
    }

    const result = validateInquiry(req.body as InquiryBody);
    if (!result.ok) return reply.code(400).send({ success: false, message: result.error });

    // Soft duplicate guard: same email inquiry within 24h → update instead of new row
    const existing = await prisma.websiteInquiry.findFirst({
      where: {
        email: result.data.email,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });

    const inquiry = existing
      ? await prisma.websiteInquiry.update({ where: { id: existing.id }, data: result.data })
      : await prisma.websiteInquiry.create({ data: result.data });

    // TODO (optional): fire email/WhatsApp notification to sales here

    return reply.code(201).send({
      success: true,
      message: "Thank you! Our team will reach out within 24 hours.",
      inquiryId: inquiry.id,
    });
  });

  // Lightweight health/uptime probe for the website
  app.get("/api/website/health", async () => ({ success: true, status: "ok" }));

  // ═══════════════════════════════════════════════════════════
  // SUPERADMIN — inquiry management (company panel)
  // ═══════════════════════════════════════════════════════════

  // List inquiries with filters + pagination
  app.get("/api/website/inquiries", { preHandler: [appAuth] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { role } = req as any;
    if (role !== "SUPER_ADMIN") return reply.code(403).send({ success: false, message: "Forbidden" });

    const q = req.query as { status?: string; type?: string; search?: string; page?: string; limit?: string };
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));

    const where: any = {};
    if (q.status && STATUSES.includes(q.status as any)) where.status = q.status;
    if (q.type && INQUIRY_TYPES.includes(q.type as any)) where.type = q.type;
    if (q.search) {
      where.OR = [
        { schoolName: { contains: q.search, mode: "insensitive" } },
        { contactName: { contains: q.search, mode: "insensitive" } },
        { email: { contains: q.search, mode: "insensitive" } },
        { phone: { contains: q.search } },
        { city: { contains: q.search, mode: "insensitive" } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.websiteInquiry.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.websiteInquiry.count({ where }),
    ]);

    return reply.send({ success: true, items, total, page, pages: Math.ceil(total / limit) });
  });

  // Pipeline stats for the dashboard
  app.get("/api/website/inquiries/stats", { preHandler: [appAuth] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { role } = req as any;
    if (role !== "SUPER_ADMIN") return reply.code(403).send({ success: false, message: "Forbidden" });

    const [byStatus, last30] = await Promise.all([
      prisma.websiteInquiry.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.websiteInquiry.count({ where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } }),
    ]);

    const stats: Record<string, number> = { NEW: 0, CONTACTED: 0, DEMO_SCHEDULED: 0, CONVERTED: 0, CLOSED: 0 };
    for (const row of byStatus) stats[row.status] = row._count._all;

    return reply.send({ success: true, stats, last30Days: last30 });
  });

  // Update status / add internal notes
  app.patch("/api/website/inquiries/:id", { preHandler: [appAuth] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { role, userId } = req as any;
    if (role !== "SUPER_ADMIN") return reply.code(403).send({ success: false, message: "Forbidden" });

    const { id } = req.params as { id: string };
    const body = req.body as { status?: string; notes?: string };

    const data: any = {};
    if (body.status) {
      if (!STATUSES.includes(body.status as any)) return reply.code(400).send({ success: false, message: "Invalid status" });
      data.status = body.status;
      data.handledById = userId;
    }
    if (body.notes !== undefined) data.notes = String(body.notes).slice(0, 5000);

    if (!Object.keys(data).length) return reply.code(400).send({ success: false, message: "Nothing to update" });

    const inquiry = await prisma.websiteInquiry.update({ where: { id }, data }).catch(() => null);
    if (!inquiry) return reply.code(404).send({ success: false, message: "Inquiry not found" });

    return reply.send({ success: true, inquiry });
  });

  // Delete (spam cleanup)
  app.delete("/api/website/inquiries/:id", { preHandler: [appAuth] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { role } = req as any;
    if (role !== "SUPER_ADMIN") return reply.code(403).send({ success: false, message: "Forbidden" });

    const { id } = req.params as { id: string };
    await prisma.websiteInquiry.delete({ where: { id } }).catch(() => null);
    return reply.send({ success: true });
  });
}