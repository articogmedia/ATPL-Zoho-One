import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { z } from "zod";
import { currentUser } from "@/lib/auth/guard";
import { crm } from "@/lib/crm";
import { COMPANY } from "@/lib/company";
import { formatINR, quoteTotals, todayIST, visibleFor } from "@/lib/domain";

export const runtime = "nodejs";

const bodySchema = z.object({
  leadId: z.string().trim().min(1),
  offerNo: z.string().trim().regex(/^\d{1,4}\/\d{2}-\d{2}$/),
  subject: z.string().trim().min(1).max(300),
  items: z.array(z.object({
    productId: z.string().trim().min(1),
    qty: z.number().int().positive().max(10000),
    discount: z.number().nonnegative().max(100000000).optional(),
  }).strict()).min(1).max(100),
}).strict();

const wrap = (font: { widthOfTextAtSize(text: string, size: number): number }, text: string, size: number, maxWidth: number) => {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
};

export async function POST(request: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Please check the quotation details." }, { status: 400 });
  }

  const repository = crm();
  const [lead, products] = await Promise.all([repository.getLead(parsed.leadId), repository.listProducts()]);
  if (!lead || visibleFor(user, [lead]).length === 0) {
    return NextResponse.json({ error: "Lead not found or access denied." }, { status: 403 });
  }
  const byId = new Map(products.map((product) => [product.id, product]));
  const items = parsed.items.map((row, index) => {
    const product = byId.get(row.productId);
    if (!product) throw new Error(`Product not found at row ${index + 1}.`);
    return { model: product.model, description: product.description ?? "", unit: product.unit, qty: row.qty, price: product.price, discount: row.discount ?? 0 };
  });
  const totals = quoteTotals(items);
  const date = todayIST();
  const validTill = new Date(`${date}T12:00:00+05:30`);
  validTill.setDate(validTill.getDate() + 30);
  const formatDate = (value: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" }).format(value);
  const formatOfferDate = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "2-digit" })
    .format(new Date(`${date}T12:00:00+05:30`).getTime()).replaceAll("/", ".");

  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const blue = rgb(79 / 255, 148 / 255, 205 / 255);
  const dark = rgb(30 / 255, 41 / 255, 59 / 255);
  const border = rgb(203 / 255, 213 / 255, 225 / 255);
  const width = 595.28;
  const height = 841.89;
  const margin = 36;
  const money = (value: number) => formatINR(Math.round(value));

  let logo: Awaited<ReturnType<typeof pdf.embedPng>> | null = null;
  try {
    const logoBytes = await readFile(path.join(process.cwd(), "public", "brand", "atpl-logo.png"));
    logo = await pdf.embedPng(logoBytes);
  } catch (error) {
    console.warn("[pdf] logo unavailable", error instanceof Error ? error.message : String(error));
  }

  const newPage = () => {
    const page = pdf.addPage([width, height]);
    page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
    return page;
  };
  const drawText = (page: ReturnType<typeof pdf.addPage>, value: string, x: number, y: number, size = 9, font = regular, color = dark) =>
    page.drawText(value.replaceAll("₹", "Rs."), { x, y, size, font, color });

  const drawHeader = (page: ReturnType<typeof pdf.addPage>) => {
    if (logo) {
      const scale = Math.min(130 / logo.width, 52 / logo.height);
      page.drawImage(logo, { x: margin, y: height - 82, width: logo.width * scale, height: logo.height * scale });
    }
    drawText(page, COMPANY.name, 330, height - 42, 14, bold);
    drawText(page, COMPANY.address, 330, height - 58, 8);
    drawText(page, COMPANY.contact, 330, height - 70, 8);
    drawText(page, `GSTIN - ${COMPANY.gstin}`, 330, height - 82, 9, bold);
    page.drawLine({ start: { x: margin, y: height - 96 }, end: { x: width - margin, y: height - 96 }, thickness: 0.7, color: border });
  };

  const page = newPage();
  drawHeader(page);
  let y = height - 116;
  drawText(page, "OFFER", margin, y, 18, bold);
  drawText(page, parsed.offerNo, margin, y - 18, 12, bold);
  drawText(page, `Date: ${formatOfferDate}`, margin, y - 34, 9);
  drawText(page, "Stage: Draft", margin + 180, y, 9);
  drawText(page, `Valid Till: ${formatDate(validTill)}`, margin + 180, y - 18, 9);
  drawText(page, `Sales Person: ${COMPANY.signatory}`, margin + 180, y - 34, 9);
  drawText(page, `Amount: ${money(totals.total)}`, margin + 180, y - 50, 9, bold);
  drawText(page, "Bill To", 390, y, 9, bold);
  drawText(page, lead.company || lead.name, 390, y - 16, 9);
  drawText(page, lead.address || lead.area || "", 390, y - 30, 8);
  drawText(page, "Ship To", 390, y - 52, 9, bold);
  drawText(page, lead.company || lead.name, 390, y - 68, 9);
  drawText(page, lead.address || lead.area || "", 390, y - 82, 8);
  y -= 112;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.7, color: border });
  y -= 18;
  drawText(page, "Dear Sir,", margin, y);
  y -= 16;
  drawText(page, `Sub: ${parsed.subject}`, margin, y, 9, bold);
  y -= 26;
  const intro = wrap(regular, "We thank you very much for your enquiry. We are pleased to submit herewith our offer. Our detailed Bill of quantities are as follows.", 8, width - margin * 2);
  intro.forEach((line) => { drawText(page, line, margin, y, 8); y -= 11; });
  y -= 10;

  const columns = [
    { label: "Item & Description", x: margin, width: 245 },
    { label: "List Price", x: 281, width: 80 },
    { label: "Qty", x: 361, width: 45 },
    { label: "Discount", x: 406, width: 70 },
    { label: "Amount", x: 476, width: 83 },
  ];
  const drawTableHeader = (target: ReturnType<typeof pdf.addPage>, top: number) => {
    target.drawRectangle({ x: margin, y: top - 20, width: width - margin * 2, height: 20, color: blue });
    columns.forEach((column) => drawText(target, column.label, column.x, top - 13, 8, bold, rgb(1, 1, 1)));
    return top - 20;
  };
  y = drawTableHeader(page, y);
  let currentPage = page;
  items.forEach((item, index) => {
    const descriptionLines = wrap(regular, item.description, 7, 225);
    const rowHeight = Math.max(30, 14 + descriptionLines.length * 8);
    if (y - rowHeight < 110) {
      currentPage = newPage();
      drawHeader(currentPage);
      y = height - 116;
      y = drawTableHeader(currentPage, y);
    }
    drawText(currentPage, `${index + 1}. ${item.model}`, margin + 3, y - 12, 8, bold);
    descriptionLines.forEach((line, lineIndex) => drawText(currentPage, line, margin + 3, y - 22 - lineIndex * 8, 7, regular, border));
    drawText(currentPage, money(item.price), columns[1]!.x, y - 12, 8);
    drawText(currentPage, `${item.qty} ${item.unit}`, columns[2]!.x, y - 12, 8);
    drawText(currentPage, money(item.discount ?? 0), columns[3]!.x, y - 12, 8);
    drawText(currentPage, money(item.qty * item.price - (item.discount ?? 0)), columns[4]!.x, y - 12, 8);
    currentPage.drawLine({ start: { x: margin, y: y - rowHeight }, end: { x: width - margin, y: y - rowHeight }, thickness: 0.4, color: border });
    y -= rowHeight;
  });

  const totalY = Math.max(175, y - 10);
  drawText(currentPage, "Sub Total", 390, totalY, 9, bold);
  drawText(currentPage, money(totals.subtotal), 485, totalY, 9);
  drawText(currentPage, "Discount", 390, totalY - 14, 9, bold);
  drawText(currentPage, money(totals.discount), 485, totalY - 14, 9);
  drawText(currentPage, "GST (Rs. 0)", 390, totalY - 28, 9, bold);
  drawText(currentPage, "Rs. 0.00", 485, totalY - 28, 9);
  currentPage.drawRectangle({ x: 380, y: totalY - 48, width: 179, height: 16, color: rgb(100 / 255, 116 / 255, 139 / 255) });
  drawText(currentPage, "Grand Total", 390, totalY - 42, 9, bold, rgb(1, 1, 1));
  drawText(currentPage, money(totals.total), 485, totalY - 42, 9, bold, rgb(1, 1, 1));

  let termsY = totalY - 76;
  const terms = [
    "NOTE: Quantities are tentative.",
    "ITEMS EXCLUDED: Civil, electrical and structural work unless specifically listed.",
    "TERMS & CONDITIONS",
    "Validity: 30 days from the date of offer.",
    "Delivery: 1-2 weeks from the date of order.",
    "Payment Terms: 100% advance for equipment; 60% advance for Part B and 40% on completion.",
    `for ${COMPANY.name}`,
    `${COMPANY.signatory}`,
    COMPANY.phones,
  ];
  terms.forEach((term) => {
    drawText(currentPage, term, margin, termsY, term === "TERMS & CONDITIONS" ? 9 : 8, term === "TERMS & CONDITIONS" || term.startsWith("NOTE") || term.startsWith("ITEMS") || term.startsWith("for ") ? bold : regular);
    termsY -= term.startsWith("for ") ? 16 : 11;
  });

  const bytes = await pdf.save();
  return new NextResponse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="offer-${parsed.offerNo.replace("/", "-")}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
