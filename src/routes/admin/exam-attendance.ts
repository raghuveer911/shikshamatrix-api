import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

export async function adminExamAttendanceRoutes(app: FastifyInstance) {

  // ── GET /admin/exam-attendance/meta ───────────────────────
  app.get("/admin/exam-attendance/meta",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;

      const [examConfigs, classes, staff] = await Promise.all([
        prisma.examConfig.findMany({
          where: { schoolId, status: { in: ["ACTIVE","PUBLISHED"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, name: true, sessionName: true },
        }),
        prisma.class.findMany({
          where: { schoolId, isActive: true },
          orderBy: [{ classNumber: "asc" }, { section: "asc" }],
          select: { id: true, name: true, classNumber: true, section: true },
        }),
        prisma.staff.findMany({
          where: { schoolId, isActive: true },
          select: { id: true, userId: true, staffCode: true, user: { select: { id: true, name: true } } },
          take: 50,
        }),
      ]);

      return reply.send({ success: true, data: { examConfigs, classes, staff, currentUserId: userId } });
    }
  );

  // ── GET /admin/exam-attendance/subjects ───────────────────
  // Get exam subjects for a specific exam + class
  app.get("/admin/exam-attendance/subjects",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { examConfigId, classId } = req.query as { examConfigId: string; classId: string };

      const examSubjects = await prisma.examSubject.findMany({
        where: {
          examConfigId: parseInt(examConfigId),
          examClass: { classId: parseInt(classId) },
        },
        include: {
          subject: { select: { id: true, name: true } },
          examClass: true,
        },
        orderBy: { subject: { name: "asc" } },
      });

      // Get exam schedule dates if available
      const schedules = await prisma.examSchedule.findMany({
        where: { examConfigId: parseInt(examConfigId), classId: parseInt(classId) },
        include: { examSubject: { include: { subject: { select: { name: true } } } } },
        orderBy: { examDate: "asc" },
      }).catch(() => [] as any[]);

      return reply.send({ success: true, data: { examSubjects, schedules } });
    }
  );

  // ── GET /admin/exam-attendance/session ────────────────────
  // Get or initialize a session
  app.get("/admin/exam-attendance/session",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as {
        examConfigId: string; classId: string;
        examSubjectId?: string; examDate: string;
      };

      const dateKey = new Date(q.examDate);
      dateKey.setHours(0, 0, 0, 0);

      const session = await prisma.examAttendanceSession.findFirst({
        where: {
          schoolId, examConfigId: parseInt(q.examConfigId),
          classId: parseInt(q.classId),
          examSubjectId: q.examSubjectId ? parseInt(q.examSubjectId) : null,
          examDate: dateKey,
        },
        include: {
          invigilator: { select: { name: true } },
          submittedBy: { select: { name: true } },
          records: {
            include: {
              student: {
                include: { user: { select: { id: true, name: true, avatarUrl: true } } },
              },
              ufmReportedBy: { select: { name: true } },
            },
            orderBy: { student: { rollNumber: "asc" } },
          },
        },
      });

      return reply.send({ success: true, data: { session } });
    }
  );

  // ── POST /admin/exam-attendance/session ───────────────────
  // Create session and load students
  app.post("/admin/exam-attendance/session",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        examConfigId: number; classId: number;
        examSubjectId?: number; examDate: string;
        hallName?: string; invigilatorId?: number;
      };

      const dateKey = new Date(body.examDate);
      dateKey.setHours(0, 0, 0, 0);

      // Upsert session
      let session = await prisma.examAttendanceSession.findFirst({
        where: {
          schoolId, examConfigId: body.examConfigId,
          classId: body.classId,
          examSubjectId: body.examSubjectId ?? null,
          examDate: dateKey,
        },
      });

      if (!session) {
        session = await prisma.examAttendanceSession.create({
          data: {
            schoolId, examConfigId: body.examConfigId,
            classId: body.classId,
            examSubjectId: body.examSubjectId ?? null,
            examDate: dateKey,
            hallName: body.hallName ?? null,
            invigilatorId: body.invigilatorId ?? userId,
            lockStatus: "DRAFT",
          },
        });
      }

      // Load students (if no records yet)
      const existingCount = await prisma.examAttendanceRecord.count({ where: { sessionId: session.id } });

      if (existingCount === 0) {
        const students = await prisma.student.findMany({
          where: { schoolId, classId: body.classId, isActive: true },
          orderBy: { rollNumber: "asc" },
          select: { id: true },
        });

        if (students.length > 0) {
          await prisma.examAttendanceRecord.createMany({
            data: students.map(s => ({
              sessionId: session!.id, schoolId,
              studentId: s.id,
              status: "ABSENT", isHallVerified: false,
            })),
            skipDuplicates: true,
          });
        }
      }

      // Return full session with records
      const fullSession = await prisma.examAttendanceSession.findFirst({
        where: { id: session.id },
        include: {
          records: {
            include: {
              student: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } },
              ufmReportedBy: { select: { name: true } },
              markedBy: { select: { name: true } },
            },
            orderBy: { student: { rollNumber: "asc" } },
          },
          invigilator: { select: { name: true } },
        },
      });

      return reply.status(201).send({ success: true, data: { session: fullSession } });
    }
  );

  // ── POST /admin/exam-attendance/save ─────────────────────
  // Save individual or bulk attendance
  app.post("/admin/exam-attendance/save",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        sessionId: number;
        records: {
          studentId: number;
          status: string;
          isHallVerified?: boolean;
          lateByMinutes?: number;
          remarks?: string;
        }[];
      };

      await prisma.$transaction(
        body.records.map(r =>
          prisma.examAttendanceRecord.upsert({
            where: { sessionId_studentId: { sessionId: body.sessionId, studentId: r.studentId } },
            create: {
              sessionId: body.sessionId, schoolId,
              studentId: r.studentId,
              status: r.status as any,
              isHallVerified: r.isHallVerified ?? false,
              lateByMinutes: r.lateByMinutes ?? null,
              remarks: r.remarks ?? null,
              markedById: userId, markedAt: new Date(),
            },
            update: {
              status: r.status as any,
              isHallVerified: r.isHallVerified ?? undefined,
              lateByMinutes: r.lateByMinutes ?? null,
              remarks: r.remarks ?? null,
              markedById: userId, markedAt: new Date(),
            },
          })
        )
      );

      return reply.send({ success: true, message: `${body.records.length} records saved.` });
    }
  );

  // ── POST /admin/exam-attendance/mark-all-present ─────────
  app.post("/admin/exam-attendance/mark-all-present",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { sessionId } = req.body as { sessionId: number };

      const session = await prisma.examAttendanceSession.findFirst({
        where: { id: sessionId, schoolId },
        select: { lockStatus: true },
      });
      if (!session) return reply.status(404).send({ success: false, message: "Session not found." });
      if (session.lockStatus === "LOCKED") return reply.status(400).send({ success: false, message: "Session is locked." });

      await prisma.examAttendanceRecord.updateMany({
        where: { sessionId, schoolId, status: "ABSENT" },
        data: { status: "PRESENT", markedById: userId, markedAt: new Date() },
      });

      return reply.send({ success: true, message: "All unmarked students marked Present." });
    }
  );

  // ── POST /admin/exam-attendance/ufm ──────────────────────
  // Report UFM case
  app.post("/admin/exam-attendance/ufm",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as {
        sessionId: number; studentId: number;
        ufmType: string; ufmDescription: string;
        ufmActionTaken?: string; ufmEvidenceUrl?: string;
      };

      const record = await prisma.examAttendanceRecord.findFirst({
        where: { sessionId: body.sessionId, studentId: body.studentId, schoolId },
      });
      if (!record) return reply.status(404).send({ success: false, message: "Record not found." });

      await prisma.examAttendanceRecord.update({
        where: { id: record.id },
        data: {
          status: "UFM",
          isUFM: true,
          ufmType: body.ufmType as any,
          ufmDescription: body.ufmDescription,
          ufmActionTaken: body.ufmActionTaken ?? null,
          ufmEvidenceUrl: body.ufmEvidenceUrl ?? null,
          ufmReportedById: userId,
        },
      });

      return reply.send({ success: true, message: "UFM case reported." });
    }
  );

  // ── PATCH /admin/exam-attendance/session/:id/submit ──────
  app.patch("/admin/exam-attendance/session/:id/submit",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };

      const session = await prisma.examAttendanceSession.findFirst({
        where: { id: parseInt(id), schoolId },
        include: { records: { select: { status: true } } },
      });
      if (!session) return reply.status(404).send({ success: false, message: "Not found." });

      // Validation: check unmarked students (still ABSENT without being intentionally absent)
      const total = session.records.length;
      const present = session.records.filter(r => r.status === "PRESENT" || r.status === "LATE").length;
      const absent  = session.records.filter(r => r.status === "ABSENT").length;

      await prisma.examAttendanceSession.update({
        where: { id: parseInt(id) },
        data: {
          lockStatus: "SUBMITTED",
          submittedAt: new Date(),
          submittedById: userId,
        },
      });

      return reply.send({
        success: true,
        message: "Attendance submitted.",
        data: { total, present, absent },
      });
    }
  );

  // ── PATCH /admin/exam-attendance/session/:id/lock ────────
  app.patch("/admin/exam-attendance/session/:id/lock",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const { lock } = req.body as { lock: boolean };

      await prisma.examAttendanceSession.updateMany({
        where: { id: parseInt(id), schoolId },
        data: {
          lockStatus: lock ? "LOCKED" : "SUBMITTED",
          lockedAt: lock ? new Date() : null,
        },
      });

      return reply.send({ success: true, message: lock ? "Session locked." : "Session unlocked." });
    }
  );

  // ── GET /admin/exam-attendance/analytics ─────────────────
  app.get("/admin/exam-attendance/analytics",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { examConfigId: string; classId?: string };

      const where: any = { schoolId, session: { examConfigId: parseInt(q.examConfigId) } };
      if (q.classId) where.session = { ...where.session, classId: parseInt(q.classId) };

      const [byStatus, bySessions] = await Promise.all([
        prisma.examAttendanceRecord.groupBy({
          by: ["status"], where, _count: true,
        }),
        prisma.examAttendanceSession.findMany({
          where: { schoolId, examConfigId: parseInt(q.examConfigId), ...(q.classId ? { classId: parseInt(q.classId) } : {}) },
          include: {
            _count: { select: { records: true } },
            records: { select: { status: true } },
            examSubject: { include: { subject: { select: { name: true } } } },
            class: { select: { name: true } },
          },
        }),
      ]);

      const sessionSummary = bySessions.map(s => {
        const total  = s.records.length;
        const present = s.records.filter(r => r.status === "PRESENT" || r.status === "LATE").length;
        const absent  = s.records.filter(r => r.status === "ABSENT").length;
        const ufm     = s.records.filter(r => r.status === "UFM").length;
        return {
          sessionId: s.id,
          subjectName: s.examSubject?.subject?.name ?? "General",
          className: s.class.name,
          date: s.examDate,
          total, present, absent, ufm,
          attendancePct: total > 0 ? Math.round((present / total) * 100) : 0,
        };
      });

      // UFM cases
      const ufmCases = await prisma.examAttendanceRecord.findMany({
        where: { ...where, isUFM: true },
        include: {
          student: { include: { user: { select: { name: true } } } },
          session: { include: { examSubject: { include: { subject: { select:{ name:true } } } } } },
          ufmReportedBy: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      });

      return reply.send({
        success: true,
        data: {
          byStatus: byStatus.map(b => ({ status: b.status, count: b._count })),
          sessionSummary,
          ufmCases,
        },
      });
    }
  );

  // ── GET /admin/exam-attendance/absent-list ────────────────
  app.get("/admin/exam-attendance/absent-list",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { examConfigId: string; classId?: string };

      const where: any = {
        schoolId, status: "ABSENT",
        session: { examConfigId: parseInt(q.examConfigId) },
      };
      if (q.classId) where.session.classId = parseInt(q.classId);

      const absents = await prisma.examAttendanceRecord.findMany({
        where,
        include: {
          student: { include: { user: { select: { name: true } } } },
          session: {
            include: {
              class: { select: { name: true } },
              examSubject: { include: { subject: { select: { name: true } } } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return reply.send({ success: true, data: { absents } });
    }
  );
}
