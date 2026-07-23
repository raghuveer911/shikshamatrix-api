// apps/api/src/routes/admin/certificates/cert-generate-api.ts
// Pure TypeScript — NO JSX, NO className

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ── Utility: generate cert number ────────────────────────────
async function nextCertNumber(schoolId: number): Promise<string> {
  const settings = await prisma.certSettings.findUnique({ where: { schoolId } });
  const year = new Date().getFullYear();
  const seq  = (settings?.currentSeq ?? 0) + 1;
  const fmt  = settings?.certNumberFormat ?? "CERT-{YYYY}-{SEQ}";
  await prisma.certSettings.upsert({
    where: { schoolId },
    create: { schoolId, currentSeq: seq },
    update: { currentSeq: { increment: 1 } },
  });
  return fmt
    .replace("{YYYY}", String(year))
    .replace("{YY}", String(year).slice(-2))
    .replace("{SEQ}", String(seq).padStart(4, "0"));
}

// ── Utility: resolve HTML template variables ─────────────────
function resolveTemplate(html: string, vars: Record<string, string>): string {
  let result = html;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(key, value ?? "");
  }
  return result;
}

// ── Utility: build variable map from student ─────────────────
async function studentVarMap(studentId: number): Promise<Record<string, string>> {
  const s = await prisma.student.findFirst({
    where: { id: studentId },
    include: {
      user: { select: { name: true } },
      class: { select: { name: true, classNumber: true } },
      school: { select: { name: true, address: true, phone: true } },
    },
  });
  if (!s) return {};
  return {
    "{{studentName}}": s.user?.name ?? "",
    "{{class}}":       s.class?.name ?? "",
    "{{classNumber}}": s.class?.classNumber ?? "",
    "{{admissionNo}}": s.admissionNumber ?? "",
    "{{rollNumber}}":  s.rollNumber ?? "",
    "{{schoolName}}":  s.school?.name ?? "",
    "{{year}}":        String(new Date().getFullYear()),
    "{{issueDate}}":   new Date().toLocaleDateString("en-IN"),
  };
}

// ── Utility: build variable map from staff ────────────────────
async function staffVarMap(staffId: number): Promise<Record<string, string>> {
  const s = await prisma.staff.findFirst({
    where: { id: staffId },
    include: {
      user: { select: { name: true } },
      departmentRef: { select: { name: true } },
      designationRef: { select: { name: true } },
      school: { select: { name: true, address: true } },
    },
  });
  if (!s) return {};
  return {
    "{{employeeName}}": s.user?.name ?? "",
    "{{employeeId}}":   s.employeeId ?? "",
    "{{designation}}":  (s as any).designationRef?.name ?? "",
    "{{department}}":   (s as any).departmentRef?.name ?? "",
    "{{joiningDate}}":  s.joinDate ? new Date(s.joinDate).toLocaleDateString("en-IN") : "",
    "{{schoolName}}":   (s as any).school?.name ?? "",
    "{{year}}":         String(new Date().getFullYear()),
    "{{issueDate}}":    new Date().toLocaleDateString("en-IN"),
  };
}

