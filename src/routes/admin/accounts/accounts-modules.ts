import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../../lib/prisma.js";
import { authenticate } from "../../../middleware/authenticate.js";
import { requireCapability } from "../../../middleware/checkCapability.js";

// ═══════════════════════════════════════════════════════════
//  REIMBURSEMENTS
// ═══════════════════════════════════════════════════════════

async function genReqNo(schoolId: number, prefix = "REQ"): Promise<string> {
  const y = new Date().getFullYear().toString().slice(-2);
  const m = String(new Date().getMonth() + 1).padStart(2, "0");
  const cnt = await prisma.reimbursement.count({ where: { schoolId } });
  return `${prefix}-${y}${m}-${String(cnt + 1).padStart(4, "0")}`;
}

export async function adminReimbursementRoutes(app: FastifyInstance) {

  // GET /admin/reimbursements/meta
  app.get("/admin/reimbursements/meta", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const [byStatus, totals, staff] = await Promise.all([
        prisma.reimbursement.groupBy({ by: ["status"], where: { schoolId }, _count: true }),
        prisma.reimbursement.aggregate({ where: { schoolId }, _sum: { amount: true } }),
        prisma.staff.findMany({ where: { schoolId, isActive: true }, include: { user: { select: { id: true, name: true } } }, take: 80 }),
      ]);
      const byCategory = await prisma.reimbursement.groupBy({ by: ["category"], where: { schoolId }, _count: true, _sum: { amount: true } });
      const statusMap: Record<string, number> = {};
      byStatus.forEach(b => { statusMap[b.status] = b._count; });
      return reply.send({ success: true, data: {
        kpi: { pending:(statusMap.SUBMITTED??0)+(statusMap.UNDER_REVIEW??0), approved:statusMap.APPROVED??0, rejected:statusMap.REJECTED??0, paid:statusMap.PAID??0, total:Number(totals._sum.amount??0) },
        byCategory: byCategory.map(b => ({ category: b.category, count: b._count, amount: Number(b._sum.amount??0) })).sort((a,b)=>b.amount-a.amount),
        staff,
      }});
    }
  );

  // GET /admin/reimbursements
  app.get("/admin/reimbursements", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?:string; status?:string; category?:string; staffId?:string; search?:string };
      const page = Math.max(1, parseInt(q.page??"1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status)   where.status   = q.status;
      if (q.category) where.category = q.category;
      if (q.staffId)  where.staffId  = parseInt(q.staffId);
      if (q.search) where.OR = [
        { requestNo:   { contains: q.search, mode: "insensitive" } },
        { description: { contains: q.search, mode: "insensitive" } },
        { staff: { user: { name: { contains: q.search, mode: "insensitive" } } } },
      ];
      const [items, total] = await Promise.all([
        prisma.reimbursement.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" },
          include: { staff: { include: { user: { select: { name: true } } } }, createdBy: { select: { name: true } }, paidBy: { select: { name: true } } } }),
        prisma.reimbursement.count({ where }),
      ]);
      return reply.send({ success: true, data: { items, total, totalPages: Math.ceil(total/limit) } });
    }
  );

  // GET /admin/reimbursements/:id
  app.get("/admin/reimbursements/:id", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      const item = await prisma.reimbursement.findFirst({ where: { id: parseInt(id), schoolId },
        include: { staff: { include: { user: { select: { name: true } } } }, createdBy: { select: { name: true } },
          deptApprovedBy: { select: { name: true } }, principalApprovedBy: { select: { name: true } },
          accountsApprovedBy: { select: { name: true } }, rejectedBy: { select: { name: true } }, paidBy: { select: { name: true } } } });
      if (!item) return reply.status(404).send({ success: false, message: "Not found." });
      return reply.send({ success: true, data: { item } });
    }
  );

  // POST /admin/reimbursements
  app.post("/admin/reimbursements", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { staffId: number; department?: string; category: string; amount: number; expenseDate: string; description: string; attachmentUrls?: string[]; priority?: string };
      if (!body.staffId || !body.amount || !body.expenseDate) return reply.status(400).send({ success: false, message: "staffId, amount, expenseDate required." });
      const requestNo = await genReqNo(schoolId);
      const item = await prisma.reimbursement.create({ data: { schoolId, createdById: userId, requestNo, staffId: body.staffId, department: body.department??null, category: body.category as any??"OTHER", amount: body.amount, expenseDate: new Date(body.expenseDate), description: body.description, attachmentUrls: body.attachmentUrls??[], priority: body.priority as any??"MEDIUM", status: "SUBMITTED" } });
      return reply.status(201).send({ success: true, message: "Request submitted.", data: { id: item.id, requestNo } });
    }
  );

  // PATCH /admin/reimbursements/:id/approve
  app.patch("/admin/reimbursements/:id/approve", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { level } = req.body as { level: "DEPT"|"PRINCIPAL"|"ACCOUNTS" };
      const data: any = {};
      if (level === "DEPT")      { data.deptApprovedById = userId; data.deptApprovedAt = new Date(); data.status = "UNDER_REVIEW"; }
      if (level === "PRINCIPAL") { data.principalApprovedById = userId; data.principalApprovedAt = new Date(); data.status = "UNDER_REVIEW"; }
      if (level === "ACCOUNTS")  { data.accountsApprovedById = userId; data.accountsApprovedAt = new Date(); data.status = "APPROVED"; }
      await prisma.reimbursement.updateMany({ where: { id: parseInt(id), schoolId }, data });
      return reply.send({ success: true, message: `Approved at ${level} level.` });
    }
  );

  // PATCH /admin/reimbursements/:id/reject
  app.patch("/admin/reimbursements/:id/reject", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };
      await prisma.reimbursement.updateMany({ where: { id: parseInt(id), schoolId }, data: { status: "REJECTED", rejectedById: userId, rejectedAt: new Date(), rejectionReason: reason } });
      return reply.send({ success: true, message: "Rejected." });
    }
  );

  // PATCH /admin/reimbursements/:id/pay
  app.patch("/admin/reimbursements/:id/pay", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id: string };
      const { paymentDate, paymentMethod, transactionId, remarks } = req.body as { paymentDate: string; paymentMethod: string; transactionId?: string; remarks?: string };
      await prisma.reimbursement.updateMany({ where: { id: parseInt(id), schoolId, status: "APPROVED" }, data: { status: "PAID", paidById: userId, paidAt: new Date(), paymentDate: new Date(paymentDate), paymentMethod, transactionId: transactionId??null, remarks: remarks??null } });
      return reply.send({ success: true, message: "Payment recorded." });
    }
  );

  // DELETE /admin/reimbursements/:id
  app.delete("/admin/reimbursements/:id", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id: string };
      await prisma.reimbursement.deleteMany({ where: { id: parseInt(id), schoolId, status: { in: ["DRAFT","REJECTED"] } } });
      return reply.send({ success: true });
    }
  );

  // GET /admin/reimbursements/reports
  app.get("/admin/reimbursements/reports", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?:string; to?:string };
      const where: any = { schoolId };
      if (q.from||q.to) { where.createdAt={}; if(q.from) where.createdAt.gte=new Date(q.from); if(q.to) where.createdAt.lte=new Date(q.to); }
      const [byStatus, byCategory, byDept, totals] = await Promise.all([
        prisma.reimbursement.groupBy({ by:["status"],   where, _count:true, _sum:{ amount:true } }),
        prisma.reimbursement.groupBy({ by:["category"], where, _count:true, _sum:{ amount:true } }),
        prisma.reimbursement.groupBy({ by:["department"], where:{ ...where, department:{ not:null } }, _count:true, _sum:{ amount:true } }),
        prisma.reimbursement.aggregate({ where, _sum:{ amount:true }, _avg:{ amount:true } }),
      ]);
      return reply.send({ success: true, data: {
        byStatus:   byStatus.map(b=>({ status:b.status,   count:b._count, amount:Number(b._sum.amount??0) })),
        byCategory: byCategory.map(b=>({ category:b.category, count:b._count, amount:Number(b._sum.amount??0) })).sort((a,b)=>b.amount-a.amount),
        byDept:     byDept.map(b=>({ dept:b.department!, count:b._count, amount:Number(b._sum.amount??0) })),
        totals:{ total:Number(totals._sum.amount??0), avg:Math.round(Number(totals._avg.amount??0)) },
      }});
    }
  );
}

