import PDFDocument from "pdfkit";

export interface InvoiceData {
  invoiceNumber: string;
  issuedAt: Date;
  schoolName: string;
  schoolAddress?: string | null;
  schoolEmail?: string | null;
  planName: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  amountPaid: number;
  discountCode?: string | null;
  discountAmount?: number | null;
  paymentId?: string | null;
}

/**
 * Renders an invoice as a PDF buffer. Deliberately simple — shows the
 * amount as "inclusive of applicable taxes" rather than breaking out GST,
 * since proper GST invoicing (GSTIN, HSN/SAC, place-of-supply rules)
 * needs a CA's sign-off before this goes live for real billing.
 */
export function generateInvoicePdf(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const fmtDate = (d: Date) =>
      d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    const fmtMoney = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

    // Header
    doc.fontSize(20).fillColor("#6366f1").text("ShikshaMatrix", 50, 50);
    doc.fontSize(10).fillColor("#666").text("shikshamatrix.in", 50, 75);
    doc.fontSize(16).fillColor("#111").text("INVOICE", 400, 50, { align: "right" });
    doc.fontSize(10).fillColor("#666").text(`Invoice #: ${data.invoiceNumber}`, 400, 72, { align: "right" });
    doc.text(`Date: ${fmtDate(data.issuedAt)}`, 400, 86, { align: "right" });

    doc.moveTo(50, 110).lineTo(545, 110).strokeColor("#e5e7eb").stroke();

    // Billed To
    doc.fontSize(11).fillColor("#111").text("Billed To", 50, 130);
    doc.fontSize(11).fillColor("#333").text(data.schoolName, 50, 148);
    if (data.schoolAddress) doc.fontSize(9).fillColor("#666").text(data.schoolAddress, 50, 165, { width: 250 });
    if (data.schoolEmail) doc.fontSize(9).fillColor("#666").text(data.schoolEmail, 50, 195);

    // Subscription details
    doc.fontSize(11).fillColor("#111").text("Subscription", 320, 130);
    doc.fontSize(10).fillColor("#333").text(data.planName, 320, 148);
    doc.fontSize(9).fillColor("#666").text(
      `${fmtDate(data.billingPeriodStart)} - ${fmtDate(data.billingPeriodEnd)}`,
      320, 165
    );
    if (data.paymentId) doc.fontSize(9).fillColor("#666").text(`Payment ID: ${data.paymentId}`, 320, 182);

    // Line items table
    const tableTop = 240;
    doc.fontSize(10).fillColor("#fff");
    doc.rect(50, tableTop, 495, 24).fill("#6366f1");
    doc.fillColor("#fff").text("Description", 60, tableTop + 7);
    doc.text("Amount", 450, tableTop + 7, { width: 85, align: "right" });

    let y = tableTop + 34;
    doc.fillColor("#333").fontSize(10);
    doc.text(`${data.planName} Subscription`, 60, y);
    doc.text(fmtMoney(data.amountPaid + (data.discountAmount ?? 0)), 450, y, { width: 85, align: "right" });
    y += 22;

    if (data.discountAmount && data.discountAmount > 0) {
      doc.fillColor("#059669").text(`Discount${data.discountCode ? ` (${data.discountCode})` : ""}`, 60, y);
      doc.text(`- ${fmtMoney(data.discountAmount)}`, 450, y, { width: 85, align: "right" });
      y += 22;
    }

    doc.moveTo(50, y + 6).lineTo(545, y + 6).strokeColor("#e5e7eb").stroke();
    y += 18;
    doc.fontSize(12).fillColor("#111").text("Total Paid", 60, y);
    doc.fontSize(12).fillColor("#111").text(fmtMoney(data.amountPaid), 450, y, { width: 85, align: "right" });

    doc.fontSize(8).fillColor("#999").text(
      "Amount shown is inclusive of applicable taxes. This is a system-generated invoice.",
      50, y + 40, { width: 495 }
    );

    doc.end();
  });
}