export async function adminCertGenerateRoutes(app: FastifyInstance) {
  const P = "/admin/certificates/generate";

  // ─── SINGLE CERTIFICATE (student or staff) ────────────────
  app.post(`${P}/single`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      // Load template
      const template = b.templateId
        ? await prisma.certTemplate.findFirst({ where: { id: Number(b.templateId), schoolId } })
        : await prisma.certTemplate.findFirst({
            where: { schoolId, certType: b.certType as any, isDefault: true, isActive: true },
          });

      if (!template) return rep.code(404).send({ error: "No template found for this certificate type" });

      // Build variable map
      let varMap: Record<string, string> = {};
      let recipientName = "";

      if (b.targetType === "STAFF" && b.staffId) {
        varMap = await staffVarMap(Number(b.staffId));
        const s = await prisma.staff.findFirst({ where: { id: Number(b.staffId) }, include: { user: { select: { name: true } } } });
        recipientName = (s as any)?.user?.name ?? "";
      } else if (b.studentId) {
        varMap = await studentVarMap(Number(b.studentId));
        const s = await prisma.student.findFirst({ where: { id: Number(b.studentId) }, include: { user: { select: { name: true } } } });
        recipientName = (s as any)?.user?.name ?? "";
      }

      // Merge any custom variables from request
      if (b.customVars) Object.assign(varMap, b.customVars);
      varMap["{{issueDate}}"]    = new Date().toLocaleDateString("en-IN");
      varMap["{{purposeNote}}"]  = b.purposeNote ?? "";
      varMap["{{title}}"]        = b.title ?? template.name;

      // Resolve HTML
      const resolvedHtml = template.htmlContent
        ? resolveTemplate(template.htmlContent, varMap)
        : null;

      const certNumber = await nextCertNumber(schoolId);
      varMap["{{certificateNo}}"] = certNumber;

      // Calculate expiry
      let validUntil: Date | null = null;
      if (template.expiresAfterDays) {
        validUntil = new Date();
        validUntil.setDate(validUntil.getDate() + template.expiresAfterDays);
      }

      const cert = await prisma.certIssued.create({
        data: {
          schoolId,
          templateId:    template.id,
          certNumber,
          category:      template.category,
          certType:      template.certType,
          targetType:    (b.targetType ?? "STUDENT") as any,
          studentId:     b.studentId ? Number(b.studentId) : null,
          staffId:       b.staffId   ? Number(b.staffId)   : null,
          recipientName,
          title:         b.title ?? template.name,
          issuedDate:    new Date(),
          validUntil,
          purposeNote:   b.purposeNote ?? null,
          dataSnapshot:  varMap,
          htmlContent:   resolvedHtml,
          pdfUrl:        b.pdfUrl ?? null,
          sourceModule:  b.sourceModule ?? null,
          sourceRefId:   b.sourceRefId ? Number(b.sourceRefId) : null,
          issuedById:    Number(userId),
        },
      });

      // Increment template usage
      await prisma.certTemplate.update({
        where: { id: template.id },
        data: { usageCount: { increment: 1 } },
      });

      // If this was from a request, link it
      if (b.requestId) {
        await prisma.certRequest.update({
          where: { id: Number(b.requestId) },
          data: { status: "GENERATED", certIssuedId: cert.id },
        });
      }

      return rep.code(201).send({ cert, certNumber });
    }
  );

  // ─── BULK CERTIFICATES (class / section / department) ─────
  app.post(`${P}/bulk`, { preHandler: [authenticate, requireCapability('certificates.bulkGeneration')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;

      // Resolve target list
      let targetIds: number[] = [];
      const targetType: string = b.targetType ?? "STUDENT";

      if (targetType === "STUDENT") {
        if (b.studentIds?.length) {
          targetIds = b.studentIds.map(Number);
        } else if (b.classId) {
          const students = await prisma.student.findMany({
            where: { schoolId, classId: Number(b.classId), isActive: true },
            select: { id: true },
          });
          targetIds = students.map(s => s.id);
        }
      } else if (targetType === "STAFF") {
        if (b.staffIds?.length) {
          targetIds = b.staffIds.map(Number);
        } else if (b.departmentId) {
          const staff = await prisma.staff.findMany({
            where: { schoolId, departmentId: Number(b.departmentId), isActive: true },
            select: { id: true },
          });
          targetIds = staff.map(s => s.id);
        }
      }

      if (!targetIds.length) return rep.code(400).send({ error: "No targets resolved" });

      // Load template
      const template = b.templateId
        ? await prisma.certTemplate.findFirst({ where: { id: Number(b.templateId), schoolId } })
        : await prisma.certTemplate.findFirst({
            where: { schoolId, certType: b.certType as any, isDefault: true, isActive: true },
          });

      if (!template) return rep.code(404).send({ error: "No template found" });

      // Generate batch ID
      const batchId = `BULK-${schoolId}-${Date.now()}`;
      const results: { id: number; certNumber: string; recipientName: string }[] = [];

      for (const tid of targetIds) {
        let varMap: Record<string, string> = {};
        let recipientName = "";

        if (targetType === "STAFF") {
          varMap = await staffVarMap(tid);
          const s = await prisma.staff.findFirst({ where: { id: tid }, include: { user: { select: { name: true } } } });
          recipientName = (s as any)?.user?.name ?? "";
        } else {
          varMap = await studentVarMap(tid);
          const s = await prisma.student.findFirst({ where: { id: tid }, include: { user: { select: { name: true } } } });
          recipientName = (s as any)?.user?.name ?? "";
        }

        if (b.customVars) Object.assign(varMap, b.customVars);
        varMap["{{issueDate}}"] = new Date().toLocaleDateString("en-IN");
        varMap["{{title}}"]     = b.title ?? template.name;

        const resolvedHtml = template.htmlContent
          ? resolveTemplate(template.htmlContent, varMap)
          : null;

        const certNumber = await nextCertNumber(schoolId);
        varMap["{{certificateNo}}"] = certNumber;

        let validUntil: Date | null = null;
        if (template.expiresAfterDays) {
          validUntil = new Date();
          validUntil.setDate(validUntil.getDate() + template.expiresAfterDays);
        }

        const cert = await prisma.certIssued.create({
          data: {
            schoolId,
            templateId:    template.id,
            certNumber,
            category:      template.category,
            certType:      template.certType,
            targetType:    targetType as any,
            studentId:     targetType === "STUDENT" ? tid : null,
            staffId:       targetType === "STAFF"   ? tid : null,
            recipientName,
            title:         b.title ?? template.name,
            issuedDate:    new Date(),
            validUntil,
            dataSnapshot:  varMap,
            htmlContent:   resolvedHtml,
            sourceModule:  b.sourceModule ?? null,
            sourceRefId:   b.sourceRefId ? Number(b.sourceRefId) : null,
            bulkBatchId:   batchId,
            issuedById:    Number(userId),
          },
        });
        results.push({ id: cert.id, certNumber, recipientName });
      }

      // Increment template usage
      await prisma.certTemplate.update({
        where: { id: template.id },
        data: { usageCount: { increment: targetIds.length } },
      });

      return rep.send({ batchId, count: results.length, results });
    }
  );

  // ─── AUTO GENERATE — exam merit certificates ──────────────
  app.post(`${P}/auto/exam-merit`, { preHandler: [authenticate, requireCapability('certificates.bulkGeneration')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const b = req.body as any;
      const { examConfigId, topN = 3, classId } = b;

      // Find top N students by percentage in this exam
      const topStudents = await prisma.studentResult.findMany({
        where: {
          schoolId,
          examConfigId: Number(examConfigId),
          ...(classId ? { classId: Number(classId) } : {}),
          status: "PUBLISHED",
        },
        orderBy: { percentage: "desc" },
        take: Number(topN),
        include: {
          student: { include: { user: { select: { name: true } } } },
        },
      });

      if (!topStudents.length) return rep.code(404).send({ error: "No published results found" });

      const template = await prisma.certTemplate.findFirst({
        where: { schoolId, certType: "MERIT", isDefault: true, isActive: true },
      });
      if (!template) return rep.code(404).send({ error: "No MERIT template found. Create one first." });

      const batchId = `AUTO-MERIT-${examConfigId}-${Date.now()}`;
      const results: any[] = [];

      for (let i = 0; i < topStudents.length; i++) {
        const sr = topStudents[i];
        const certNumber = await nextCertNumber(schoolId);
        const varMap: Record<string, string> = {
          ...await studentVarMap(sr.studentId),
          "{{rank}}":          String(i + 1),
          "{{percentage}}":    `${Number(sr.percentage).toFixed(1)}%`,
          "{{certificateNo}}": certNumber,
          "{{issueDate}}":     new Date().toLocaleDateString("en-IN"),
        };
        const resolvedHtml = template.htmlContent ? resolveTemplate(template.htmlContent, varMap) : null;

        const cert = await prisma.certIssued.create({
          data: {
            schoolId, templateId: template.id, certNumber,
            category: "ACADEMIC", certType: "MERIT", targetType: "STUDENT",
            studentId: sr.studentId,
            recipientName: sr.student?.user?.name ?? "",
            title: `Merit Certificate — Rank ${i + 1}`,
            issuedDate: new Date(), dataSnapshot: varMap,
            htmlContent: resolvedHtml,
            sourceModule: "EXAMS", sourceRefId: Number(examConfigId),
            bulkBatchId: batchId, issuedById: Number(userId),
          },
        });
        results.push({ rank: i + 1, studentId: sr.studentId, certNumber });
      }

      await prisma.certTemplate.update({ where: { id: template.id }, data: { usageCount: { increment: topStudents.length } } });
      return rep.send({ batchId, count: results.length, results });
    }
  );

  // ─── BATCH STATUS — look up a bulk batch ─────────────────
  app.get(`${P}/batch/:batchId`, { preHandler: [authenticate, requireCapability('certificates.bulkGeneration')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { batchId } = req.params as any;
      const certs = await prisma.certIssued.findMany({
        where: { schoolId, bulkBatchId: batchId },
        select: {
          id: true, certNumber: true, recipientName: true,
          status: true, pdfUrl: true, createdAt: true,
        },
        orderBy: { id: "asc" },
      });
      return rep.send({ batchId, count: certs.length, certs });
    }
  );

  // ─── PREVIEW — resolve template variables without saving ──
  app.post(`${P}/preview`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId } = req.user as any;
      const b = req.body as any;

      const template = await prisma.certTemplate.findFirst({
        where: { id: Number(b.templateId), schoolId },
      });
      if (!template) return rep.code(404).send({ error: "Template not found" });

      let varMap: Record<string, string> = {};
      if (b.targetType === "STAFF" && b.staffId) {
        varMap = await staffVarMap(Number(b.staffId));
      } else if (b.studentId) {
        varMap = await studentVarMap(Number(b.studentId));
      }

      if (b.customVars) Object.assign(varMap, b.customVars);
      varMap["{{issueDate}}"]    = new Date().toLocaleDateString("en-IN");
      varMap["{{certificateNo}}"] = "CERT-PREVIEW-0000";
      varMap["{{title}}"]        = b.title ?? template.name;

      const resolvedHtml = template.htmlContent
        ? resolveTemplate(template.htmlContent, varMap)
        : "<p>No HTML content in template</p>";

      return rep.send({ resolvedHtml, varMap, template: { ...template, htmlContent: undefined } });
    }
  );

  // ─── RE-ISSUE (new cert replacing a revoked/expired one) ──
  app.post(`${P}/reissue/:certId`, { preHandler: [authenticate, requireCapability('certificates.standardTemplates')] },
    async (req: FastifyRequest, rep: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const certId = Number((req.params as any).certId);
      const original = await prisma.certIssued.findFirst({ where: { id: certId, schoolId } });
      if (!original) return rep.code(404).send({ error: "Original certificate not found" });

      const certNumber = await nextCertNumber(schoolId);
      const cert = await prisma.certIssued.create({
        data: {
          schoolId,
          templateId:    original.templateId,
          certNumber,
          category:      original.category,
          certType:      original.certType,
          targetType:    original.targetType,
          studentId:     original.studentId,
          staffId:       original.staffId,
          recipientName: original.recipientName,
          title:         original.title,
          issuedDate:    new Date(),
          validUntil:    original.validUntil,
          purposeNote:   original.purposeNote,
          dataSnapshot:  original.dataSnapshot,
          htmlContent:   original.htmlContent,
          sourceModule:  original.sourceModule,
          sourceRefId:   original.sourceRefId,
          reissuedFromId: original.id,
          issuedById:    Number(userId),
        },
      });

      await prisma.certIssued.update({
        where: { id: certId },
        data: { status: "REISSUED" },
      });

      return rep.code(201).send({ cert, certNumber, originalCertNumber: original.certNumber });
    }
  );
}
