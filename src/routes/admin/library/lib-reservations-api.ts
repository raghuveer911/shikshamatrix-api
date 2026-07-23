// apps/api/src/routes/admin/library/lib-reservations-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ── Priority helper (lower = higher priority) ────────────────
function memberPriority(memberType: string, rule: any): number {
  if (memberType === "TEACHER") return rule?.teacherPriority ?? 10;
  if (memberType === "STAFF")   return rule?.staffPriority   ?? 30;
  return                               rule?.studentPriority  ?? 50;
}

// ── Recalculate queue positions for a book ──────────────────
async function rebuildQueue(bookId: number, schoolId: number) {
  const active = await prisma.libReservation.findMany({
    where: { bookId, schoolId, status: { in: ["PENDING","WAITING"] } },
    orderBy: [{ priority: "asc" }, { reservedAt: "asc" }],
  });

  await Promise.all(active.map((r, i) =>
    prisma.libReservation.update({ where: { id: r.id }, data: { queuePosition: i + 1 } })
  ));
}

export async function adminLibReservationsRoutes(app: FastifyInstance) {
  const P = "/admin/library/reservations";

  // ─── DASHBOARD ────────────────────────────────────────────
  app.get(`${P}/dashboard`, { preHandler: [authenticate, requireCapability('library.reservations')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [active, waiting, fulfilled, expired, available] = await Promise.all([
        prisma.libReservation.count({ where: { schoolId, status: { in: ["PENDING","WAITING"] } } }),
        prisma.libReservation.count({ where: { schoolId, status: "WAITING" } }),
        prisma.libReservation.count({ where: { schoolId, status: "COLLECTED" } }),
        prisma.libReservation.count({ where: { schoolId, status: "EXPIRED" } }),
        prisma.libReservation.count({ where: { schoolId, status: "AVAILABLE" } }),
      ]);

      // Books with most reservations
      const mostReserved = await prisma.libReservation.groupBy({
        by: ["bookId"],
        where: { schoolId, status: { in: ["PENDING","WAITING","AVAILABLE"] } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 6,
      });
      const bookIds = mostReserved.map(r => r.bookId);
      const books   = await prisma.libBook.findMany({ where: { id: { in: bookIds } }, select: { id: true, title: true, author: { select: { name: true } } } });
      const bookMap = Object.fromEntries(books.map(b => [b.id, b]));

      // Ready to collect
      const readyToCollect = await prisma.libReservation.findMany({
        where: { schoolId, status: "AVAILABLE" },
        include: {
          book:    { select: { title: true } },
          student: { include: { user: { select: { name: true } }, class: { select: { name: true } } } },
          staff:   { include: { user: { select: { name: true } } } },
        },
        orderBy: { availableAt: "asc" },
        take: 8,
      });

      // Expiring soon (within 24h)
      const soonExpiry = await prisma.libReservation.findMany({
        where: { schoolId, status: "AVAILABLE", expiresAt: { lt: new Date(Date.now() + 86400000), gt: new Date() } },
        include: { book: { select: { title: true } } },
        take: 5,
      });

      return rep.send({
        kpis: { active, waiting, fulfilled, expired, available },
        mostReserved: mostReserved.map(r => ({ ...r, book: bookMap[r.bookId], count: r._count.id })),
        readyToCollect, soonExpiry,
      });
    }
  );

  // ─── LIST RESERVATIONS ────────────────────────────────────
  app.get(P, { preHandler: [authenticate, requireCapability('library.reservations')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;
      const page  = Number(q.page  ?? 1);
      const limit = Number(q.limit ?? 50);

      const where: any = { schoolId };
      if (q.status)     where.status     = q.status;
      if (q.bookId)     where.bookId     = Number(q.bookId);
      if (q.memberType) where.memberType = q.memberType;
      if (q.search) {
        where.OR = [
          { student: { user: { name: { contains: q.search, mode: "insensitive" } } } },
          { staff:   { user: { name: { contains: q.search, mode: "insensitive" } } } },
          { book:    { title: { contains: q.search, mode: "insensitive" } } },
        ];
      }

      const [reservations, total] = await Promise.all([
        prisma.libReservation.findMany({
          where,
          include: {
            book:    { select: { id: true, title: true, isbn: true } },
            student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } },
            staff:   { include: { user: { select: { name: true, avatarUrl: true, role: true } } } },
          },
          orderBy: [{ queuePosition: "asc" }, { reservedAt: "asc" }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.libReservation.count({ where }),
      ]);

      return rep.send({ reservations, total, page, pages: Math.ceil(total / limit) });
    }
  );

  // ─── QUEUE FOR A SPECIFIC BOOK ────────────────────────────
  app.get(`${P}/book/:bookId/queue`, { preHandler: [authenticate, requireCapability('library.reservations')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const bookId = Number((req.params as any).bookId);

      const queue = await prisma.libReservation.findMany({
        where: { schoolId, bookId, status: { in: ["PENDING","WAITING","AVAILABLE"] } },
        include: {
          student: { include: { user: { select: { name: true, avatarUrl: true } }, class: { select: { name: true } } } },
          staff:   { include: { user: { select: { name: true, avatarUrl: true, role: true } } } },
        },
        orderBy: [{ queuePosition: "asc" }],
      });

      const availableCopies = await prisma.libBookCopy.count({ where: { bookId, schoolId, status: "AVAILABLE" } });

      return rep.send({ queue, availableCopies });
    }
  );

  // ─── CREATE RESERVATION ───────────────────────────────────
  app.post(P, { preHandler: [authenticate, requireCapability('library.reservations')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;

      const bookId     = Number(b.bookId);
      const memberId   = Number(b.memberId);
      const memberType = b.memberType as string;

      // Check member not already has this book reserved
      const existingWhere: any = { schoolId, bookId, status: { in: ["PENDING","WAITING","AVAILABLE"] } };
      if (memberType === "STUDENT") existingWhere.studentId = memberId;
      else                          existingWhere.staffId   = memberId;

      const existing = await prisma.libReservation.findFirst({ where: existingWhere });
      if (existing) return rep.code(409).send({ error: "Member already has an active reservation for this book", reservation: existing });

      // Check member reservation limit
      const rule = await prisma.libReservationRule.findUnique({ where: { schoolId } });
      const maxRes = memberType === "TEACHER" ? (rule?.maxReservationsTeacher ?? 5)
        : memberType === "STAFF" ? (rule?.maxReservationsStaff ?? 2)
        : (rule?.maxReservationsStudent ?? 2);

      const activeCount = await prisma.libReservation.count({
        where: {
          schoolId, status: { in: ["PENDING","WAITING","AVAILABLE"] },
          ...(memberType === "STUDENT" ? { studentId: memberId } : { staffId: memberId }),
        },
      });
      if (activeCount >= maxRes) return rep.code(409).send({ error: `Reservation limit reached (${maxRes})` });

      // Get current queue length
      const queueLength = await prisma.libReservation.count({
        where: { schoolId, bookId, status: { in: ["PENDING","WAITING"] } },
      });

      // Check if any copy is immediately available
      const availableCopy = await prisma.libBookCopy.findFirst({ where: { schoolId, bookId, status: "AVAILABLE" } });
      const status = availableCopy ? "AVAILABLE" : "WAITING";
      const availableAt = availableCopy ? new Date() : null;

      const validityMs = (rule?.collectionWindowHours ?? 48) * 3600000;

      const reservation = await prisma.libReservation.create({
        data: {
          schoolId, bookId,
          memberType:   memberType as any,
          studentId:    memberType === "STUDENT" ? memberId : null,
          staffId:      memberType !== "STUDENT" ? memberId : null,
          queuePosition: status === "AVAILABLE" ? 0 : queueLength + 1,
          priority:     memberPriority(memberType, rule),
          status:       status as any,
          availableAt,
          expiresAt:    availableCopy ? new Date(Date.now() + validityMs) : null,
        },
        include: {
          book:    { select: { title: true } },
          student: { include: { user: { select: { name: true } } } },
          staff:   { include: { user: { select: { name: true } } } },
        },
      });

      // If copy available, notify via Communication Engine
      if (availableCopy && rule?.notifyOnAvailable) {
        // In production: fire to Communication Engine
        // await notifyMember(reservation, "BOOK_AVAILABLE");
      }

      await rebuildQueue(bookId, schoolId);

      return rep.code(201).send({ reservation });
    }
  );

  // ─── CANCEL RESERVATION ───────────────────────────────────
  app.post(`${P}/:id/cancel`, { preHandler: [authenticate, requireCapability('library.reservations')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);
      const { reason } = req.body as any;

      const res = await prisma.libReservation.update({
        where: { id, schoolId },
        data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason ?? null },
      });

      await rebuildQueue(res.bookId, schoolId);

      return rep.send({ reservation: res });
    }
  );

  // ─── MARK COLLECTED ───────────────────────────────────────
  app.post(`${P}/:id/collect`, { preHandler: [authenticate, requireCapability('library.reservations')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const id = Number((req.params as any).id);

      const reservation = await prisma.libReservation.update({
        where: { id, schoolId },
        data: { status: "COLLECTED", collectedAt: new Date(), issueId: (req.body as any).issueId ?? null },
      });

      await rebuildQueue(reservation.bookId, schoolId);

      return rep.send({ reservation });
    }
  );

  // ─── EXPIRE STALE RESERVATIONS (cron job endpoint) ────────
  app.post(`${P}/expire-stale`, { preHandler: [authenticate, requireCapability('library.reservations')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date();

      // Expire AVAILABLE ones past collection window
      const expired = await prisma.libReservation.updateMany({
        where: { schoolId, status: "AVAILABLE", expiresAt: { lt: now } },
        data: { status: "EXPIRED" },
      });

      // Promote next in queue for affected books
      const affectedBooks = await prisma.libReservation.findMany({
        where: { schoolId, status: "EXPIRED", expiresAt: { lt: now } },
        select: { bookId: true },
        distinct: ["bookId"],
      });

      let promoted = 0;
      const rule = await prisma.libReservationRule.findUnique({ where: { schoolId } });
      const validityMs = (rule?.collectionWindowHours ?? 48) * 3600000;

      for (const b of affectedBooks) {
        const next = await prisma.libReservation.findFirst({
          where: { schoolId, bookId: b.bookId, status: "WAITING", queuePosition: 1 },
        });
        if (next) {
          await prisma.libReservation.update({
            where: { id: next.id },
            data: { status: "AVAILABLE", availableAt: now, expiresAt: new Date(Date.now() + validityMs), notifiedAt: now },
          });
          promoted++;
        }
      }

      return rep.send({ expired: expired.count, promoted });
    }
  );

  // ─── RESERVATION RULES CRUD ───────────────────────────────
  app.get(`${P}/rules`, { preHandler: [authenticate, requireCapability('library.reservations')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      let rule = await prisma.libReservationRule.findUnique({ where: { schoolId } });
      if (!rule) rule = await prisma.libReservationRule.create({ data: { schoolId } });
      return rep.send({ rule });
    }
  );

  app.put(`${P}/rules`, { preHandler: [authenticate, requireCapability('library.reservations')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;
      const rule = await prisma.libReservationRule.upsert({
        where: { schoolId },
        create: { schoolId, ...b },
        update: {
          maxReservationsStudent:  b.maxReservationsStudent  ? Number(b.maxReservationsStudent)  : undefined,
          maxReservationsTeacher:  b.maxReservationsTeacher  ? Number(b.maxReservationsTeacher)  : undefined,
          maxReservationsStaff:    b.maxReservationsStaff    ? Number(b.maxReservationsStaff)    : undefined,
          collectionWindowHours:   b.collectionWindowHours   ? Number(b.collectionWindowHours)   : undefined,
          reservationExpiryDays:   b.reservationExpiryDays   ? Number(b.reservationExpiryDays)   : undefined,
          teacherPriority:         b.teacherPriority         ? Number(b.teacherPriority)         : undefined,
          studentPriority:         b.studentPriority         ? Number(b.studentPriority)         : undefined,
          staffPriority:           b.staffPriority           ? Number(b.staffPriority)           : undefined,
          notifyOnAvailable:       b.notifyOnAvailable,
          notifyChannels:          b.notifyChannels,
          notifyAdvanceDays:       b.notifyAdvanceDays       ? Number(b.notifyAdvanceDays)       : undefined,
        },
      });
      return rep.send({ rule });
    }
  );

  // ─── REPORTS ──────────────────────────────────────────────
  app.get(`${P}/reports/summary`, { preHandler: [authenticate, requireCapability('library.reservations')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;

      const [byStatus, byMemberType, popularBooks, monthlyTrend] = await Promise.all([
        prisma.libReservation.groupBy({ by: ["status"], where: { schoolId }, _count: { id: true } }),
        prisma.libReservation.groupBy({ by: ["memberType"], where: { schoolId }, _count: { id: true } }),
        prisma.libReservation.groupBy({
          by: ["bookId"],
          where: { schoolId },
          _count: { id: true },
          orderBy: { _count: { id: "desc" } },
          take: 10,
        }),
        prisma.libReservation.groupBy({
          by: ["reservedAt"],
          where: { schoolId, reservedAt: { gte: new Date(Date.now() - 90 * 86400000) } },
          _count: { id: true },
        }),
      ]);

      const popBookIds = popularBooks.map(b => b.bookId);
      const popBooks   = await prisma.libBook.findMany({ where: { id: { in: popBookIds } }, select: { id: true, title: true, totalCopies: true } });
      const popMap     = Object.fromEntries(popBooks.map(b => [b.id, b]));

      return rep.send({
        byStatus, byMemberType,
        popularBooks: popularBooks.map(b => ({ ...b, book: popMap[b.bookId], reservations: b._count.id })),
        monthlyTrend,
      });
    }
  );

  // ─── WAITING LIST for a book (public view) ────────────────
  app.get(`${P}/waiting-list`, { preHandler: [authenticate, requireCapability('library.reservations')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as any;

      const books = await prisma.libBook.findMany({
        where: { schoolId, reservations: { some: { status: { in: ["PENDING","WAITING"] } } } },
        include: {
          reservations: {
            where: { status: { in: ["PENDING","WAITING","AVAILABLE"] } },
            orderBy: { queuePosition: "asc" },
            take: 1,
            select: { queuePosition: true },
          },
          _count: { select: { reservations: true } },
        },
        take: Number(q.limit ?? 30),
      });

      return rep.send({ books });
    }
  );
}
