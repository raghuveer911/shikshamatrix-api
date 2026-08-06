import PDFDocument from "pdfkit";

export interface FeeReceiptItem {
  description: string;
  amount: number;
}

export interface FeeReceiptData {
  receiptNo: string;
  issuedAt: Date;
  schoolName: string;
  schoolAddress?: string | null;
  schoolPhone?: string | null;
  schoolEmail?: string | null;
  schoolLogoUrl?: string | null;

  studentName: string;
  admissionNumber?: string | null;
  rollNumber?: string | null;
  className?: string | null;
  fatherName?: string | null;

  academicYear: string;
  items: FeeReceiptItem[];
  fineAmount?: number;
  discountAmount?: number;
  amountPaid: number;
  dueAfter: number;

  paymentMode: string;
  transactionRef?: string | null;
  remarks?: string | null;
  receivedBy?: string | null;

  verifyUrl: string;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

/** Converts a whole-rupee amount into words using the Indian numbering
 *  system (lakh/crore, not thousand/million) — matches how receipts are
 *  conventionally worded in India, e.g. "Twelve Thousand Five Hundred". */
function numberToWordsIndian(n: number): string {
  if (n === 0) return "Zero";
  const twoDigits = (num: number): string => {
    if (num < 20) return ONES[num];
    return TENS[Math.floor(num / 10)] + (num % 10 ? " " + ONES[num % 10] : "");
  };
  const threeDigits = (num: number): string => {
    if (num < 100) return twoDigits(num);
    return ONES[Math.floor(num / 100)] + " Hundred" + (num % 100 ? " " + twoDigits(num % 100) : "");
  };

  let remaining = Math.floor(n);
  const crore = Math.floor(remaining / 10000000); remaining %= 10000000;
  const lakh = Math.floor(remaining / 100000); remaining %= 100000;
  const thousand = Math.floor(remaining / 1000); remaining %= 1000;
  const hundred = remaining;

  const parts: string[] = [];
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${threeDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigits(thousand)} Thousand`);
  if (hundred) parts.push(threeDigits(hundred));
  return parts.join(" ");
}

/**
 * Renders a fee receipt as a PDF buffer — school letterhead, a clear
 * amount-paid banner, an itemized installment breakdown, fine/discount
 * called out separately, amount in words (the convention Indian
 * receipts are checked against), and a verify-this-receipt link at the
 * bottom instead of a QR image (no QR library is wired up yet — this
 * still lets anyone confirm authenticity by opening the link).
 */
export function generateFeeReceiptPdf(data: FeeReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const PAGE_W = 595.28; // A4 width in points
    const MARGIN = 44;
    const CONTENT_W = PAGE_W - MARGIN * 2;
    const INDIGO = "#4f46e5";
    const INDIGO_LIGHT = "#eef2ff";
    const INK = "#111827";
    const MUTED = "#6b7280";
    const BORDER = "#e5e7eb";
    const GREEN = "#059669";
    const GREEN_LIGHT = "#ecfdf5";

    const fmtDate = (d: Date) =>
      d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    const fmtDateTime = (d: Date) =>
      d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
    const fmtMoney = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    /* ── Top brand band ─────────────────────────────────── */
    doc.rect(0, 0, PAGE_W, 8).fill(INDIGO);

    let y = 34;
    doc.fontSize(19).fillColor(INDIGO).font("Helvetica-Bold").text(data.schoolName, MARGIN, y);
    doc.font("Helvetica");
    y += 24;
    const contactLine = [data.schoolAddress, data.schoolPhone, data.schoolEmail].filter(Boolean).join("  •  ");
    if (contactLine) {
      doc.fontSize(8.5).fillColor(MUTED).text(contactLine, MARGIN, y, { width: 330 });
    }

    doc.fontSize(20).fillColor(INK).font("Helvetica-Bold").text("FEE RECEIPT", 0, 34, { width: PAGE_W - MARGIN, align: "right" });
    doc.font("Helvetica");
    doc.fontSize(9).fillColor(MUTED)
      .text(`Receipt No: ${data.receiptNo}`, 0, 60, { width: PAGE_W - MARGIN, align: "right" })
      .text(`Date: ${fmtDate(data.issuedAt)}`, 0, 73, { width: PAGE_W - MARGIN, align: "right" })
      .text(`Session: ${data.academicYear}`, 0, 86, { width: PAGE_W - MARGIN, align: "right" });

    y = 118;
    doc.moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y).strokeColor(BORDER).lineWidth(1).stroke();

    /* ── Student panel ──────────────────────────────────── */
    y += 20;
    doc.roundedRect(MARGIN, y, CONTENT_W, 74, 8).fillAndStroke("#fafafa", BORDER);
    const colW = CONTENT_W / 2;
    doc.fontSize(8).fillColor(MUTED).font("Helvetica-Bold").text("STUDENT", MARGIN + 16, y + 14);
    doc.fontSize(12.5).fillColor(INK).font("Helvetica-Bold").text(data.studentName, MARGIN + 16, y + 27);
    doc.fontSize(9).fillColor(MUTED).font("Helvetica")
      .text(`Class: ${data.className ?? "—"}   Roll: ${data.rollNumber ?? "—"}`, MARGIN + 16, y + 46);
    if (data.admissionNumber) {
      doc.text(`Admission No: ${data.admissionNumber}`, MARGIN + 16, y + 60);
    }

    doc.fontSize(8).fillColor(MUTED).font("Helvetica-Bold").text("PARENT / GUARDIAN", MARGIN + colW, y + 14);
    doc.fontSize(11).fillColor(INK).font("Helvetica").text(data.fatherName ?? "—", MARGIN + colW, y + 30, { width: colW - 24 });

    /* ── Amount paid banner ─────────────────────────────── */
    y += 74 + 16;
    doc.roundedRect(MARGIN, y, CONTENT_W, 52, 8).fill(GREEN_LIGHT);
    doc.fontSize(9).fillColor(GREEN).font("Helvetica-Bold").text("AMOUNT RECEIVED", MARGIN + 16, y + 12);
    doc.fontSize(21).fillColor(GREEN).font("Helvetica-Bold").text(fmtMoney(data.amountPaid), MARGIN + 16, y + 24);
    doc.fontSize(9).fillColor(MUTED).font("Helvetica")
      .text(data.paymentMode.replace(/_/g, " "), MARGIN, y + 12, { width: CONTENT_W - 16, align: "right" });
    if (data.transactionRef) {
      doc.fontSize(8.5).fillColor(MUTED).text(`Ref: ${data.transactionRef}`, MARGIN, y + 28, { width: CONTENT_W - 16, align: "right" });
    }

    /* ── Itemized table ─────────────────────────────────── */
    y += 52 + 24;
    doc.fontSize(9.5).fillColor(INK).font("Helvetica-Bold");
    doc.rect(MARGIN, y, CONTENT_W, 24).fill(INDIGO);
    doc.fillColor("#fff").text("Description", MARGIN + 12, y + 7);
    doc.text("Amount", MARGIN, y + 7, { width: CONTENT_W - 12, align: "right" });
    y += 24;

    doc.font("Helvetica").fontSize(9.5);
    let rowIndex = 0;
    for (const item of data.items) {
      const bg = rowIndex % 2 === 0 ? "#ffffff" : "#f9fafb";
      doc.rect(MARGIN, y, CONTENT_W, 22).fill(bg);
      doc.fillColor(INK).text(item.description, MARGIN + 12, y + 6, { width: CONTENT_W - 140 });
      doc.text(fmtMoney(item.amount), MARGIN, y + 6, { width: CONTENT_W - 12, align: "right" });
      y += 22;
      rowIndex++;
    }

    if (data.fineAmount && data.fineAmount > 0) {
      doc.rect(MARGIN, y, CONTENT_W, 22).fill("#fff7ed");
      doc.fillColor("#c2410c").text("Late fee / fine", MARGIN + 12, y + 6);
      doc.text(`+ ${fmtMoney(data.fineAmount)}`, MARGIN, y + 6, { width: CONTENT_W - 12, align: "right" });
      y += 22;
    }
    if (data.discountAmount && data.discountAmount > 0) {
      doc.rect(MARGIN, y, CONTENT_W, 22).fill(GREEN_LIGHT);
      doc.fillColor(GREEN).text("Discount applied", MARGIN + 12, y + 6);
      doc.text(`- ${fmtMoney(data.discountAmount)}`, MARGIN, y + 6, { width: CONTENT_W - 12, align: "right" });
      y += 22;
    }

    doc.rect(MARGIN, y, CONTENT_W, 1).fill(BORDER);
    y += 10;

    /* ── Totals ──────────────────────────────────────────── */
    doc.fontSize(10.5).fillColor(INK).font("Helvetica-Bold")
      .text("Total Paid Today", MARGIN + 12, y);
    doc.text(fmtMoney(data.amountPaid), MARGIN, y, { width: CONTENT_W - 12, align: "right" });
    y += 18;

    doc.fontSize(9.5).fillColor(data.dueAfter > 0 ? "#b91c1c" : MUTED).font("Helvetica")
      .text(data.dueAfter > 0 ? "Balance still due" : "Balance due", MARGIN + 12, y);
    doc.text(fmtMoney(data.dueAfter), MARGIN, y, { width: CONTENT_W - 12, align: "right" });
    y += 24;

    /* ── Amount in words ────────────────────────────────── */
    doc.roundedRect(MARGIN, y, CONTENT_W, 30, 6).fillAndStroke(INDIGO_LIGHT, INDIGO_LIGHT);
    doc.fontSize(9).fillColor(INDIGO).font("Helvetica-Oblique")
      .text(`Rupees ${numberToWordsIndian(Math.round(data.amountPaid))} Only`, MARGIN + 12, y + 10, { width: CONTENT_W - 24 });
    y += 30 + 20;

    if (data.remarks) {
      doc.fontSize(8.5).fillColor(MUTED).font("Helvetica").text(`Note: ${data.remarks}`, MARGIN, y, { width: CONTENT_W });
      y += 18;
    }

    /* ── Signature + footer ─────────────────────────────── */
    const sigY = Math.max(y + 30, 640);
    doc.moveTo(PAGE_W - MARGIN - 150, sigY).lineTo(PAGE_W - MARGIN, sigY).strokeColor(BORDER).stroke();
    doc.fontSize(8.5).fillColor(MUTED).font("Helvetica")
      .text(data.receivedBy ? `Received by: ${data.receivedBy}` : "Authorized Signatory", PAGE_W - MARGIN - 150, sigY + 6, { width: 150, align: "center" });

    doc.fontSize(7.5).fillColor(MUTED)
      .text(`Verify this receipt: ${data.verifyUrl}`, MARGIN, sigY + 6, { width: 300 })
      .text(`Generated ${fmtDateTime(new Date())} — this is a system-generated receipt.`, MARGIN, 780, { width: CONTENT_W, align: "center" });

    doc.rect(0, 802, PAGE_W, 6).fill(INDIGO);

    doc.end();
  });
}