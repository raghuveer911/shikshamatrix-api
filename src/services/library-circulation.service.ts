import { prisma } from "../lib/prisma.js";

export async function calcDueDate(schoolId: number, memberType: string): Promise<Date> {
  const settings = await prisma.libSettings.findUnique({ where: { schoolId } });
  const days = memberType === "STUDENT" ? (settings?.studentDueDays ?? 14)
    : memberType === "TEACHER" ? (settings?.teacherDueDays ?? 30)
    : memberType === "STAFF" ? (settings?.staffDueDays ?? 21)
    : (settings?.parentDueDays ?? 14);
  const due = new Date();
  due.setDate(due.getDate() + days);
  return due;
}

export async function calcFine(schoolId: number, overdueDays: number, reason = "LATE_RETURN"): Promise<{ ratePerDay: number; totalAmount: number }> {
  const settings = await prisma.libSettings.findUnique({ where: { schoolId } });
  const grace = settings?.fineGracePeriodDays ?? 0;
  const rate = Number(settings?.fineRatePerDay ?? 2);
  const chargeable = Math.max(0, overdueDays - grace);
  const totalAmount = chargeable * rate
    + (reason === "DAMAGE" ? Number(settings?.fineDamageRate ?? 100) : 0)
    + (reason === "LOSS" ? Number(settings?.fineLossRate ?? 500) : 0);
  return { ratePerDay: rate, totalAmount };
}

export class LibraryError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function getMemberBorrowingProfile(schoolId: number, memberType: string, memberId: number) {
  const settings = await prisma.libSettings.findUnique({ where: { schoolId } });
  const maxBooks = memberType === "STUDENT" ? (settings?.maxBooksStudent ?? 3)
    : memberType === "TEACHER" ? (settings?.maxBooksTeacher ?? 5)
    : (settings?.maxBooksStaff ?? 3);

  const activeIssues = await prisma.libIssue.findMany({
    where: {
      schoolId, status: { in: ["ACTIVE", "OVERDUE"] },
      ...(memberType === "STUDENT" ? { studentId: memberId } : { staffId: memberId }),
    },
    include: { copy: { include: { book: { select: { title: true, isbn: true } } } } },
  });

  const pendingFines = await prisma.libFine.aggregate({
    where: {
      schoolId, status: "PENDING",
      ...(memberType === "STUDENT" ? { studentId: memberId } : { staffId: memberId }),
    },
    _sum: { totalAmount: true },
  });

  return {
    activeIssues,
    pendingFines: Number(pendingFines._sum.totalAmount ?? 0),
    canIssueMore: activeIssues.length < maxBooks,
    maxBooks,
    activeCount: activeIssues.length,
  };
}

export interface IssueBookInput {
  copyId: number;
  memberId: number;
  memberType: string; // STUDENT | TEACHER | STAFF | PARENT
  issuedByStaffId: number | null;
}

export async function issueBook(schoolId: number, input: IssueBookInput) {
  const copy = await prisma.libBookCopy.findFirst({ where: { id: input.copyId, schoolId } });
  if (!copy) throw new LibraryError(404, "Copy not found.");
  if (copy.status !== "AVAILABLE") throw new LibraryError(409, `This copy is ${copy.status.toLowerCase()} — can't issue right now.`);

  const profile = await getMemberBorrowingProfile(schoolId, input.memberType, input.memberId);
  if (!profile.canIssueMore) throw new LibraryError(409, `This member has reached their borrowing limit (${profile.maxBooks} books).`);
  if (profile.pendingFines > 0) throw new LibraryError(409, `This member has ₹${profile.pendingFines} in pending fines — please clear before issuing more books.`);

  const dueDate = await calcDueDate(schoolId, input.memberType);

  const issue = await prisma.libIssue.create({
    data: {
      schoolId, copyId: input.copyId,
      memberType: input.memberType as any,
      studentId: input.memberType === "STUDENT" ? input.memberId : null,
      staffId: ["TEACHER", "STAFF"].includes(input.memberType) ? input.memberId : null,
      issueDate: new Date(), dueDate, status: "ACTIVE",
      issuedById: input.issuedByStaffId,
    },
    include: {
      copy: { include: { book: { select: { title: true, isbn: true } } } },
      student: { include: { user: { select: { name: true } } } },
      staff: { include: { user: { select: { name: true } } } },
    },
  });

  await prisma.libBookCopy.update({ where: { id: input.copyId }, data: { status: "ISSUED" } });

  return issue;
}

export interface ReturnBookInput {
  issueId: number;
  condition?: string; // GOOD | DAMAGED | LOST
  notes?: string;
  returnedByStaffId: number | null;
}

export async function returnBook(schoolId: number, input: ReturnBookInput) {
  const issue = await prisma.libIssue.findFirst({ where: { id: input.issueId, schoolId, status: { in: ["ACTIVE", "OVERDUE"] } } });
  if (!issue) throw new LibraryError(404, "Active issue not found.");

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dueDate = new Date(issue.dueDate); dueDate.setHours(0, 0, 0, 0);
  const isLate = today > dueDate;
  const overdueDays = isLate ? Math.floor((today.getTime() - dueDate.getTime()) / 86400000) : 0;
  const returnCondition = input.condition ?? "GOOD";
  const newStatus = returnCondition === "LOST" ? "LOST" : "RETURNED";

  await prisma.libIssue.update({
    where: { id: input.issueId },
    data: {
      status: newStatus as any, returnDate: today, returnCondition,
      returnNotes: input.notes ?? null, returnedById: input.returnedByStaffId,
    },
  });

  const copyStatus = returnCondition === "LOST" ? "LOST" : returnCondition === "DAMAGED" ? "DAMAGED" : "AVAILABLE";
  await prisma.libBookCopy.update({
    where: { id: issue.copyId },
    data: { status: copyStatus as any, damagedAt: returnCondition === "DAMAGED" ? new Date() : undefined, lostAt: returnCondition === "LOST" ? new Date() : undefined },
  });

  let fine = null;
  const settings = await prisma.libSettings.findUnique({ where: { schoolId } });
  if (settings?.fineEnabled && (isLate || returnCondition !== "GOOD")) {
    const reason = returnCondition === "LOST" ? "LOSS" : returnCondition === "DAMAGED" ? "DAMAGE" : "LATE_RETURN";
    const fineCalc = await calcFine(schoolId, overdueDays, reason);
    if (fineCalc.totalAmount > 0) {
      fine = await prisma.libFine.create({
        data: {
          schoolId, issueId: input.issueId, memberType: issue.memberType,
          studentId: issue.studentId, staffId: issue.staffId,
          overdueDays, ratePerDay: fineCalc.ratePerDay,
          extraCharge: reason !== "LATE_RETURN" ? (reason === "LOSS" ? Number(settings.fineLossRate) : Number(settings.fineDamageRate)) : 0,
          totalAmount: fineCalc.totalAmount, reason,
        },
      });
    }
  }

  return { isLate, overdueDays, copyStatus, fine, newStatus };
}