// ═══════════════════════════════════════════════════════════
//  ADVANCES & LOANS
// ═══════════════════════════════════════════════════════════

async function genLoanNo(schoolId: number): Promise<string> {
  const y = new Date().getFullYear().toString().slice(-2);
  const m = String(new Date().getMonth() + 1).padStart(2, "0");
  const cnt = await prisma.staffLoan.count({ where: { schoolId } });
  return `LN-${y}${m}-${String(cnt + 1).padStart(4, "0")}`;
}

function calcEmi(principal: number, annualRate: number, months: number, type: string): { emi: number; total: number } {
  if (annualRate === 0 || type === "SIMPLE") {
    const interest = annualRate > 0 ? (principal * annualRate * months) / (12 * 100) : 0;
    const total = principal + interest;
    return { emi: Math.ceil(total / months), total: Math.round(total) };
  }
  // Compound / reducing balance
  const r = annualRate / (12 * 100);
  const emi = Math.ceil(principal * r * Math.pow(1 + r, months) / (Math.pow(1 + r, months) - 1));
  return { emi, total: emi * months };
}

export async function adminLoansRoutes(app: FastifyInstance) {

  // GET /admin/loans/meta
  app.get("/admin/loans/meta", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date(); const m = now.getMonth()+1; const y = now.getFullYear();
      const [byStatus, outstanding, emiDue, staff] = await Promise.all([
        prisma.staffLoan.groupBy({ by:["status"], where:{ schoolId }, _count:true }),
        prisma.staffLoan.aggregate({ where:{ schoolId, status:{ in:["ACTIVE","DISBURSED"] } }, _sum:{ outstandingAmount:true } }),
        prisma.loanEmi.aggregate({ where:{ schoolId, dueMonth:m, dueYear:y, status:{ in:["PENDING","PARTIAL"] } }, _sum:{ dueAmount:true } }),
        prisma.staff.findMany({ where:{ schoolId, isActive:true }, include:{ user:{ select:{ id:true, name:true } } }, take:80 }),
      ]);
      const sm: Record<string,number>={};
      byStatus.forEach(b=>{ sm[b.status]=b._count; });
      return reply.send({ success:true, data:{
        kpi:{ activeLoans:(sm.ACTIVE??0)+(sm.DISBURSED??0), pendingLoans:sm.PENDING??0, closedLoans:sm.CLOSED??0, outstanding:Number(outstanding._sum.outstandingAmount??0), emiDue:Number(emiDue._sum.dueAmount??0) },
        staff,
      }});
    }
  );

  // GET /admin/loans
  app.get("/admin/loans", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?:string; status?:string; type?:string; staffId?:string; search?:string };
      const page = Math.max(1, parseInt(q.page??"1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status)  where.status   = q.status;
      if (q.type)    where.loanType = q.type;
      if (q.staffId) where.staffId  = parseInt(q.staffId);
      if (q.search) where.OR = [
        { loanNo: { contains:q.search, mode:"insensitive" } },
        { staff:  { user: { name: { contains:q.search, mode:"insensitive" } } } },
      ];
      const [loans, total] = await Promise.all([
        prisma.staffLoan.findMany({ where, skip:(page-1)*limit, take:limit, orderBy:{ createdAt:"desc" },
          include:{ staff:{ include:{ user:{ select:{ name:true } } } }, _count:{ select:{ emis:true } } } }),
        prisma.staffLoan.count({ where }),
      ]);
      return reply.send({ success:true, data:{ loans, total, totalPages:Math.ceil(total/limit) } });
    }
  );

  // GET /admin/loans/:id
  app.get("/admin/loans/:id", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id:string };
      const loan = await prisma.staffLoan.findFirst({ where:{ id:parseInt(id), schoolId },
        include:{ staff:{ include:{ user:{ select:{ name:true } } } }, emis:{ orderBy:{ emiNumber:"asc" } },
          principalApprovedBy:{ select:{ name:true } }, accountsApprovedBy:{ select:{ name:true } },
          disbursedBy:{ select:{ name:true } }, rejectedBy:{ select:{ name:true } } } });
      if (!loan) return reply.status(404).send({ success:false, message:"Not found." });
      return reply.send({ success:true, data:{ loan } });
    }
  );

  // POST /admin/loans
  app.post("/admin/loans", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { staffId:number; loanType:string; requestedAmount:number; reason:string; tenureMonths:number; isInterestFree?:boolean; interestRate?:number; interestType?:string; recoveryStartMonth?:number; recoveryStartYear?:number };
      const loanNo = await genLoanNo(schoolId);
      const { emi, total } = calcEmi(body.requestedAmount, body.interestRate??0, body.tenureMonths, body.interestType??"SIMPLE");
      const loan = await prisma.staffLoan.create({ data: { schoolId, createdById:userId, loanNo, staffId:body.staffId, loanType:body.loanType as any??"PERSONAL", requestedAmount:body.requestedAmount, reason:body.reason, tenureMonths:body.tenureMonths, isInterestFree:body.isInterestFree??true, interestRate:body.interestRate??0, interestType:body.interestType??"SIMPLE", emiAmount:emi, totalPayable:total, outstandingAmount:body.requestedAmount, recoveryStartMonth:body.recoveryStartMonth??null, recoveryStartYear:body.recoveryStartYear??null, status:"PENDING" } });
      return reply.status(201).send({ success:true, message:"Loan request submitted.", data:{ id:loan.id, loanNo, emi, total } });
    }
  );

  // PATCH /admin/loans/:id/approve
  app.patch("/admin/loans/:id/approve", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id:string };
      const { level, approvedAmount } = req.body as { level:"PRINCIPAL"|"ACCOUNTS"|"MANAGEMENT"; approvedAmount?:number };
      const data: any = {};
      if (level==="PRINCIPAL") { data.principalApprovedById=userId; data.principalApprovedAt=new Date(); }
      if (level==="ACCOUNTS")  { data.accountsApprovedById=userId;  data.accountsApprovedAt=new Date(); data.status="APPROVED"; if(approvedAmount) data.approvedAmount=approvedAmount; }
      if (level==="MANAGEMENT"){ data.mgmtApprovedById=userId;      data.mgmtApprovedAt=new Date(); }
      await prisma.staffLoan.updateMany({ where:{ id:parseInt(id), schoolId }, data });
      return reply.send({ success:true, message:`Approved at ${level}.` });
    }
  );

  // PATCH /admin/loans/:id/reject
  app.patch("/admin/loans/:id/reject", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id:string };
      const { reason } = req.body as { reason:string };
      await prisma.staffLoan.updateMany({ where:{ id:parseInt(id), schoolId }, data:{ status:"REJECTED", rejectedById:userId, rejectedAt:new Date(), rejectionReason:reason } });
      return reply.send({ success:true });
    }
  );

  // POST /admin/loans/:id/disburse
  app.post("/admin/loans/:id/disburse", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id:string };
      const { disbursementDate, disbursementMode, disbursementRef, recoveryStartMonth, recoveryStartYear } = req.body as { disbursementDate:string; disbursementMode:string; disbursementRef?:string; recoveryStartMonth:number; recoveryStartYear:number };

      const loan = await prisma.staffLoan.findFirst({ where:{ id:parseInt(id), schoolId, status:"APPROVED" } });
      if (!loan) return reply.status(400).send({ success:false, message:"Loan not approved or not found." });

      const disbAmt = Number(loan.approvedAmount??loan.requestedAmount);
      const { emi, total } = calcEmi(disbAmt, Number(loan.interestRate), loan.tenureMonths, loan.interestType);

      await prisma.staffLoan.update({ where:{ id:parseInt(id) }, data:{ status:"ACTIVE", disbursedAmount:disbAmt, disbursementDate:new Date(disbursementDate), disbursementMode, disbursementRef:disbursementRef??null, disbursedById:userId, recoveryStartMonth, recoveryStartYear, emiAmount:emi, totalPayable:total, outstandingAmount:disbAmt, paidAmount:0 } });

      // Generate EMI schedule
      const emis = [];
      for (let i = 0; i < loan.tenureMonths; i++) {
        const emiDate = new Date(recoveryStartYear, recoveryStartMonth - 1 + i, 1);
        emis.push({ schoolId, loanId: parseInt(id), emiNumber: i+1, dueMonth: emiDate.getMonth()+1, dueYear: emiDate.getFullYear(), dueAmount: i === loan.tenureMonths-1 ? total - emi*(loan.tenureMonths-1) : emi });
      }
      await prisma.loanEmi.createMany({ data: emis });

      return reply.send({ success:true, message:"Loan disbursed & EMI schedule created.", data:{ disbursedAmount:disbAmt, emi, totalPayable:total } });
    }
  );

  // GET /admin/loans/emis — EMIs due this month
  app.get("/admin/loans/emis", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date(); const m = now.getMonth()+1; const y = now.getFullYear();
      const emis = await prisma.loanEmi.findMany({
        where:{ schoolId, dueMonth:m, dueYear:y },
        include:{ loan:{ include:{ staff:{ include:{ user:{ select:{ name:true } } } } } } },
        orderBy:{ dueAmount:"desc" },
      });
      return reply.send({ success:true, data:{ emis } });
    }
  );

  // PATCH /admin/loans/emis/:id/pay
  app.patch("/admin/loans/emis/:id/pay", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id:string };
      const { paidAmount, deductedFromSalary, remarks } = req.body as { paidAmount:number; deductedFromSalary?:boolean; remarks?:string };
      const emi = await prisma.loanEmi.findFirst({ where:{ id:parseInt(id), schoolId } });
      if (!emi) return reply.status(404).send({ success:false, message:"EMI not found." });

      const status = paidAmount >= Number(emi.dueAmount) ? "PAID" : "PARTIAL";
      await prisma.loanEmi.update({ where:{ id:parseInt(id) }, data:{ paidAmount, status:status as any, paidAt:new Date(), deductedFromSalary:deductedFromSalary??false, remarks:remarks??null } });

      // Update loan outstanding
      const loan = await prisma.staffLoan.findFirst({ where:{ id:emi.loanId } });
      if (loan) {
        const newPaid = Number(loan.paidAmount) + paidAmount;
        const newOutstanding = Math.max(0, Number(loan.totalPayable??loan.requestedAmount) - newPaid);
        const allPaid = await prisma.loanEmi.count({ where:{ loanId:emi.loanId, status:{ notIn:["PAID"] } } });
        await prisma.staffLoan.update({ where:{ id:emi.loanId }, data:{ paidAmount:newPaid, outstandingAmount:newOutstanding, status: allPaid===1&&status==="PAID" ? "CLOSED" : "ACTIVE", closedAt: allPaid===1&&status==="PAID" ? new Date() : null } });
      }
      return reply.send({ success:true, message:"EMI recorded." });
    }
  );

  // GET /admin/loans/reports
  app.get("/admin/loans/reports", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const active = await prisma.staffLoan.findMany({ where:{ schoolId, status:{ in:["ACTIVE","DISBURSED"] } },
        include:{ staff:{ include:{ user:{ select:{ name:true } } } }, emis:{ where:{ status:{ notIn:["PAID"] } } } } });
      const summary = active.map(l=>({ id:l.id, loanNo:l.loanNo, staffName:l.staff.user.name, loanType:l.loanType, disbursed:Number(l.disbursedAmount??0), paid:Number(l.paidAmount), outstanding:Number(l.outstandingAmount??0), emiAmt:Number(l.emiAmount??0), pendingEmis:l.emis.length }));
      return reply.send({ success:true, data:{ summary } });
    }
  );
}

