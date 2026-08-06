// apps/api/src/routes/admin/academics/streams-subjects-insights.ts
// ─────────────────────────────────────────────────────────────
// Streams & Subjects — the health layer on top of the existing
// subject-master.ts and streams.ts (both untouched, both still work).
//
//   GET  /admin/subject-master/overview      → Layer 1 stat rail
//   POST /admin/subject-master/bulk          → archive / restore /
//                                               set-mode / set-credits /
//                                               set-elective across many
//   POST /admin/subject-master/bulk-create   → paste a subject list,
//                                               one per line, create them
//                                               all at once
//   POST /admin/subject-master/:id/duplicate → carry a subject forward
//                                               to another grade
//   GET  /admin/streams/overview             → Layer 1 for the Streams tab
//
// Register alongside the existing routes:
//   await app.register(adminStreamsSubjectsInsightRoutes);
// ─────────────────────────────────────────────────────────────

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminStreamsSubjectsInsightRoutes(app: FastifyInstance) {
  const guard = { preHandler: [authenticate, requireCapability("academics.core")] };

  // ── GET /admin/subject-master/overview ───────────────────
  app.get("/admin/subject-master/overview", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;

    const [subjects, classes, session] = await Promise.all([
      prisma.subject.findMany({
        where: { schoolId, isActive: true },
        select: { id: true, classNumber: true, isElective: true, subjectMode: true, streamId: true, credits: true },
      }),
      prisma.class.findMany({ where: { schoolId, isActive: true }, select: { classNumber: true }, distinct: ["classNumber"] }),
      prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } }),
    ]);

    const assignedSubjectIds = session
      ? new Set(
          (await prisma.subjectAssignment.findMany({
            where: { schoolId, academicYearId: session.id, isActive: true },
            select: { subjectId: true },
            distinct: ["subjectId"],
          })).map((a) => a.subjectId),
        )
      : new Set<number>();

    const gradesWithSubjects = new Set(subjects.map((s) => s.classNumber));
    const gradesWithoutSubjects = classes.filter((c) => !gradesWithSubjects.has(c.classNumber)).length;

    const byMode: Record<string, number> = {};
    for (const s of subjects) byMode[s.subjectMode] = (byMode[s.subjectMode] ?? 0) + 1;

    const electives = subjects.filter((s) => s.isElective).length;
    const withoutCredits = subjects.filter((s) => s.credits === null).length;
    const unassigned = subjects.filter((s) => !assignedSubjectIds.has(s.id)).length;
    const streamLinked = subjects.filter((s) => s.streamId !== null).length;

    return rep.send({
      success: true,
      data: {
        totalSubjects: subjects.length,
        gradesCovered: gradesWithSubjects.size,
        gradesWithoutSubjects,
        electives,
        core: subjects.length - electives,
        byMode,
        unassigned,
        withoutCredits,
        streamLinked,
      },
    });
  });

  // ── POST /admin/subject-master/bulk ──────────────────────
  app.post("/admin/subject-master/bulk", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as {
      action: "archive" | "restore" | "set-mode" | "set-elective" | "set-credits" | "set-stream";
      ids: number[];
      subjectMode?: string;
      isElective?: boolean;
      credits?: number | null;
      streamId?: number | null;
    };

    if (!Array.isArray(b.ids) || b.ids.length === 0) {
      return rep.status(400).send({ success: false, message: "Select at least one subject." });
    }

    const subjects = await prisma.subject.findMany({ where: { schoolId, id: { in: b.ids } } });
    const results: { id: number; name: string; ok: boolean; reason?: string }[] = [];

    for (const s of subjects) {
      try {
        if (b.action === "archive") {
          const active = await prisma.subjectAssignment.count({ where: { subjectId: s.id, isActive: true } });
          if (active > 0) throw new Error(`${active} active assignment(s)`);
          await prisma.subject.update({ where: { id: s.id }, data: { isActive: false } });
        } else if (b.action === "restore") {
          await prisma.subject.update({ where: { id: s.id }, data: { isActive: true } });
        } else if (b.action === "set-mode") {
          if (!b.subjectMode) throw new Error("no mode given");
          await prisma.subject.update({ where: { id: s.id }, data: { subjectMode: b.subjectMode as any } });
        } else if (b.action === "set-elective") {
          await prisma.subject.update({ where: { id: s.id }, data: { isElective: b.isElective ?? false } });
        } else if (b.action === "set-credits") {
          await prisma.subject.update({ where: { id: s.id }, data: { credits: b.credits ?? null } });
        } else if (b.action === "set-stream") {
          await prisma.subject.update({ where: { id: s.id }, data: { streamId: b.streamId ?? null } });
        }
        results.push({ id: s.id, name: s.name, ok: true });
      } catch (e: any) {
        results.push({ id: s.id, name: s.name, ok: false, reason: e.message ?? "Failed" });
      }
    }

    const done = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    return rep.send({
      success: done > 0,
      message:
        failed.length === 0
          ? `${done} subject${done === 1 ? "" : "s"} updated.`
          : `${done} updated, ${failed.length} skipped — ${failed.map((f) => `${f.name}: ${f.reason}`).join("; ")}.`,
      data: { results },
    });
  });

  // ── POST /admin/subject-master/bulk-create ───────────────
  // One subject per line: "Name, Code, Mode, Credits" — Code/Mode/
  // Credits optional. Applied to every picked grade.
  app.post("/admin/subject-master/bulk-create", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const b = req.body as {
      classNumbers: string[];
      subjects: { name: string; code?: string; subjectMode?: string; credits?: number; isElective?: boolean }[];
    };

    if (!b.classNumbers?.length || !b.subjects?.length) {
      return rep.status(400).send({ success: false, message: "Pick at least one grade and one subject." });
    }

    let created = 0, skipped = 0;
    for (const grade of b.classNumbers) {
      for (const s of b.subjects) {
        if (!s.name?.trim()) continue;
        const dup = await prisma.subject.findFirst({ where: { schoolId, classNumber: grade, name: s.name.trim() } });
        if (dup) { skipped++; continue; }
        await prisma.subject.create({
          data: {
            schoolId, classNumber: grade, name: s.name.trim(), code: s.code || null,
            subjectMode: (s.subjectMode as any) ?? "THEORY", credits: s.credits ?? null,
            isElective: s.isElective ?? false,
          },
        });
        created++;
      }
    }

    return rep.status(201).send({
      success: created > 0,
      message: `${created} subject${created === 1 ? "" : "s"} created${skipped ? `, ${skipped} already existed` : ""}.`,
      data: { created, skipped },
    });
  });

  // ── POST /admin/subject-master/:id/duplicate ─────────────
  app.post("/admin/subject-master/:id/duplicate", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;
    const { id } = req.params as { id: string };
    const b = req.body as { classNumber: string };

    if (!b.classNumber?.trim()) return rep.status(400).send({ success: false, message: "Pick a grade to copy it into." });

    const source = await prisma.subject.findFirst({ where: { id: parseInt(id), schoolId } });
    if (!source) return rep.status(404).send({ success: false, message: "Subject not found." });

    const dup = await prisma.subject.findFirst({ where: { schoolId, classNumber: b.classNumber, name: source.name } });
    if (dup) return rep.status(409).send({ success: false, message: `"${source.name}" already exists for Class ${b.classNumber}.` });

    const copy = await prisma.subject.create({
      data: {
        schoolId, classNumber: b.classNumber, name: source.name, code: source.code,
        isElective: source.isElective, subjectMode: source.subjectMode, credits: source.credits,
        streamId: null, // streams are grade-specific (11/12) — don't carry blindly across grades
      },
    });

    return rep.status(201).send({ success: true, message: `"${copy.name}" added to Class ${b.classNumber}.`, data: { subject: copy } });
  });

  // ── GET /admin/streams/overview ──────────────────────────
  app.get("/admin/streams/overview", guard, async (req: FastifyRequest, rep: FastifyReply) => {
    const { schoolId } = req.user as any;

    const streams = await prisma.stream.findMany({
      where: { schoolId, isActive: true },
      include: { streamSubjects: true, subjects: { select: { id: true } } },
    });

    const classesOnStreams = await prisma.class.findMany({
      where: { schoolId, isActive: true, stream: { not: null } },
      select: { id: true, stream: true, classNumber: true, _count: { select: { students: true } } },
    });

    const totalSubjectLinks = streams.reduce((a, s) => a + s.streamSubjects.length, 0);
    const compulsory = streams.reduce((a, s) => a + s.streamSubjects.filter((x) => x.isCompulsory).length, 0);
    const electiveGroups = new Set(
      streams.flatMap((s) => s.streamSubjects.filter((x) => x.groupLabel).map((x) => `${s.id}-${x.groupLabel}`)),
    ).size;

    const studentsOnStreams = classesOnStreams.reduce((a, c) => a + c._count.students, 0);
    const emptyStreams = streams.filter((s) => s.streamSubjects.length === 0).length;

    return rep.send({
      success: true,
      data: {
        totalStreams: streams.length,
        emptyStreams,
        totalSubjectLinks,
        compulsory,
        electiveGroups,
        studentsOnStreams,
        streams: streams.map((s) => ({
          id: s.id, name: s.name, classNumbers: s.classNumbers,
          subjectCount: s.streamSubjects.length,
          students: classesOnStreams.filter((c) => c.stream === s.name).reduce((a, c) => a + c._count.students, 0),
        })),
      },
    });
  });
}
