import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCapability } from "../../middleware/checkCapability.js";

// ── Default Layouts ──────────────────────────────────────────
const DEFAULT_LAYOUTS: Record<string, any> = {
  CBSE_STANDARD: {
    boardType: "CBSE", orientation: "PORTRAIT",
    components: [
      { id: "hdr1",  type: "school_header",  x: 0, y: 0,   w: 780, h: 100, props: { showLogo: true, showName: true, showAddress: true } },
      { id: "ttl1",  type: "report_title",   x: 0, y: 110, w: 780, h: 40,  props: { text: "REPORT CARD", fontSize: 22, bold: true, align: "center" } },
      { id: "inf1",  type: "student_info",   x: 0, y: 160, w: 780, h: 120, props: { fields: ["name","rollNo","admissionNo","class","section","dob"] } },
      { id: "att1",  type: "attendance_box", x: 0, y: 290, w: 780, h: 70,  props: { showDays: true, showPercent: true } },
      { id: "mrk1",  type: "marks_table",    x: 0, y: 370, w: 780, h: 280, props: { showGrade: true, showMax: true, showObtained: true, showPercent: true, alternateRows: true } },
      { id: "grd1",  type: "grade_scale",    x: 0, y: 660, w: 380, h: 100, props: { title: "Grade Scale" } },
      { id: "rmk1",  type: "remarks_box",    x: 400, y: 660, w: 380, h: 100, props: { showTeacher: true, showPrincipal: true } },
      { id: "prm1",  type: "promotion_box",  x: 0, y: 770, w: 400, h: 60,  props: {} },
      { id: "sig1",  type: "signatures",     x: 0, y: 840, w: 780, h: 80,  props: { showClassTeacher: true, showPrincipal: true, showParent: true } },
      { id: "qr1",   type: "qr_code",        x: 700, y: 770, w: 80, h: 80, props: { size: 70 } },
    ],
  },
  MODERN: {
    boardType: "CUSTOM", orientation: "PORTRAIT",
    components: [
      { id: "hdr1",  type: "school_header",  x: 0, y: 0,   w: 780, h: 120, props: { showLogo: true, showName: true, colorBg: true } },
      { id: "ph1",   type: "student_photo",  x: 20, y: 130, w: 80, h: 100, props: { borderRadius: 8 } },
      { id: "inf1",  type: "student_info",   x: 110, y: 130, w: 660, h: 100, props: { fields: ["name","rollNo","class","dob","parent"] } },
      { id: "att1",  type: "attendance_box", x: 0, y: 240, w: 780, h: 70,  props: { style: "cards" } },
      { id: "mrk1",  type: "marks_table",    x: 0, y: 320, w: 780, h: 300, props: { showGrade: true, showBar: true, colorGrades: true } },
      { id: "coc1",  type: "cocurricular",   x: 0, y: 630, w: 380, h: 120, props: { title: "Co-Curricular Activities" } },
      { id: "rmk1",  type: "remarks_box",    x: 400, y: 630, w: 380, h: 120, props: { showTeacher: true, showPrincipal: true } },
      { id: "sig1",  type: "signatures",     x: 0, y: 760, w: 780, h: 80,  props: { showClassTeacher: true, showPrincipal: true } },
    ],
  },
};

