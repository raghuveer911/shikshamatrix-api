import { prisma } from "../lib/prisma.js";

export class PayslipError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface PayslipComponent {
  name: string;
  code: string;
  type: "EARNING" | "DEDUCTION";
  amount: number;
}

// Computes what a staff member's payslip for a given month WOULD look
// like, without saving anything — used both by generatePayslip() below
// and by a "preview before generating" endpoint if needed later.
export async function computePayslipForStaff(staffId: number, month: number, year: number) {
  const profile = await prisma.hrEmployeeSalaryProfile.findUnique({
    where: { staffId },
    include: { structure: { include: { components: { where: { isActive: true }, orderBy: { sortOrder: "asc" } } } } },
  });
  if (!profile) throw new PayslipError(400, "No salary profile assigned to this staff member yet.");

  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0, 23, 59, 59);

  const attendance = await prisma.staffAttendance.findMany({
    where: { staffId, date: { gte: monthStart, lte: monthEnd } },
  });

  const daysPresent = attendance.filter((a) => a.status === "PRESENT" || a.status === "LATE").length
    + attendance.filter((a) => a.status === "HALF_DAY").length * 0.5;
  const daysOnLeave = attendance.filter((a) => a.status === "ON_LEAVE").length;
  const daysAbsent = attendance.filter((a) => a.status === "ABSENT").length;
  // Simplification: unmarked absences are treated as loss-of-pay. A more
  // granular system would check whether the ON_LEAVE day's leave TYPE was
  // paid or unpaid — that link isn't wired up between StaffAttendance and
  // HrLeaveApplication yet, so ABSENT is the safe, conservative LOP signal.
  const lopDays = daysAbsent;

  const perDayGross = profile.grossSalary / daysInMonth;
  const lopDeduction = Math.round(perDayGross * lopDays * 100) / 100;

  const components: PayslipComponent[] = profile.structure.components.map((c) => {
    const amount = c.calcType === "PERCENTAGE" ? (profile.basicSalary * c.value) / 100 : c.value;
    return { name: c.name, code: c.code, type: c.type as "EARNING" | "DEDUCTION", amount: Math.round(amount * 100) / 100 };
  });

  if (lopDeduction > 0) {
    components.push({ name: "Loss of Pay", code: "LOP", type: "DEDUCTION", amount: lopDeduction });
  }

  const totalEarnings = components.filter((c) => c.type === "EARNING").reduce((s, c) => s + c.amount, 0);
  const totalDeductions = components.filter((c) => c.type === "DEDUCTION").reduce((s, c) => s + c.amount, 0);
  const netSalary = Math.round((totalEarnings - totalDeductions) * 100) / 100;

  return {
    profile, daysInMonth, daysPresent, daysAbsent, daysOnLeave, lopDays,
    components, totalEarnings, totalDeductions, netSalary,
  };
}

export async function generatePayslip(schoolId: number, staffId: number, month: number, year: number, generatedById: number) {
  const existing = await prisma.payslip.findUnique({ where: { staffId_month_year: { staffId, month, year } } });
  if (existing) throw new PayslipError(409, "A payslip for this staff member and month already exists.");

  const computed = await computePayslipForStaff(staffId, month, year);

  return prisma.payslip.create({
    data: {
      schoolId, staffId, month, year,
      basicSalary: computed.profile.basicSalary, grossSalary: computed.profile.grossSalary,
      totalEarnings: computed.totalEarnings, totalDeductions: computed.totalDeductions, netSalary: computed.netSalary,
      daysInMonth: computed.daysInMonth, daysPresent: computed.daysPresent, daysAbsent: computed.daysAbsent,
      daysOnLeave: computed.daysOnLeave, lopDays: computed.lopDays,
      components: computed.components as any,
      status: "GENERATED", generatedById,
    },
  });
}

export interface BulkGenerateResult {
  generated: number;
  skipped: { staffId: number; reason: string }[];
}

export async function generatePayslipsForMonth(schoolId: number, month: number, year: number, generatedById: number, staffIds?: number[]): Promise<BulkGenerateResult> {
  const where: any = { schoolId, isActive: true };
  if (staffIds?.length) where.id = { in: staffIds };

  const staffList = await prisma.staff.findMany({ where, select: { id: true } });
  const result: BulkGenerateResult = { generated: 0, skipped: [] };

  for (const s of staffList) {
    try {
      await generatePayslip(schoolId, s.id, month, year, generatedById);
      result.generated++;
    } catch (err) {
      const reason = err instanceof PayslipError ? err.message : "Unexpected error";
      result.skipped.push({ staffId: s.id, reason });
    }
  }

  return result;
}
