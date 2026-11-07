import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { z, ZodError } from "zod";
import { currentUser } from "@/lib/auth/guard";
import { crm } from "@/lib/crm";
import { ZohoError } from "@/lib/zoho/client";
import { friendlyZohoError, newErrorReference } from "@/lib/crm-action-errors";
import { COMPANY, OFFER_TEXT } from "@/lib/company";
import { formatINR, quoteTotals, todayIST, visibleFor } from "@/lib/domain";
import { quotationPresentation, splitQuotationItems, type QuotationPresentationItem } from "@/lib/quotation-presentation";
import { quotationRequestSchema } from "@/lib/quotation-request";

export const runtime = "nodejs";
export const preferredRegion = "bom1";
export const maxDuration = 30;

function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /^(mobile|phone)$/i.test(key) && item != null
        ? `******${String(item).replace(/\D/g, "").slice(-2)}`
        : redactPayload(item),
    ]));
  }
  return value;
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) line = next;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export async function POST(request: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  let rawPayload: unknown;
  let parsed: z.infer<typeof quotationRequestSchema>;
  try {
    rawPayload = await request.json();
    parsed = quotationRequestSchema.parse(rawPayload);
  } catch (error) {
    const message = error instanceof ZodError
      ? error.issues[0]?.message ?? "Please check the quotation details."
      : "Please provide valid quotation details.";
    const reference = newErrorReference();
    console.error("[api] quotation PDF request validation failed", {
      reference,
      issues: error instanceof z.ZodError ? error.issues.map(({ path, message: issueMessage }) => ({ path, message: issueMessage })) : undefined,
      message: error instanceof Error ? error.message : String(error),
      payload: redactPayload(rawPayload),
    });
    return NextResponse.json({ error: `${message} (Ref: ${reference})`, reference }, { status: 400 });
  }

  try {
  const repository = crm();
  const [lead, products] = await Promise.all([repository.getLead(parsed.leadId), repository.listProducts()]);
  if (!lead || visibleFor(user, [lead]).length === 0) {
    return NextResponse.json({ error: "Lead not found or access denied." }, { status: 403 });
  }

  const byId = new Map(products.map((product) => [product.id, product]));
  const items = parsed.items.map((row, index) => {
    const product = byId.get(row.productId);
    if (!product) throw new Error(`Product not found at row ${index + 1}.`);
    return {
      model: product.model, description: product.description ?? "", unit: product.unit,
      qty: row.qty, price: product.price, discount: row.discount ?? 0,
    };
  });
  const presentation = quotationPresentation(items);
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = 595.28;
  const height = 841.89;
  const margin = 36;
  const logo = await pdf.embedPng(await readFile(path.join(process.cwd(), "public", "brand", "atpl-logo.png")));

  const text = (page: PDFPage, value: string, x: number, y: number, size = 8, font = regular) =>
    page.drawText(value.replaceAll("₹", "Rs."), { x, y, size, font, color: rgb(0.12, 0.16, 0.22) });

  const newPage = () => {
    const page = pdf.addPage([width, height]);
    page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
    return page;
  };
  const drawHeader = (page: PDFPage) => {
    if (logo) {
      const scale = Math.min(130 / logo.width, 52 / logo.height);
      page.drawImage(logo, { x: margin, y: height - 72, width: logo.width * scale, height: logo.height * scale });
    }
    text(page, COMPANY.name, 330, height - 38, 12, bold);
    text(page, COMPANY.address, 330, height - 52, 7);
    text(page, COMPANY.contact, 330, height - 64, 7);
    text(page, `GSTIN ${COMPANY.gstin}`, 330, height - 76, 7, bold);
    page.drawLine({ start: { x: margin, y: height - 88 }, end: { x: width - margin, y: height - 88 }, thickness: 0.6, color: rgb(0.75, 0.75, 0.75) });
  };

  let page = newPage();
  drawHeader(page);
  let y = height - 112;
  text(page, "OFFER REF", margin, y, 8, bold);
  text(page, parsed.offerNo, margin + 75, y, 10, bold);
  text(page, `DATE: ${formatOfferDate(todayIST())}`, 330, y, 8, bold);
  y -= 20;
  text(page, "CLIENT", margin, y, 8, bold);
  text(page, lead.company || lead.name, margin + 75, y, 9);
  y -= 30;
  text(page, "STAGE", margin, y, 8, bold);
  text(page, "Draft", margin + 75, y, 9);
  y -= 18;
  const billToCustomer = lead.company?.trim() || lead.name.trim() || "Customer details unavailable";
  const billToContact = lead.name.trim() && lead.name.trim() !== billToCustomer ? lead.name.trim() : "";
  const billToAddress = lead.address?.trim() || lead.area?.trim() || "";
  const billToPhone = lead.phone.trim();
  text(page, "BILL TO", margin, y, 8, bold);
  text(page, billToCustomer, margin + 75, y, 8);
  text(page, "SHIP TO", 320, y, 8, bold);
  text(page, billToCustomer, 375, y, 8);
  y -= 14;
  text(page, "Contact", margin, y, 7, bold);
  text(page, billToContact || lead.name || billToCustomer, margin + 75, y, 7);
  text(page, billToContact || lead.name || billToCustomer, 375, y, 7);
  y -= 14;
  text(page, "Address", margin, y, 7, bold);
  text(page, billToAddress || billToPhone || "-", margin + 75, y, 7);
  text(page, billToAddress || billToPhone || "-", 375, y, 7);
  y -= 12;
  text(page, "Phone", margin, y, 7, bold);
  text(page, billToPhone || "-", margin + 75, y, 7);
  text(page, billToPhone || "-", 375, y, 7);
  y -= 22;
  text(page, "EQUIPMENT REQUIRED", margin, y, 9, bold);
  text(page, `Total Units: ${presentation.totalUnits}`, 430, y, 9, bold);
  y -= 18;
  const equipmentSummary = items.filter((item) => !/^B\s*-\s*/i.test(item.model));
  for (const item of equipmentSummary) {
    const lines = wrap(regular, `${item.model} / ${item.qty} / ${item.unit}`, 7, width - margin * 2);
    for (const line of lines) {
      if (y < 260) { page = newPage(); drawHeader(page); y = height - 112; }
      text(page, line, margin, y, 7);
      y -= 10;
    }
  }
  y -= 8;
  text(page, `Dear Sir,  Sub: ${parsed.subject}`, margin, y, 9, bold);
  y -= 16;
  wrap(regular, OFFER_TEXT.enquiry, 8, width - margin * 2).forEach((line) => { text(page, line, margin, y, 8); y -= 10; });

  const drawTableHeader = (target: PDFPage, top: number, title: string) => {
    text(target, title, margin, top, 10, bold);
    const headerY = top - 18;
    target.drawRectangle({ x: margin, y: headerY - 16, width: width - margin * 2, height: 16, color: rgb(0.31, 0.58, 0.80) });
    const headers = ["S.No", "Description", "Unit", "Qty", ...(presentation.hasDiscount ? ["Discount (Rs)"] : []), "Basic Rate (Rs)", "Amount (Rs)"];
    const cols = [margin + 2, margin + 34, margin + 300, margin + 340, ...(presentation.hasDiscount ? [margin + 375] : []), margin + 435, margin + 495];
    headers.forEach((label, i) => text(target, label, cols[i] ?? margin, headerY - 11, 6, bold));
    return headerY - 16;
  };

  const drawPart = (partItems: QuotationPresentationItem[], title: string, gstNote: string, total: number) => {
    if (y < 260) { page = newPage(); drawHeader(page); y = height - 112; }
    y = drawTableHeader(page, y, title);
    partItems.forEach((item, index) => {
      const descriptionLines = wrap(regular, `${item.model}${item.description ? `\n${item.description}` : ""}`, 7, 286);
      const rowHeight = Math.max(24, descriptionLines.length * 8 + 12);
      if (y - rowHeight < 260) { page = newPage(); drawHeader(page); y = drawTableHeader(page, height - 112, title); }
      text(page, `${index + 1}`, margin + 4, y - 12, 8);
      text(page, descriptionLines.join(" "), margin + 34, y - 12, 7);
      text(page, item.unit, margin + 320, y - 12, 8);
      text(page, `${item.qty}`, margin + 360, y - 12, 8);
      if (presentation.hasDiscount) text(page, money(item.discount ?? 0), margin + 375, y - 12, 8);
      text(page, money(item.price), presentation.hasDiscount ? margin + 435 : margin + 395, y - 12, 8);
      text(page, money(item.qty * item.price - (item.discount ?? 0)), presentation.hasDiscount ? margin + 495 : margin + 455, y - 12, 8);
      page.drawLine({ start: { x: margin, y: y - rowHeight }, end: { x: width - margin, y: y - rowHeight }, thickness: 0.4, color: rgb(0.8, 0.8, 0.8) });
      y -= rowHeight;
    });
    if (y < 260) { page = newPage(); drawHeader(page); y = height - 112; }
    text(page, "Basic Sub Total", margin + 34, y - 14, 8, bold);
    text(page, money(total), margin + 455, y - 14, 8, bold);
    y -= 26;
    text(page, gstNote, margin + 34, y - 14, 8);
    y -= 26;
  };

  const { equipment, ancillary } = splitQuotationItems(items);
  drawPart(equipment, OFFER_TEXT.partA, OFFER_TEXT.partAGst, quoteTotals(equipment).total);
  if (ancillary.length) drawPart(ancillary, OFFER_TEXT.partB, OFFER_TEXT.partBGst, quoteTotals(ancillary).total);
  if (y < 260) { page = newPage(); drawHeader(page); y = height - 112; }
  text(page, "TOTAL PART A + B", margin + 34, y - 14, 10, bold);
  text(page, money(presentation.grandTotal), margin + 455, y - 14, 10, bold);
  y -= 42;

  text(page, "NOTE", margin, y, 9, bold); y -= 14;
  text(page, OFFER_TEXT.note, margin, y, 8); y -= 20;
  text(page, "ITEMS EXCLUDED", margin, y, 9, bold); y -= 14;
  OFFER_TEXT.excluded.forEach((line, index) => { text(page, `${index + 1}. ${line}`, margin, y, 8); y -= 12; });
  y -= 8;
  text(page, "TERMS & CONDITIONS", margin, y, 9, bold); y -= 14;
  OFFER_TEXT.terms.forEach(([label, detail]) => { text(page, `${label}: ${detail}`, margin, y, 8); y -= 12; });
  text(page, OFFER_TEXT.paymentContinuation, margin, y, 8); y -= 18;
  text(page, OFFER_TEXT.closing, margin, y, 8); y -= 16;
  text(page, OFFER_TEXT.thanks, margin, y, 8); y -= 16;
  text(page, `for ${COMPANY.name}`, margin, y, 8, bold); y -= 12;
  text(page, COMPANY.signatory, margin, y, 8); text(page, COMPANY.phones, margin + 180, y, 8);

  const bytes = await pdf.save();
  return new NextResponse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="offer-${parsed.offerNo.replace("/", "-")}.pdf"`, "Cache-Control": "private, no-store" },
  });
  } catch (error) {
    const reference = newErrorReference();
    console.error("[api] quotation PDF generation failed", {
      reference,
      message: error instanceof Error ? error.message : String(error),
      status: error instanceof ZohoError ? error.status : undefined,
      code: error instanceof ZohoError ? error.code : undefined,
      field: error instanceof ZohoError ? error.field : undefined,
      details: error instanceof ZohoError ? error.details : undefined,
      operation: error instanceof ZohoError ? error.operation : undefined,
    });
    const message = error instanceof ZohoError
      ? friendlyZohoError(error.status, error.code, error.message, error.field, reference, error.operation)
      : `Unable to create the PDF. (Ref: ${reference})`;
    return NextResponse.json({ error: message, reference }, { status: 500 });
  }
}

function formatOfferDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${(year ?? "").slice(-2)}`;
}

function money(value: number) {
  return formatINR(Math.round(value));
}