// ── HTML Generator ──────────────────────────────────────────
function generateReportCardHtml(template: any, studentData: any, school: any): string {
  const { student, marks, attendance, coCurricular, review, examConfig } = studentData;
  const layout = template.layoutJson as { components: any[] };
  const pc = template.primaryColor ?? "#1e3a8a";
  const sc = template.secondaryColor ?? "#f59e0b";

  const totalObtained = marks.filter((m: any) => m.marksStatus === "PRESENT" && m.finalMarks !== null).reduce((s: number, m: any) => s + Number(m.finalMarks), 0);
  const totalMax = marks.filter((m: any) => m.marksStatus === "PRESENT" && m.finalMarks !== null).reduce((s: number, m: any) => s + Number(m.maxMarks), 0);
  const percentage = totalMax > 0 ? Math.round((totalObtained / totalMax) * 1000) / 10 : 0;
  const attPct = attendance.total > 0 ? Math.round((attendance.present / attendance.total) * 100) : 0;

  const renderComponent = (comp: any): string => {
    switch (comp.type) {
      case "school_header": return `
        <div style="display:flex;align-items:center;gap:16px;padding:12px;background:${comp.props.colorBg ? pc : "transparent"};color:${comp.props.colorBg ? "white" : "black"}">
          <div style="width:70px;height:70px;background:${sc};border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:20px;flex-shrink:0;">${school.name.charAt(0)}</div>
          <div style="flex:1;text-align:center;">
            <div style="font-size:22px;font-weight:900;letter-spacing:1px;">${school.name}</div>
            ${school.address ? `<div style="font-size:12px;opacity:0.8;margin-top:2px;">${school.address}</div>` : ""}
            ${school.phone ? `<div style="font-size:11px;opacity:0.7;">Phone: ${school.phone}</div>` : ""}
          </div>
        </div>`;
      case "report_title": return `
        <div style="text-align:center;padding:8px;background:${sc}20;border-top:2px solid ${sc};border-bottom:2px solid ${sc};">
          <span style="font-size:${comp.props.fontSize ?? 18}px;font-weight:bold;color:${pc};letter-spacing:3px;">${comp.props.text ?? "PROGRESS REPORT"}</span>
          <div style="font-size:12px;color:#666;margin-top:2px;">${examConfig.name} | Session: ${examConfig.sessionName}</div>
        </div>`;
      case "student_info": return `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;padding:12px;background:#f8fafc;border-radius:8px;">
          ${[
            ["Student Name", student.name],
            ["Admission No.", student.admissionNumber],
            ["Roll Number", student.rollNumber],
            ["Class", student.class?.name ?? ""],
            ["Date of Birth", student.dateOfBirth ? new Date(student.dateOfBirth).toLocaleDateString("en-IN") : ""],
            ["Gender", student.gender ?? ""],
          ].map(([l, v]) => `<div style="padding:6px;background:white;border-radius:6px;border:1px solid #e2e8f0;">
            <div style="font-size:9px;color:#94a3b8;font-weight:600;text-transform:uppercase;">${l}</div>
            <div style="font-size:12px;font-weight:700;color:#1e293b;margin-top:2px;">${v || "—"}</div>
          </div>`).join("")}
        </div>`;
      case "attendance_box": return `
        <div style="display:flex;gap:12px;padding:10px;background:${pc}10;border-radius:8px;border:1px solid ${pc}20;">
          <div style="text-align:center;flex:1;padding:8px;background:white;border-radius:6px;">
            <div style="font-size:10px;color:#64748b;font-weight:600;">WORKING DAYS</div>
            <div style="font-size:20px;font-weight:900;color:${pc};">${attendance.total}</div>
          </div>
          <div style="text-align:center;flex:1;padding:8px;background:white;border-radius:6px;">
            <div style="font-size:10px;color:#64748b;font-weight:600;">DAYS PRESENT</div>
            <div style="font-size:20px;font-weight:900;color:#10b981;">${attendance.present}</div>
          </div>
          <div style="text-align:center;flex:1;padding:8px;background:white;border-radius:6px;">
            <div style="font-size:10px;color:#64748b;font-weight:600;">ATTENDANCE %</div>
            <div style="font-size:20px;font-weight:900;color:${attPct >= 75 ? "#10b981" : "#ef4444"};">${attPct}%</div>
          </div>
          <div style="text-align:center;flex:1;padding:8px;background:white;border-radius:6px;">
            <div style="font-size:10px;color:#64748b;font-weight:600;">OVERALL %</div>
            <div style="font-size:20px;font-weight:900;color:${pc};">${percentage}%</div>
          </div>
        </div>`;
      case "marks_table": return `
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:${pc};color:white;">
              <th style="padding:8px;text-align:left;border-radius:4px 0 0 0;">Subject</th>
              <th style="padding:8px;text-align:center;">Max</th>
              <th style="padding:8px;text-align:center;">Obtained</th>
              <th style="padding:8px;text-align:center;">%</th>
              <th style="padding:8px;text-align:center;border-radius:0 4px 0 0;">Grade</th>
            </tr>
          </thead>
          <tbody>
            ${marks.map((m: any, i: number) => {
              const obt = Number(m.finalMarks ?? 0);
              const max = Number(m.maxMarks);
              const pct = max > 0 ? Math.round((obt / max) * 100) : 0;
              const bg = m.marksStatus === "ABSENT" ? "#fef2f2" : i % 2 === 0 ? "#ffffff" : "#f8fafc";
              return `<tr style="background:${bg};">
                <td style="padding:7px 8px;font-weight:600;border-bottom:1px solid #e2e8f0;">${m.subjectName}</td>
                <td style="padding:7px 8px;text-align:center;border-bottom:1px solid #e2e8f0;">${max}</td>
                <td style="padding:7px 8px;text-align:center;font-weight:700;border-bottom:1px solid #e2e8f0;color:${m.isPassed === false ? "#ef4444" : "#1e293b"};">${m.marksStatus === "ABSENT" ? "AB" : obt}</td>
                <td style="padding:7px 8px;text-align:center;border-bottom:1px solid #e2e8f0;">${m.marksStatus === "ABSENT" ? "—" : pct + "%"}</td>
                <td style="padding:7px 8px;text-align:center;font-weight:800;border-bottom:1px solid #e2e8f0;color:${m.isPassed === false ? "#ef4444" : "#6366f1"};">${m.grade ?? "—"}</td>
              </tr>`;
            }).join("")}
            <tr style="background:${pc}15;font-weight:900;">
              <td style="padding:8px;">TOTAL</td>
              <td style="padding:8px;text-align:center;">${totalMax}</td>
              <td style="padding:8px;text-align:center;">${totalObtained}</td>
              <td style="padding:8px;text-align:center;">${percentage}%</td>
              <td style="padding:8px;text-align:center;color:${pc};">—</td>
            </tr>
          </tbody>
        </table>`;
      case "remarks_box": return `
        <div style="padding:10px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
          ${comp.props.showTeacher && review?.classTeacherRemarks ? `
            <div style="margin-bottom:8px;">
              <div style="font-size:9px;font-weight:700;color:${pc};text-transform:uppercase;margin-bottom:4px;">Class Teacher's Remarks</div>
              <div style="font-size:11px;color:#374151;line-height:1.5;">${review.classTeacherRemarks}</div>
            </div>` : ""}
          ${comp.props.showPrincipal && review?.principalRemarks ? `
            <div>
              <div style="font-size:9px;font-weight:700;color:${pc};text-transform:uppercase;margin-bottom:4px;">Principal's Remarks</div>
              <div style="font-size:11px;color:#374151;line-height:1.5;">${review.principalRemarks}</div>
            </div>` : ""}
          ${!review?.classTeacherRemarks && !review?.principalRemarks ? `<div style="color:#94a3b8;font-size:11px;text-align:center;">No remarks added</div>` : ""}
        </div>`;
      case "promotion_box": return `
        <div style="padding:10px;background:${review?.promotionRecommendation === "PROMOTE" ? "#d1fae5" : "#fee2e2"};border-radius:8px;border:1px solid ${review?.promotionRecommendation === "PROMOTE" ? "#6ee7b7" : "#fca5a5"};">
          <span style="font-weight:900;font-size:13px;color:${review?.promotionRecommendation === "PROMOTE" ? "#065f46" : "#991b1b"};">
            Result: ${review?.promotionRecommendation?.replace("_"," ") ?? "PENDING"}
          </span>
        </div>`;
      case "signatures": return `
        <div style="display:flex;justify-content:space-between;padding:20px 0 0;border-top:1px solid #e2e8f0;">
          ${comp.props.showClassTeacher ? `<div style="text-align:center;"><div style="width:120px;border-top:1px solid #374151;padding-top:4px;font-size:10px;color:#374151;">Class Teacher</div></div>` : ""}
          ${comp.props.showPrincipal ? `<div style="text-align:center;"><div style="width:120px;border-top:1px solid #374151;padding-top:4px;font-size:10px;color:#374151;">Principal</div></div>` : ""}
          ${comp.props.showParent ? `<div style="text-align:center;"><div style="width:120px;border-top:1px solid #374151;padding-top:4px;font-size:10px;color:#374151;">Parent/Guardian</div></div>` : ""}
        </div>`;
      case "qr_code": return `
        <div style="text-align:center;">
          <div style="width:${comp.props.size ?? 70}px;height:${comp.props.size ?? 70}px;background:#e2e8f0;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:8px;color:#64748b;border:1px solid #cbd5e1;">QR</div>
          <div style="font-size:8px;color:#94a3b8;margin-top:2px;">Verify</div>
        </div>`;
      case "grade_scale": return `
        <div style="padding:8px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
          <div style="font-size:10px;font-weight:700;color:${pc};margin-bottom:6px;text-transform:uppercase;">Grade Scale</div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;font-size:10px;">
            ${[["A1","91-100"],["A2","81-90"],["B1","71-80"],["B2","61-70"],["C1","51-60"],["C2","41-50"],["D","33-40"],["E","0-32"]].map(([g,r]) =>
              `<div style="text-align:center;padding:3px;background:white;border-radius:4px;border:1px solid #e2e8f0;"><span style="font-weight:800;color:${pc};">${g}</span><span style="color:#94a3b8;font-size:9px;"> ${r}</span></div>`
            ).join("")}
          </div>
        </div>`;
      case "cocurricular": {
        if (!coCurricular?.length) return `<div style="padding:10px;background:#f8fafc;border-radius:8px;"><div style="font-size:10px;font-weight:700;color:${pc};margin-bottom:6px;">CO-CURRICULAR ACTIVITIES</div><div style="color:#94a3b8;font-size:11px;">No data available</div></div>`;
        return `
          <div style="padding:10px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <div style="font-size:10px;font-weight:700;color:${pc};margin-bottom:8px;text-transform:uppercase;">Co-Curricular Activities</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
              ${coCurricular.slice(0,6).map((c: any) => `
                <div style="display:flex;justify-content:space-between;padding:4px 6px;background:white;border-radius:4px;border:1px solid #e2e8f0;font-size:11px;">
                  <span style="color:#374151;">${c.categoryName}</span>
                  <span style="font-weight:700;color:${pc};">${c.grade}</span>
                </div>`).join("")}
            </div>
          </div>`;
      }
      default: return `<div style="padding:8px;background:#f8fafc;border-radius:4px;font-size:11px;color:#64748b;">[${comp.type}]</div>`;
    }
  };

  const componentsHtml = (layout.components ?? []).map(comp => `
    <div style="position:absolute;left:${comp.x}px;top:${comp.y}px;width:${comp.w}px;">
      ${renderComponent(comp)}
    </div>`).join("");

  // Calculate canvas height
  const maxBottom = Math.max(...(layout.components ?? []).map((c: any) => c.y + c.h)) + 20;

  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ${template.fontFamily ?? "Inter"}, Arial, sans-serif; background: white; }
  .page { width: 800px; min-height: ${maxBottom}px; position: relative; padding: 20px; margin: 0 auto; background: white; }
  @media print { body { margin: 0; } .page { page-break-after: always; } }
