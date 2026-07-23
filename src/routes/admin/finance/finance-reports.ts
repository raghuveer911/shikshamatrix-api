// apps/api/src/routes/admin/finance-reports.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

export async function adminFinanceReportsRoutes(app: FastifyInstance) {

  // ─── DASHBOARD ─────────────────────────────────────────────
  app.get("/admin/finance-reports/dashboard", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { academicYearId } = req.query as { academicYearId?: string };
      const invWhere: any = { schoolId };
      if (academicYearId) invWhere.academicYearId = parseInt(academicYearId);

      const [collection, due, discounts, onlineCollection, refunds, students] = await Promise.all([
        prisma.payment.aggregate({ where: { invoice: invWhere }, _sum: { amount: true }, _count: true }),
        prisma.invoice.aggregate({ where: { ...invWhere, status: { in: ["PENDING","PARTIAL","OVERDUE"] } }, _sum: { dueAmount: true } }),
        prisma.feeDiscount.aggregate({ where: { schoolId, isActive: true }, _sum: { value: true } }),
        prisma.payment.aggregate({ where: { invoice: invWhere, method: { in: ["UPI","ONLINE","BANK_TRANSFER"] } }, _sum: { amount: true } }),
        prisma.feeRefund.aggregate({ where: { schoolId, status: "PROCESSED" }, _sum: { amount: true } }),
        prisma.student.count({ where: { schoolId, isActive: true } }),
      ]);

      const totalBilled = await prisma.invoice.aggregate({ where: invWhere, _sum: { totalAmount: true } });
      const collAmt = Number(collection._sum.amount ?? 0);
      const billed  = Number(totalBilled._sum.totalAmount ?? 0);
      const collRate = billed > 0 ? ((collAmt / billed) * 100).toFixed(1) : "0";

      // YoY growth — compare with same period last year
      const currentYear = await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
      let yoyGrowth: string | null = null;
      if (currentYear) {
        const prevYear = await prisma.academicYear.findFirst({ where: { schoolId, startDate: { lt: currentYear.startDate } }, orderBy: { startDate: "desc" } });
        if (prevYear) {
          const prevColl = await prisma.payment.aggregate({ where: { invoice: { schoolId, academicYearId: prevYear.id } }, _sum: { amount: true } });
          const prev = Number(prevColl._sum.amount ?? 0);
          if (prev > 0) yoyGrowth = (((collAmt - prev) / prev) * 100).toFixed(1);
        }
      }

      return reply.send({ success: true, data: {
        kpi: {
          totalCollection: collAmt, totalTransactions: collection._count,
          totalDue: Number(due._sum.dueAmount ?? 0),
          collectionRate: collRate,
          onlineCollection: Number(onlineCollection._sum.amount ?? 0),
          discountsGiven: Number(discounts._sum.value ?? 0),
          refundsProcessed: Number(refunds._sum.amount ?? 0),
          totalStudents: students,
          yoyGrowth,
        },
      }});
    }
  );

  // ─── COLLECTION REPORTS ────────────────────────────────────
  app.get("/admin/finance-reports/collection", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string; type?: string; academicYearId?: string };
      const from = q.from ? new Date(q.from) : new Date(new Date().setDate(1));
      const to   = q.to   ? new Date(q.to)   : new Date();
      const payWhere: any = { invoice: { schoolId }, paidAt: { gte: from, lte: to } };
      if (q.academicYearId) payWhere.invoice.academicYearId = parseInt(q.academicYearId);

      const [daily, monthly, byClass, byFeeHead, total] = await Promise.all([
        // Daily collection in range
        prisma.$queryRaw<{day:string;amount:number;count:number}[]>`
          SELECT DATE(p."paidAt") AS day, SUM(p.amount) AS amount, COUNT(p.id) AS count
          FROM payments p JOIN invoices i ON p."invoiceId" = i.id
          WHERE i."schoolId" = ${schoolId} AND p."paidAt" >= ${from} AND p."paidAt" <= ${to}
          GROUP BY DATE(p."paidAt") ORDER BY day ASC
        `.catch(() => []),

        // Monthly collection (last 12 months)
        Promise.all(Array.from({length:12},(_,i)=>{
          const d1=new Date(); d1.setDate(1); d1.setMonth(d1.getMonth()-(11-i));
          const d2=new Date(d1); d2.setMonth(d2.getMonth()+1);
          return prisma.payment.aggregate({ where:{ invoice:{schoolId}, paidAt:{gte:d1,lt:d2} }, _sum:{amount:true} })
            .then(r=>({ month: d1.toLocaleDateString("en-IN",{month:"short",year:"2-digit"}), amount: Number(r._sum.amount??0) }));
        })),

        // Class-wise
        prisma.$queryRaw<{className:string;amount:number;count:number}[]>`
          SELECT c.name AS "className", COALESCE(SUM(p.amount),0) AS amount, COUNT(DISTINCT p.id) AS count
          FROM classes c
          JOIN students s ON s."classId"=c.id
          JOIN invoices i ON i."studentId"=s.id AND i."schoolId"=${schoolId}
          JOIN payments p ON p."invoiceId"=i.id AND p."paidAt">=${from} AND p."paidAt"<=${to}
          WHERE c."schoolId"=${schoolId}
          GROUP BY c.name ORDER BY amount DESC
        `.catch(() => []),

        // Fee-head wise
        prisma.$queryRaw<{category:string;amount:number}[]>`
          SELECT ii.category, SUM(ii.amount) AS amount
          FROM invoice_items ii
          JOIN invoices inv ON ii."invoiceId"=inv.id
          JOIN payments p ON p."invoiceId"=inv.id
          WHERE inv."schoolId"=${schoolId} AND p."paidAt">=${from} AND p."paidAt"<=${to}
          GROUP BY ii.category ORDER BY amount DESC
        `.catch(() => []),

        prisma.payment.aggregate({ where: payWhere, _sum: { amount: true }, _count: true }),
      ]);

      return reply.send({ success: true, data: {
        total: { amount: Number(total._sum.amount ?? 0), count: total._count },
        daily: Array.isArray(daily) ? daily.map(d => ({ ...d, amount: Number(d.amount), count: Number(d.count) })) : [],
        monthly,
        byClass: Array.isArray(byClass) ? byClass.map(c => ({ ...c, amount: Number(c.amount), count: Number(c.count) })) : [],
        byFeeHead: Array.isArray(byFeeHead) ? byFeeHead.map(f => ({ ...f, amount: Number(f.amount) })) : [],
      }});
    }
  );

  // ─── DUE REPORTS ───────────────────────────────────────────
  app.get("/admin/finance-reports/due", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { academicYearId, classId } = req.query as { academicYearId?: string; classId?: string };
      const now = new Date();
      const where: any = { schoolId, status: { in: ["PENDING","PARTIAL","OVERDUE"] } };
      if (academicYearId) where.academicYearId = parseInt(academicYearId);
      if (classId)        where.student = { classId: parseInt(classId) };

      const [totalDue, aging, topDefaulters, byClass] = await Promise.all([
        prisma.invoice.aggregate({ where, _sum: { dueAmount: true }, _count: true }),

        // Aging buckets
        Promise.all([30,60,90,Infinity].map(async (days, i) => {
          const prev = [0,30,60,90][i];
          const ageWhere: any = { ...where, dueDate: { lt: new Date(now.getTime() - prev*86400000) } };
          if (days !== Infinity) ageWhere.dueDate.gte = new Date(now.getTime() - days*86400000);
          const a = await prisma.invoice.aggregate({ where: ageWhere, _sum: { dueAmount: true }, _count: true });
          return { label: days===Infinity?`90+ Days`:`${prev+1}-${days} Days`, amount: Number(a._sum.dueAmount??0), count: a._count };
        })),

        // Top 10 defaulters
        prisma.invoice.groupBy({
          by: ["studentId"], where,
          _sum: { dueAmount: true }, orderBy: { _sum: { dueAmount: "desc" } }, take: 10,
        }).then(async r => {
          const studentIds = r.map(s => s.studentId);
          const students = await prisma.student.findMany({ where: { id: { in: studentIds } }, include: { user: { select: { name: true } }, class: { select: { name: true } } } });
          return r.map(s => ({ studentId: s.studentId, dueAmount: Number(s._sum.dueAmount??0), student: students.find(st=>st.id===s.studentId) }));
        }),

        // By class
        prisma.$queryRaw<{className:string;dueAmount:number;studentCount:number}[]>`
          SELECT c.name AS "className", SUM(i."dueAmount") AS "dueAmount", COUNT(DISTINCT i."studentId") AS "studentCount"
          FROM classes c JOIN students s ON s."classId"=c.id
          JOIN invoices i ON i."studentId"=s.id AND i."schoolId"=${schoolId} AND i.status IN ('PENDING','PARTIAL','OVERDUE')
          WHERE c."schoolId"=${schoolId}
          GROUP BY c.name ORDER BY "dueAmount" DESC
        `.catch(() => []),
      ]);

      return reply.send({ success: true, data: {
        total: { amount: Number(totalDue._sum.dueAmount??0), count: totalDue._count },
        aging, topDefaulters,
        byClass: Array.isArray(byClass) ? byClass.map(c => ({ ...c, dueAmount: Number(c.dueAmount), studentCount: Number(c.studentCount) })) : [],
      }});
    }
  );

  // ─── PAYMENT ANALYTICS ─────────────────────────────────────
  app.get("/admin/finance-reports/payment-analytics", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?: string; to?: string; academicYearId?: string };
      const from = q.from ? new Date(q.from) : new Date(new Date().getFullYear(), 0, 1);
      const to   = q.to   ? new Date(q.to)   : new Date();
      const payWhere: any = { invoice: { schoolId }, paidAt: { gte: from, lte: to } };
      if (q.academicYearId) payWhere.invoice.academicYearId = parseInt(q.academicYearId);

      const [byMode, modeMonthly, hourly] = await Promise.all([
        prisma.payment.groupBy({ by: ["method"], where: payWhere, _sum: { amount: true }, _count: true }),
        // Mode trend by month (last 6 months)
        Promise.all(["CASH","UPI","ONLINE","BANK_TRANSFER","CHEQUE","CARD"].map(async mode => {
          const months = await Promise.all(Array.from({length:6},(_,i)=>{
            const d1=new Date(); d1.setDate(1); d1.setMonth(d1.getMonth()-(5-i));
            const d2=new Date(d1); d2.setMonth(d2.getMonth()+1);
            return prisma.payment.aggregate({ where:{invoice:{schoolId},method:mode as any,paidAt:{gte:d1,lt:d2}}, _sum:{amount:true} })
              .then(r=>({ month:d1.toLocaleDateString("en-IN",{month:"short"}), amount:Number(r._sum.amount??0) }));
          }));
          return { mode, months };
        })),
        // Hourly distribution (for today)
        prisma.$queryRaw<{hour:number;count:number}[]>`
          SELECT EXTRACT(HOUR FROM p."paidAt") AS hour, COUNT(*) AS count
          FROM payments p JOIN invoices i ON p."invoiceId"=i.id
          WHERE i."schoolId"=${schoolId} AND p."paidAt">=${from} AND p."paidAt"<=${to}
          GROUP BY EXTRACT(HOUR FROM p."paidAt") ORDER BY hour ASC
        `.catch(() => []),
      ]);

      return reply.send({ success: true, data: {
        byMode: byMode.map(b => ({ mode: b.method, amount: Number(b._sum.amount??0), count: b._count })).sort((a,b)=>b.amount-a.amount),
        modeMonthly,
        hourly: Array.isArray(hourly) ? hourly.map(h => ({ hour: Number(h.hour), count: Number(h.count) })) : [],
      }});
    }
  );

  // ─── REVENUE ANALYTICS ─────────────────────────────────────
  app.get("/admin/finance-reports/revenue-analytics", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { academicYearId } = req.query as { academicYearId?: string };
      const invWhere: any = { schoolId };
      if (academicYearId) invWhere.academicYearId = parseInt(academicYearId);

      const [monthly12, feeHeadRevenue, sessions, classRevenue] = await Promise.all([
        // 12 month trend
        Promise.all(Array.from({length:12},(_,i)=>{
          const d1=new Date(); d1.setDate(1); d1.setMonth(d1.getMonth()-(11-i));
          const d2=new Date(d1); d2.setMonth(d2.getMonth()+1);
          return Promise.all([
            prisma.payment.aggregate({ where:{invoice:{schoolId},paidAt:{gte:d1,lt:d2}}, _sum:{amount:true} }),
            prisma.invoice.aggregate({ where:{schoolId,issuedDate:{gte:d1,lt:d2}}, _sum:{totalAmount:true} }),
          ]).then(([col,billed])=>({
            month: d1.toLocaleDateString("en-IN",{month:"short",year:"2-digit"}),
            collected: Number(col._sum.amount??0), billed: Number(billed._sum.totalAmount??0),
          }));
        })),

        // Fee head revenue breakdown
        prisma.$queryRaw<{category:string;totalBilled:number;totalCollected:number}[]>`
          SELECT ii.category,
            SUM(ii.amount) AS "totalBilled",
            COALESCE(SUM(p.amount/NULLIF(inv."totalAmount",0)*ii.amount),0) AS "totalCollected"
          FROM invoice_items ii
          JOIN invoices inv ON ii."invoiceId"=inv.id AND inv."schoolId"=${schoolId}
          LEFT JOIN payments p ON p."invoiceId"=inv.id
          GROUP BY ii.category ORDER BY "totalBilled" DESC
        `.catch(() => []),

        // Session-wise comparison (all sessions)
        prisma.academicYear.findMany({ where:{schoolId}, orderBy:{startDate:"desc"}, take:5 })
          .then(years => Promise.all(years.map(async y => {
            const [col, billed] = await Promise.all([
              prisma.payment.aggregate({ where:{invoice:{schoolId,academicYearId:y.id}}, _sum:{amount:true} }),
              prisma.invoice.aggregate({ where:{schoolId,academicYearId:y.id}, _sum:{totalAmount:true} }),
            ]);
            return { yearName:y.name, collected:Number(col._sum.amount??0), billed:Number(billed._sum.totalAmount??0) };
          }))),

        // Top revenue classes
        prisma.$queryRaw<{className:string;revenue:number}[]>`
          SELECT c.name AS "className", COALESCE(SUM(p.amount),0) AS revenue
          FROM classes c JOIN students s ON s."classId"=c.id
          JOIN invoices i ON i."studentId"=s.id AND i."schoolId"=${schoolId}
          JOIN payments p ON p."invoiceId"=i.id
          WHERE c."schoolId"=${schoolId}
          GROUP BY c.name ORDER BY revenue DESC LIMIT 10
        `.catch(() => []),
      ]);

      return reply.send({ success: true, data: {
        monthly12,
        feeHeadRevenue: Array.isArray(feeHeadRevenue) ? feeHeadRevenue.map(f => ({ ...f, totalBilled:Number(f.totalBilled), totalCollected:Number(f.totalCollected) })) : [],
        sessions,
        classRevenue: Array.isArray(classRevenue) ? classRevenue.map(c => ({ ...c, revenue:Number(c.revenue) })) : [],
      }});
    }
  );

  // ─── DISCOUNT REPORTS ──────────────────────────────────────
  app.get("/admin/finance-reports/discounts", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [byCategory, byType, scholarshipSummary, top] = await Promise.all([
        prisma.feeDiscount.groupBy({ by:["category"], where:{schoolId,isActive:true}, _count:true, _sum:{value:true} }),
        prisma.feeDiscount.groupBy({ by:["discountType"], where:{schoolId,isActive:true}, _count:true }),
        prisma.scholarshipProgram.findMany({ where:{schoolId}, include:{ _count:{select:{studentScholarships:{where:{status:"APPROVED"}}}}, studentScholarships:{where:{status:"APPROVED"},select:{benefitAmount:true}} } }),
        prisma.studentScholarship.findMany({ where:{schoolId,status:"APPROVED"}, orderBy:{benefitAmount:"desc"}, take:10, include:{student:{include:{user:{select:{name:true}},class:{select:{name:true}}}}} }),
      ]);
      return reply.send({ success: true, data: {
        byCategory: byCategory.map(b=>({ category:b.category, count:b._count, total:Number(b._sum.value??0) })).sort((a,b)=>b.total-a.total),
        byType: byType.map(b=>({ type:b.discountType, count:b._count })),
        scholarshipSummary: scholarshipSummary.map(sp=>({ id:sp.id, name:sp.name, type:sp.scholarshipType, students:sp._count.studentScholarships, totalBenefit:sp.studentScholarships.reduce((s,ss)=>s+Number(ss.benefitAmount??0),0) })),
        topBeneficiaries: top.map(t=>({ studentName:t.student.user.name, className:t.student.class?.name, benefitAmount:Number(t.benefitAmount??0), type:t.discountType })),
      }});
    }
  );

  // ─── REFUND REPORTS ────────────────────────────────────────
  app.get("/admin/finance-reports/refunds", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [byStatus, total, recent, monthly] = await Promise.all([
        prisma.feeRefund.groupBy({ by:["status"], where:{schoolId}, _count:true, _sum:{amount:true} }),
        prisma.feeRefund.aggregate({ where:{schoolId,status:"PROCESSED"}, _sum:{amount:true}, _count:true }),
        prisma.feeRefund.findMany({ where:{schoolId}, orderBy:{createdAt:"desc"}, take:10, include:{student:{include:{user:{select:{name:true}},class:{select:{name:true}}}}} }),
        Promise.all(Array.from({length:6},(_,i)=>{
          const d1=new Date(); d1.setDate(1); d1.setMonth(d1.getMonth()-(5-i));
          const d2=new Date(d1); d2.setMonth(d2.getMonth()+1);
          return prisma.feeRefund.aggregate({ where:{schoolId,status:"PROCESSED",processedAt:{gte:d1,lt:d2}}, _sum:{amount:true} })
            .then(r=>({ month:d1.toLocaleDateString("en-IN",{month:"short"}), amount:Number(r._sum.amount??0) }));
        })),
      ]);
      return reply.send({ success: true, data: {
        byStatus: byStatus.map(b=>({ status:b.status, count:b._count, total:Number(b._sum.amount??0) })),
        total:{ count:total._count, amount:Number(total._sum.amount??0) },
        recent, monthly,
      }});
    }
  );

  // ─── CLASS ANALYTICS ───────────────────────────────────────
  app.get("/admin/finance-reports/class-analytics", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { academicYearId } = req.query as { academicYearId?: string };
      const invWhere: any = { schoolId };
      if (academicYearId) invWhere.academicYearId = parseInt(academicYearId);

      const classes = await prisma.class.findMany({ where:{ schoolId, isActive:true }, include:{ students:{ select:{ id:true } } } });
      const analytics = await Promise.all(classes.map(async cls => {
        const studentIds = cls.students.map(s => s.id);
        if (!studentIds.length) return null;
        const [billed, collected, due] = await Promise.all([
          prisma.invoice.aggregate({ where:{ ...invWhere, studentId:{in:studentIds} }, _sum:{totalAmount:true} }),
          prisma.payment.aggregate({ where:{ invoice:{ ...invWhere, studentId:{in:studentIds} } }, _sum:{amount:true} }),
          prisma.invoice.aggregate({ where:{ ...invWhere, studentId:{in:studentIds}, status:{in:["PENDING","PARTIAL","OVERDUE"]} }, _sum:{dueAmount:true} }),
        ]);
        const b=Number(billed._sum.totalAmount??0); const c=Number(collected._sum.amount??0);
        return { classId:cls.id, className:cls.name, students:studentIds.length, billed:b, collected:c, due:Number(due._sum.dueAmount??0), collectionRate:b>0?((c/b)*100).toFixed(1):"0" };
      }));

      return reply.send({ success: true, data: { classes: analytics.filter(Boolean).sort((a:any,b:any)=>b.billed-a.billed) } });
    }
  );

  // ─── CUSTOM REPORT BUILDER ─────────────────────────────────
  app.post("/admin/finance-reports/custom", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const body = req.body as { from?: string; to?: string; classIds?: number[]; paymentModes?: string[]; feeCategories?: string[]; academicYearId?: number; groupBy?: string };

      const payWhere: any = { invoice: { schoolId } };
      if (body.from || body.to) { payWhere.paidAt = {}; if (body.from) payWhere.paidAt.gte=new Date(body.from); if (body.to) payWhere.paidAt.lte=new Date(body.to); }
      if (body.paymentModes?.length) payWhere.method = { in: body.paymentModes };
      if (body.classIds?.length) payWhere.invoice.student = { classId: { in: body.classIds } };
      if (body.academicYearId) payWhere.invoice.academicYearId = body.academicYearId;

      const [payments, total] = await Promise.all([
        prisma.payment.findMany({ where: payWhere, take: 500, orderBy: { paidAt: "desc" },
          include: { invoice: { include: { items: true, student: { include: { user:{ select:{name:true} }, class:{ select:{name:true} } } } } }, receivedBy: { select: { name: true } } } }),
        prisma.payment.aggregate({ where: payWhere, _sum: { amount: true }, _count: true }),
      ]);

      return reply.send({ success: true, data: {
        payments: payments.map(p=>({ receiptNo:p.receiptNumber, studentName:p.invoice.student?.user.name, className:p.invoice.student?.class?.name, amount:Number(p.amount), mode:p.method, collectedBy:p.receivedBy?.name, paidAt:p.paidAt, items:p.invoice.items })),
        summary: { total:Number(total._sum.amount??0), count:total._count },
        filters: body,
      }});
    }
  );

  // ─── FORECASTING (simple projection) ──────────────────────
  app.get("/admin/finance-reports/forecast", { preHandler: [authenticate, requireCapability('finance.advancedReports')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const months = await Promise.all(Array.from({length:6},(_,i)=>{
        const d1=new Date(); d1.setDate(1); d1.setMonth(d1.getMonth()-(5-i));
        const d2=new Date(d1); d2.setMonth(d2.getMonth()+1);
        return prisma.payment.aggregate({ where:{invoice:{schoolId},paidAt:{gte:d1,lt:d2}}, _sum:{amount:true} })
          .then(r=>Number(r._sum.amount??0));
      }));
      const avg = months.reduce((a,b)=>a+b,0) / months.length;
      const trend = months.length>1 ? (months[months.length-1]-months[0])/months.length : 0;
      const forecast = Array.from({length:3},(_,i) => {
        const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()+i+1);
        return { month:d.toLocaleDateString("en-IN",{month:"short",year:"2-digit"}), expectedCollection:Math.max(0,avg+(trend*(i+1))) };
      });
      const totalDue = await prisma.invoice.aggregate({ where:{schoolId,status:{in:["PENDING","PARTIAL","OVERDUE"]}}, _sum:{dueAmount:true} });
      return reply.send({ success:true, data:{ forecast, avgMonthlyCollection:avg, expectedDue:Number(totalDue._sum.dueAmount??0) } });
    }
  );
}
