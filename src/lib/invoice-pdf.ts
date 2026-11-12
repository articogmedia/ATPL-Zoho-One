import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { COMPANY } from "@/lib/company";
import { formatINR } from "@/lib/domain";
import type { Invoice } from "@/lib/domain";

export function sanitizeInvoicePdfText(value: string, font: PDFFont): string {
  return Array.from(value.replace(/[\r\n\t]/g, " ")).filter((character) => {
    try {
      font.encodeText(character);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("cannot encode")) return false;
      throw error;
    }
  }).join("");
}

export async function renderInvoicePdf(invoice: Invoice) {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [595.28, 841.89];
  const margin = 42;
  const ink = rgb(0.1, 0.14, 0.2);
  const muted = rgb(0.38, 0.42, 0.47);
  const brand = rgb(0.05, 0.3, 0.48);
  let page = document.addPage(pageSize);
  let y = pageSize[1] - margin;
  const text = (value: string, x: number, top: number, size = 10, font = regular, color = ink) => {
    page.drawText(sanitizeInvoicePdfText(value, font).slice(0, 100), {
      x, y: top - size, size, font, color, maxWidth: pageSize[0] - x - margin,
    });
  };
  const line = (top: number) => page.drawLine({
    start: { x: margin, y: top },
    end: { x: pageSize[0] - margin, y: top },
    thickness: 0.7,
    color: rgb(0.82, 0.85, 0.88),
  });
  const nextPage = () => {
    page = document.addPage(pageSize);
    y = pageSize[1] - margin;
  };
  text(COMPANY.name, margin, y, 17, bold, brand);
  y -= 22;
  text(COMPANY.address, margin, y, 8, regular, muted);
  y -= 12;
  text(`GSTIN: ${COMPANY.gstin}  |  ${COMPANY.contact}`, margin, y, 8, regular, muted);
  y -= 26;
  line(y);
  y -= 23;
  text("TAX INVOICE", margin, y, 15, bold);
  text(`Invoice: ${invoice.invoiceNo}`, 340, y, 10, bold);
  y -= 19;
  text(`Date: ${invoice.date}`, 340, y, 9);
  text(`Status: ${invoice.status}`, margin, y, 9, regular, muted);
  y -= 24;
  text("Bill to", margin, y, 9, bold);
  y -= 14;
  text(invoice.company || invoice.customer, margin, y, 10, bold);
  y -= 14;
  text(invoice.contactName, margin, y, 9);
  y -= 13;
  if (invoice.gstin) {
    text(`Customer GSTIN: ${invoice.gstin}`, margin, y, 9);
    y -= 13;
  }
  text(`Phone: ${invoice.phone}`, margin, y, 9);
  y -= 23;
  line(y);
  y -= 19;
  text("Item", margin, y, 8, bold);
  text("Qty", 330, y, 8, bold);
  text("Rate", 372, y, 8, bold);
  text("GST", 433, y, 8, bold);
  text("Amount", 484, y, 8, bold);
  y -= 9;
  line(y);
  y -= 16;

  for (const [index, item] of invoice.items.entries()) {
    if (y < 110) {
      nextPage();
      text("TAX INVOICE (continued)", margin, y, 12, bold);
      y -= 24;
    }
    const net = Math.max(0, item.qty * item.price - (item.discount ?? 0));
    const rate = (item.taxRate ?? 0.18) * 100;
    text(item.model, margin, y, 8, bold);
    text(String(item.qty), 330, y, 8);
    text(formatINR(item.price), 372, y, 8);
    text(`${rate}%`, 433, y, 8);
    text(formatINR(net), 484, y, 8);
    y -= 13;
    if (item.description) {
      text(item.description, margin + 6, y, 7, regular, muted);
      y -= 11;
    }
    if ((item.discount ?? 0) > 0) {
      text(`Discount: ${formatINR(item.discount ?? 0)}`, margin + 6, y, 7, regular, muted);
      y -= 11;
    }
    if (index < invoice.items.length - 1) y -= 4;
  }

  y -= 10;
  if (y < 160) {
    nextPage();
    text("TAX INVOICE (continued)", margin, y, 12, bold);
    y -= 25;
  }
  line(y);
  y -= 17;
  const summary = [
    ["Subtotal", invoice.gstBreakdown.subtotal],
    ...(invoice.gstBreakdown.discount ? [["Discount", -invoice.gstBreakdown.discount] as [string, number]] : []),
    ...((invoice.gstBreakdown.gstByRate ?? []).map((group) => [`GST ${group.rate * 100}%`, group.amount] as [string, number])),
    ...((invoice.gstBreakdown.extraCharges ?? []).map((charge) => [charge.label, charge.amount] as [string, number])),
  ];
  for (const [label, amount] of summary) {
    text(String(label), 350, y, 9);
    text(formatINR(Number(amount)), 484, y, 9);
    y -= 15;
  }
  y -= 3;
  line(y);
  y -= 19;
  text("Grand Total", 350, y, 11, bold);
  text(formatINR(invoice.total), 475, y, 11, bold, brand);
  return document.save();
}