</style>
</head><body>
<div class="page">
  ${template.showWatermark && template.watermarkText ? `
    <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:72px;font-weight:900;color:rgba(0,0,0,0.04);z-index:0;pointer-events:none;white-space:nowrap;">${template.watermarkText}</div>` : ""}
  <div style="position:relative;z-index:1;">
    ${componentsHtml}
  </div>
</div>
</body></html>`;
}

export async function adminReportCardRoutes(app: FastifyInstance) {

  // ── GET /admin/report-card/meta ───────────────────────────
  app.get("/admin/report-card/meta",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;

      const [templates, examConfigs, classes, school] = await Promise.all([
        prisma.reportCardTemplate.findMany({
          where: { schoolId },
          orderBy: { createdAt: "desc" },
          include: { createdBy: { select: { name: true } } },
        }),
        prisma.examConfig.findMany({
          where: { schoolId, status: { in: ["ACTIVE","PUBLISHED","COMPLETED"] } },
          select: { id: true, name: true, sessionName: true },
        }),
        prisma.class.findMany({ where: { schoolId, isActive: true }, orderBy: [{ classNumber: "asc" },{ section: "asc" }], select: { id: true, name: true } }),
        prisma.school.findFirst({ where: { id: schoolId }, select: { id: true, name: true, address: true, phone: true, logoUrl: true } }),
      ]);

      const stats = {
        total: templates.length,
        active: templates.filter(t => t.status === "ACTIVE").length,
        draft: templates.filter(t => t.status === "DRAFT").length,
      };

      return reply.send({ success: true, data: { templates, examConfigs, classes, school, stats, defaultLayouts: Object.keys(DEFAULT_LAYOUTS) } });
    }
  );

  // ── GET /admin/report-card/templates/:id ──────────────────
  app.get("/admin/report-card/templates/:id",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const template = await prisma.reportCardTemplate.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!template) return reply.status(404).send({ success: false, message: "Not found." });
      return reply.send({ success: true, data: { template } });
    }
  );

  // ── POST /admin/report-card/templates ─────────────────────
  app.post("/admin/report-card/templates",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as {
        name: string; description?: string; boardType?: string;
        orientation?: string; language?: string;
        primaryColor?: string; secondaryColor?: string;
        fontFamily?: string; showWatermark?: boolean; watermarkText?: string;
        enableQr?: boolean; applicableClasses?: number[];
        layoutJson?: any; fromDefault?: string;
      };

      const layout = body.layoutJson ?? (body.fromDefault && DEFAULT_LAYOUTS[body.fromDefault] ? DEFAULT_LAYOUTS[body.fromDefault] : { components: [] });

      const template = await prisma.reportCardTemplate.create({
        data: {
          schoolId, createdById: userId,
          name: body.name.trim(),
          description: body.description ?? null,
          boardType: body.boardType as any ?? "CUSTOM",
          orientation: body.orientation as any ?? "PORTRAIT",
          language: body.language ?? "English",
          status: "DRAFT",
          primaryColor: body.primaryColor ?? "#1e3a8a",
          secondaryColor: body.secondaryColor ?? "#f59e0b",
          fontFamily: body.fontFamily ?? "Inter",
          showWatermark: body.showWatermark ?? false,
          watermarkText: body.watermarkText ?? null,
          enableQr: body.enableQr ?? true,
          applicableClasses: body.applicableClasses ?? [],
          layoutJson: layout,
        },
      });

      return reply.status(201).send({ success: true, message: "Template created.", data: { templateId: template.id } });
    }
  );

  // ── PUT /admin/report-card/templates/:id ──────────────────
  app.put("/admin/report-card/templates/:id",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as any;

      const tmpl = await prisma.reportCardTemplate.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!tmpl) return reply.status(404).send({ success: false, message: "Not found." });

      await prisma.reportCardTemplate.update({
        where: { id: parseInt(id) },
        data: {
          ...(body.name && { name: body.name }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.boardType && { boardType: body.boardType }),
          ...(body.orientation && { orientation: body.orientation }),
          ...(body.language && { language: body.language }),
          ...(body.primaryColor && { primaryColor: body.primaryColor }),
          ...(body.secondaryColor && { secondaryColor: body.secondaryColor }),
          ...(body.fontFamily && { fontFamily: body.fontFamily }),
          ...(body.showWatermark !== undefined && { showWatermark: body.showWatermark }),
          ...(body.watermarkText !== undefined && { watermarkText: body.watermarkText }),
          ...(body.enableQr !== undefined && { enableQr: body.enableQr }),
          ...(body.applicableClasses && { applicableClasses: body.applicableClasses }),
          ...(body.layoutJson && { layoutJson: body.layoutJson }),
          ...(body.status && { status: body.status }),
        },
      });

      return reply.send({ success: true, message: "Template saved." });
    }
  );

  // ── POST /admin/report-card/templates/:id/clone ───────────
  app.post("/admin/report-card/templates/:id/clone",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const { id } = request.params as { id: string };
      const { name } = request.body as { name?: string };

      const source = await prisma.reportCardTemplate.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!source) return reply.status(404).send({ success: false, message: "Not found." });

      const clone = await prisma.reportCardTemplate.create({
        data: {
          schoolId, createdById: userId, clonedFromId: source.id,
          name: name ?? `${source.name} (Copy)`,
          description: source.description, boardType: source.boardType,
          orientation: source.orientation, language: source.language,
          status: "DRAFT", primaryColor: source.primaryColor,
          secondaryColor: source.secondaryColor, fontFamily: source.fontFamily,
          showWatermark: source.showWatermark, watermarkText: source.watermarkText,
          enableQr: source.enableQr, applicableClasses: source.applicableClasses,
          layoutJson: source.layoutJson,
        },
      });

      return reply.status(201).send({ success: true, message: "Template cloned.", data: { templateId: clone.id } });
    }
  );

  // ── PATCH /admin/report-card/templates/:id/publish ────────
  app.patch("/admin/report-card/templates/:id/publish",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };

      const tmpl = await prisma.reportCardTemplate.findFirst({ where: { id: parseInt(id), schoolId } });
      if (!tmpl) return reply.status(404).send({ success: false, message: "Not found." });

      const layout = tmpl.layoutJson as { components?: any[] };
      if (!layout?.components?.length) return reply.status(400).send({ success: false, message: "Template has no components." });

      await prisma.reportCardTemplate.update({
        where: { id: parseInt(id) },
        data: { status: "ACTIVE", publishedAt: new Date() },
      });

      return reply.send({ success: true, message: "Template published." });
    }
  );

  // ── DELETE /admin/report-card/templates/:id ───────────────
  app.delete("/admin/report-card/templates/:id",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const { id } = request.params as { id: string };
      await prisma.reportCardTemplate.updateMany({
        where: { id: parseInt(id), schoolId },
        data: { status: "ARCHIVED" },
      });
      return reply.send({ success: true, message: "Template archived." });
    }
  );

  // ── POST /admin/report-card/preview ───────────────────────
  app.post("/admin/report-card/preview",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = request.user as any;
      const body = request.body as { templateId: number; studentId?: number; examConfigId?: number; layoutJson?: any };

      const template = await prisma.reportCardTemplate.findFirst({ where: { id: body.templateId, schoolId } });
      if (!template) return reply.status(404).send({ success: false, message: "Template not found." });

      const school = await prisma.school.findFirst({ where: { id: schoolId } });

      // If studentId given, use real data; else use sample data
      let studentData: any;
      if (body.studentId && body.examConfigId) {
        const student = await prisma.student.findFirst({
          where: { id: body.studentId, schoolId },
          include: { user: true, class: { select: { id: true, name: true } } },
        });
        const marksEntries = await prisma.marksEntry.findMany({
          where: { schoolId, examConfigId: body.examConfigId, studentId: body.studentId },
          include: { examSubject: { include: { subject: { select: { name: true } } } } },
        });
        const attData = await prisma.attendance.groupBy({
          by: ["status"], where: { schoolId, studentId: body.studentId },
          _count: true,
        });
        const present = attData.find(a => a.status === "PRESENT")?._count ?? 0;
        const total = attData.reduce((s, a) => s + a._count, 0);
        const review = await prisma.studentResultReview.findFirst({
          where: { schoolId, examConfigId: body.examConfigId, studentId: body.studentId },
        });
        const coCurricular = await prisma.coCurricularAssessment.findMany({
          where: { schoolId, studentId: body.studentId },
          include: { category: { select: { name: true } } },
          take: 8,
        });
        const examConfig = await prisma.examConfig.findFirst({ where: { id: body.examConfigId } });

        studentData = {
          student: { ...student, ...student?.user, class: student?.class },
          marks: marksEntries.map(m => ({ subjectName: m.examSubject.subject.name, finalMarks: m.finalMarks, maxMarks: m.maxMarks, grade: m.grade, isPassed: m.isPassed, marksStatus: m.marksStatus })),
          attendance: { present, total },
          review, examConfig,
          coCurricular: coCurricular.map(c => ({ categoryName: c.category.name, grade: c.grade })),
        };
      } else {
        // Sample data
        studentData = {
          student: { name: "Sample Student", admissionNumber: "ADM-2026-00001", rollNumber: "8A-01", class: { name: "8A" }, dateOfBirth: "2010-03-15", gender: "Male" },
          marks: [
            { subjectName: "Mathematics", finalMarks: 82, maxMarks: 100, grade: "A2", isPassed: true, marksStatus: "PRESENT" },
            { subjectName: "Science", finalMarks: 76, maxMarks: 100, grade: "B1", isPassed: true, marksStatus: "PRESENT" },
            { subjectName: "English", finalMarks: 88, maxMarks: 100, grade: "A2", isPassed: true, marksStatus: "PRESENT" },
            { subjectName: "Hindi", finalMarks: 71, maxMarks: 100, grade: "B1", isPassed: true, marksStatus: "PRESENT" },
            { subjectName: "Social Studies", finalMarks: 65, maxMarks: 100, grade: "B2", isPassed: true, marksStatus: "PRESENT" },
          ],
          attendance: { present: 180, total: 220 },
          review: { classTeacherRemarks: "Excellent student with great potential.", principalRemarks: "Keep up the good work!", promotionRecommendation: "PROMOTE" },
          examConfig: { name: "Sample Exam", sessionName: "2025-26" },
          coCurricular: [{ categoryName: "Sports", grade: "A" }, { categoryName: "Music", grade: "B+" }, { categoryName: "Leadership", grade: "Excellent" }],
        };
      }

      // Use layoutJson override if provided
      const tmplToUse = body.layoutJson ? { ...template, layoutJson: body.layoutJson } : template;
      const html = generateReportCardHtml(tmplToUse, studentData, school ?? { name: "School Name", address: "", phone: "" });

      return reply.send({ success: true, data: { html } });
    }
  );

  // ── POST /admin/report-card/generate ─────────────────────
  app.post("/admin/report-card/generate",
    { preHandler: [authenticate, requireCapability('offlineExams.core')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = request.user as any;
      const body = request.body as { templateId: number; examConfigId: number; classId?: number; studentIds?: number[] };

      const template = await prisma.reportCardTemplate.findFirst({ where: { id: body.templateId, schoolId } });
      if (!template) return reply.status(404).send({ success: false, message: "Template not found." });
      const school = await prisma.school.findFirst({ where: { id: schoolId } });
      const examConfig = await prisma.examConfig.findFirst({ where: { id: body.examConfigId } });

      let studentWhere: any = { schoolId, isActive: true };
      if (body.classId) studentWhere.classId = body.classId;
      if (body.studentIds?.length) studentWhere.id = { in: body.studentIds };

      const students = await prisma.student.findMany({
        where: studentWhere,
        include: { user: true, class: { select: { id: true, name: true } } },
      });

      let generated = 0;
      for (const student of students) {
        const marksEntries = await prisma.marksEntry.findMany({
          where: { schoolId, examConfigId: body.examConfigId, studentId: student.id },
          include: { examSubject: { include: { subject: { select: { name: true } } } } },
        });
        const attData = await prisma.attendance.groupBy({ by: ["status"], where: { schoolId, studentId: student.id }, _count: true });
        const present = attData.find(a => a.status === "PRESENT")?._count ?? 0;
        const total = attData.reduce((s, a) => s + a._count, 0);
        const review = await prisma.studentResultReview.findFirst({ where: { schoolId, examConfigId: body.examConfigId, studentId: student.id } });
        const coCurricular = await prisma.coCurricularAssessment.findMany({ where: { schoolId, studentId: student.id }, include: { category: { select: { name: true } } }, take: 8 });

        const studentData = {
          student: { ...student, ...student.user, class: student.class },
          marks: marksEntries.map(m => ({ subjectName: m.examSubject.subject.name, finalMarks: m.finalMarks, maxMarks: m.maxMarks, grade: m.grade, isPassed: m.isPassed, marksStatus: m.marksStatus })),
          attendance: { present, total },
          review, examConfig,
          coCurricular: coCurricular.map(c => ({ categoryName: c.category.name, grade: c.grade })),
        };

        const html = generateReportCardHtml(template, studentData, school ?? { name: "School", address: "" });

        await prisma.generatedReportCard.upsert({
          where: { templateId_studentId_examConfigId: { templateId: body.templateId, studentId: student.id, examConfigId: body.examConfigId } },
          create: { schoolId, templateId: body.templateId, studentId: student.id, examConfigId: body.examConfigId, htmlContent: html, isPublished: false },
          update: { htmlContent: html },
        });
        generated++;
      }

      return reply.send({ success: true, message: `${generated} report cards generated.`, data: { generated } });
    }
  );
}