// ═══════════════════════════════════════════════════════════
//  EXPENSE APPROVALS
// ═══════════════════════════════════════════════════════════

async function genExpNo(schoolId: number): Promise<string> {
  const y = new Date().getFullYear().toString().slice(-2);
  const m = String(new Date().getMonth() + 1).padStart(2, "0");
  const cnt = await prisma.expenseRequest.count({ where: { schoolId } });
  return `EXP-${y}${m}-${String(cnt + 1).padStart(4, "0")}`;
}

export async function adminExpenseRoutes(app: FastifyInstance) {

  // GET /admin/expenses/meta
  app.get("/admin/expenses/meta", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const now = new Date(); const fy = now.getMonth()<3 ? now.getFullYear()-1 : now.getFullYear();
      const [byStatus, totals, budgets, byDept, byCategory] = await Promise.all([
        prisma.expenseRequest.groupBy({ by:["status"], where:{ schoolId }, _count:true }),
        prisma.expenseRequest.aggregate({ where:{ schoolId, status:{ in:["APPROVED","PAID"] } }, _sum:{ amount:true } }),
        prisma.departmentBudget.findMany({ where:{ schoolId, fiscalYear:fy } }),
        prisma.expenseRequest.groupBy({ by:["department"], where:{ schoolId }, _count:true, _sum:{ amount:true } }),
        prisma.expenseRequest.groupBy({ by:["category"],   where:{ schoolId }, _count:true, _sum:{ amount:true } }),
      ]);
      const sm: Record<string,number>={};
      byStatus.forEach(b=>{ sm[b.status]=b._count; });
      const totalBudget = budgets.reduce((s,b)=>s+Number(b.totalBudget),0);
      const usedBudget  = budgets.reduce((s,b)=>s+Number(b.usedAmount),0);
      return reply.send({ success:true, data:{
        kpi:{ pending:(sm.SUBMITTED??0)+(sm.UNDER_REVIEW??0), approved:Number(totals._sum.amount??0), rejected:sm.REJECTED??0, budgetUtilized:totalBudget>0?Math.round((usedBudget/totalBudget)*100):0 },
        budgets, byDept:byDept.map(b=>({ dept:b.department, count:b._count, amount:Number(b._sum.amount??0) })),
        byCategory:byCategory.map(b=>({ cat:b.category, count:b._count, amount:Number(b._sum.amount??0) })).sort((a,b)=>b.amount-a.amount),
      }});
    }
  );

  // POST /admin/expenses/budgets — upsert department budget
  app.post("/admin/expenses/budgets", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { department, fiscalYear, totalBudget } = req.body as { department:string; fiscalYear:number; totalBudget:number };
      await prisma.departmentBudget.upsert({ where:{ schoolId_department_fiscalYear:{ schoolId, department:department as any, fiscalYear } }, create:{ schoolId, department:department as any, fiscalYear, totalBudget }, update:{ totalBudget } });
      return reply.send({ success:true, message:"Budget set." });
    }
  );

  // GET /admin/expenses
  app.get("/admin/expenses", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { page?:string; status?:string; department?:string; category?:string; search?:string };
      const page = Math.max(1, parseInt(q.page??"1")); const limit = 20;
      const where: any = { schoolId };
      if (q.status)     where.status     = q.status;
      if (q.department) where.department = q.department;
      if (q.category)   where.category   = q.category;
      if (q.search) where.OR=[{ expenseNo:{ contains:q.search, mode:"insensitive" } },{ description:{ contains:q.search, mode:"insensitive" } },{ vendorName:{ contains:q.search, mode:"insensitive" } }];
      const [items, total] = await Promise.all([
        prisma.expenseRequest.findMany({ where, skip:(page-1)*limit, take:limit, orderBy:{ createdAt:"desc" },
          include:{ createdBy:{ select:{ name:true } }, deptApprovedBy:{ select:{ name:true } }, principalApprovedBy:{ select:{ name:true } }, accountsApprovedBy:{ select:{ name:true } }, paidBy:{ select:{ name:true } } } }),
        prisma.expenseRequest.count({ where }),
      ]);
      return reply.send({ success:true, data:{ items, total, totalPages:Math.ceil(total/limit) } });
    }
  );

  // POST /admin/expenses
  app.post("/admin/expenses", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const body = req.body as { department:string; category:string; amount:number; expenseDate:string; vendorName?:string; description:string; attachmentUrls?:string[] };
      if (!body.amount || !body.expenseDate || !body.description) return reply.status(400).send({ success:false, message:"amount, expenseDate, description required." });
      const expenseNo = await genExpNo(schoolId);
      const requiresMgmt = body.amount > 50000;
      const item = await prisma.expenseRequest.create({ data:{ schoolId, createdById:userId, expenseNo, department:body.department as any??"ADMINISTRATION", category:body.category as any??"OTHER", amount:body.amount, expenseDate:new Date(body.expenseDate), vendorName:body.vendorName??null, description:body.description, attachmentUrls:body.attachmentUrls??[], requiresMgmt, status:"SUBMITTED" } });
      return reply.status(201).send({ success:true, message:"Expense request submitted.", data:{ id:item.id, expenseNo, requiresMgmt } });
    }
  );

  // PATCH /admin/expenses/:id/approve
  app.patch("/admin/expenses/:id/approve", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id:string };
      const { level } = req.body as { level:"DEPT"|"PRINCIPAL"|"ACCOUNTS"|"MANAGEMENT" };
      const data: any = {};
      if (level==="DEPT")       { data.deptApprovedById=userId;      data.deptApprovedAt=new Date();      data.status="UNDER_REVIEW"; }
      if (level==="PRINCIPAL")  { data.principalApprovedById=userId; data.principalApprovedAt=new Date(); data.status="UNDER_REVIEW"; }
      if (level==="MANAGEMENT") { data.mgmtApprovedById=userId;      data.mgmtApprovedAt=new Date(); }
      if (level==="ACCOUNTS")   { data.accountsApprovedById=userId;  data.accountsApprovedAt=new Date();  data.status="APPROVED"; }

      await prisma.expenseRequest.updateMany({ where:{ id:parseInt(id), schoolId }, data });

      // Update budget usage
      if (level==="ACCOUNTS") {
        const exp = await prisma.expenseRequest.findFirst({ where:{ id:parseInt(id) } });
        if (exp) {
          const fy = new Date().getMonth()<3 ? new Date().getFullYear()-1 : new Date().getFullYear();
          await prisma.departmentBudget.updateMany({ where:{ schoolId, department:exp.department, fiscalYear:fy }, data:{ usedAmount:{ increment:Number(exp.amount) } } });
        }
      }
      return reply.send({ success:true, message:`Approved at ${level}.` });
    }
  );

  // PATCH /admin/expenses/:id/reject
  app.patch("/admin/expenses/:id/reject", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id:string };
      const { reason } = req.body as { reason:string };
      await prisma.expenseRequest.updateMany({ where:{ id:parseInt(id), schoolId }, data:{ status:"REJECTED", rejectedById:userId, rejectedAt:new Date(), rejectionReason:reason } });
      return reply.send({ success:true });
    }
  );

  // PATCH /admin/expenses/:id/pay
  app.patch("/admin/expenses/:id/pay", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId, userId } = req.user as any;
      const { id } = req.params as { id:string };
      const { paymentDate, paymentMethod, transactionId } = req.body as { paymentDate:string; paymentMethod:string; transactionId?:string };
      await prisma.expenseRequest.updateMany({ where:{ id:parseInt(id), schoolId, status:"APPROVED" }, data:{ status:"PAID", paidById:userId, paidAt:new Date(), paymentDate:new Date(paymentDate), paymentMethod, transactionId:transactionId??null } });
      return reply.send({ success:true, message:"Payment recorded." });
    }
  );

  // DELETE /admin/expenses/:id
  app.delete("/admin/expenses/:id", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const { id } = req.params as { id:string };
      await prisma.expenseRequest.deleteMany({ where:{ id:parseInt(id), schoolId, status:{ in:["DRAFT","REJECTED"] } } });
      return reply.send({ success:true });
    }
  );

  // GET /admin/expenses/reports
  app.get("/admin/expenses/reports", { preHandler: [authenticate, requireCapability('accounts.basic')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { schoolId } = req.user as any;
      const q = req.query as { from?:string; to?:string };
      const where: any = { schoolId };
      if (q.from||q.to) { where.createdAt={}; if(q.from) where.createdAt.gte=new Date(q.from); if(q.to) where.createdAt.lte=new Date(q.to); }
      const [byDept, byCat, byStatus, totals, budgets] = await Promise.all([
        prisma.expenseRequest.groupBy({ by:["department"], where, _count:true, _sum:{ amount:true } }),
        prisma.expenseRequest.groupBy({ by:["category"],   where, _count:true, _sum:{ amount:true } }),
        prisma.expenseRequest.groupBy({ by:["status"],     where, _count:true, _sum:{ amount:true } }),
        prisma.expenseRequest.aggregate({ where, _sum:{ amount:true } }),
        prisma.departmentBudget.findMany({ where:{ schoolId } }),
      ]);
      return reply.send({ success:true, data:{
        byDept: byDept.map(b=>({ dept:b.department, count:b._count, amount:Number(b._sum.amount??0) })).sort((a,b)=>b.amount-a.amount),
        byCat:  byCat.map(b=>({ cat:b.category, count:b._count, amount:Number(b._sum.amount??0) })).sort((a,b)=>b.amount-a.amount),
        byStatus:byStatus.map(b=>({ status:b.status, count:b._count, amount:Number(b._sum.amount??0) })),
        total:  Number(totals._sum.amount??0), budgets,
      }});
    }
  );
}
