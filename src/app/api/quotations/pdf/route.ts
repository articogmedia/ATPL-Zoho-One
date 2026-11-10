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
import { formatINR, GST_RATE, quotationGstBreakdown, todayIST, visibleFor, type QuoteGstTotals } from "@/lib/domain";
import { quotationPresentation, splitQuotationItems, type QuotationPresentationItem } from "@/lib/quotation-presentation";
import { wrapQuotationPdfText } from "@/lib/quotation-pdf-layout";
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
  const savedQuote = parsed.quoteId ? await repository.getQuote(parsed.quoteId) : null;
  if (parsed.quoteId && (!savedQuote || visibleFor(user, [savedQuote]).length === 0)) {
    return NextResponse.json({ error: "Quotation not found or access denied." }, { status: 403 });
  }
  const linkedLeadId = savedQuote?.leadId || parsed.leadId || "";
  const [linkedLead, products] = await Promise.all([
    linkedLeadId
      ? repository.getLead(linkedLeadId).catch((error: unknown) => {
        if (!savedQuote) throw error;
        console.warn("[api] saved quote lead lookup failed; rendering from its stored customer details", {
          quoteId: savedQuote.id,
          status: error instanceof ZohoError ? error.status : undefined,
          code: error instanceof ZohoError ? error.code : undefined,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      })
      : Promise.resolve(null),
    savedQuote?.items?.length ? Promise.resolve([]) : repository.listProducts(),
  ]);
  if (!linkedLead && !savedQuote) {
    return NextResponse.json({ error: "Lead not found or access denied." }, { status: 403 });
  }
  if (linkedLead && visibleFor(user, [linkedLead]).length === 0 && !savedQuote) {
    return NextResponse.json({ error: "Lead not found or access denied." }, { status: 403 });
  }
  const lead = {
    id: linkedLeadId,
    name: savedQuote?.contactName || linkedLead?.name || savedQuote?.customer || "",
    company: savedQuote?.company || linkedLead?.company || "",
    phone: savedQuote?.phone || linkedLead?.phone || "",
    area: savedQuote?.area || linkedLead?.area || "",
    address: savedQuote?.address || linkedLead?.address || "",
    source: "Direct Call" as const,
  };
  const offerNo = savedQuote?.offerNo || parsed.offerNo;
  const subject = savedQuote?.subject || parsed.subject;
  const items = savedQuote?.items?.length
    ? savedQuote.items.map((item) => ({
        model: item.model,
        description: item.description ?? "",
        unit: item.unit,
        qty: item.qty,
        price: item.price,
        discount: item.discount ?? 0,
      }))
    : parsed.items.map((row, index) => {
        const product = products.find((candidate) => candidate.id === row.productId);
        if (!product) throw new Error(`Product not found at row ${index + 1}.`);
        return {
          model: product.model, description: product.description ?? "", unit: product.unit,
          qty: row.qty, price: product.price, discount: row.discount ?? 0,
        };
      });
  const presentation = quotationPresentation(items);
  const isLegacySavedQuote = !!savedQuote && !savedQuote.gstBreakdown;
  const legacySubtotal = items.reduce((sum, item) => sum + item.qty * item.price, 0);
  const legacyDiscount = items.reduce((sum, item) => sum + (item.discount ?? 0), 0);
  const totals = savedQuote?.gstBreakdown ?? (isLegacySavedQuote
    ? { subtotal: legacySubtotal, discount: legacyDiscount, gst: 0, total: savedQuote.total }
    : presentation.totals);
  const isPartTaxConvention = !savedQuote || savedQuote.gstBreakdown?.partAGstMode === "extra";
  const computedBreakdown = quotationGstBreakdown(items);
  const partATotals = savedQuote?.gstBreakdown?.partA ?? computedBreakdown.partA;
  const partBTotals = savedQuote?.gstBreakdown?.partB ?? computedBreakdown.partB;
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
  text(page, offerNo, margin + 75, y, 10, bold);
  text(page, `DATE: ${formatOfferDate(todayIST())}`, 330, y, 8, bold);
  y -= 20;
  const customerName = lead.name.trim() && lead.name.trim() !== "(no name)" ? lead.name.trim() : "";
  const customerCompany = lead.company.trim();
  const customerAddress = lead.address.trim() || lead.area.trim();
  const hasCustomerDetails = !!(customerName || customerCompany || lead.phone.trim() || customerAddress);
  if (hasCustomerDetails) {
    text(page, "CLIENT", margin, y, 8, bold);
    text(page, customerName || customerCompany, margin + 75, y, 9);
    y -= 18;
  }
  text(page, "STAGE", margin, y, 8, bold);
  text(page, "Draft", margin + 75, y, 9);
  y -= 18;
  if (hasCustomerDetails) {
    text(page, "BILL TO", margin, y, 8, bold);
    text(page, "SHIP TO", 320, y, 8, bold);
    y -= 14;
    for (const [label, value] of [
      ["Name", customerName || customerCompany],
      ...(customerCompany && customerCompany !== customerName ? [["Company", customerCompany]] : []),
      ["Address", customerAddress],
      ["Phone", lead.phone.trim()],
    ] as [string, string][]) {
      if (!value) continue;
      text(page, label, margin, y, 7, bold);
      text(page, value, margin + 75, y, 7);
      text(page, value, 375, y, 7);
      y -= 12;
    }
    y -= 10;
  }
  text(page, "EQUIPMENT REQUIRED", margin, y, 9, bold);
  text(page, `Total Units: ${presentation.totalUnits}`, 430, y, 9, bold);
  y -= 18;
  const equipmentSummary = items.filter((item) => !/^B\s*-\s*/i.test(item.model));
  for (const item of equipmentSummary) {
    const lines = wrapQuotationPdfText(regular, `${item.model} / ${item.qty} / Nos`, 7, width - margin * 2);
    for (const line of lines) {
      if (y < 260) { page = newPage(); drawHeader(page); y = height - 112; }
      text(page, line, margin, y, 7);
      y -= 10;
    }
  }
  y -= 8;
  text(page, `Dear Sir,  Sub: ${subject}`, margin, y, 9, bold);
  y -= 16;
  wrapQuotationPdfText(regular, OFFER_TEXT.enquiry, 8, width - margin * 2).forEach((line) => { text(page, line, margin, y, 8); y -= 10; });

  const contentWidth = width - margin * 2;
  const columns = [
    { key: "sno", label: "S.No", width: 28, align: "center" },
    { key: "description", label: "Description", width: 252, align: "left" },
    { key: "unit", label: "Unit", width: 42, align: "center" },
    { key: "qty", label: "Qty", width: 38, align: "right" },
    { key: "rate", label: "Basic Rate (Rs)", width: 82, align: "right" },
    { key: "amount", label: "Amount (Rs)", width: contentWidth - 442, align: "right" },
  ] as const;
  const cellPadding = 4;
  const tableFontSize = 7;
  const lineHeight = 9;
  const bottomMargin = 48;
  const rightEdge = width - margin;
  const colLeft = (index: number) => margin + columns.slice(0, index).reduce((sum, column) => sum + column.width, 0);

  const textWidth = (value: string, size: number, font: PDFFont) => font.widthOfTextAtSize(value, size);
  const drawRight = (target: PDFPage, value: string, right: number, baseline: number, size: number, font = regular) =>
    text(target, value, right - textWidth(value, size, font), baseline, size, font);

  const drawTableHeader = (target: PDFPage, title: string) => {
    y -= 24;
    text(target, title, margin, y, 10, bold);
    y -= 18;
    const headerHeight = 18;
    target.drawRectangle({
      x: margin,
      y: y - headerHeight,
      width: contentWidth,
      height: headerHeight,
      color: rgb(0.31, 0.58, 0.80),
    });
    const baseline = y - headerHeight + (headerHeight - 6) / 2 + 1;
    columns.forEach((column, index) => {
      const left = colLeft(index);
      const right = left + column.width;
      const value = column.label;
      if (column.align === "right") drawRight(target, value, right - cellPadding, baseline, 6, bold);
      else if (column.align === "center") {
        const x = left + (column.width - textWidth(value, 6, bold)) / 2;
        text(target, value, x, baseline, 6, bold);
      } else text(target, value, left + cellPadding, baseline, 6, bold);
    });
    y -= headerHeight;
  };

  const startNewPage = (title?: string) => {
    page = newPage();
    drawHeader(page);
    y = height - 112;
    if (title) drawTableHeader(page, title);
  };

  const ensureSpace = (requiredHeight: number, title?: string) => {
    if (y - requiredHeight < bottomMargin) startNewPage(title);
  };

  const drawFlowText = (value: string, size = 8, font = regular, lineHeight = 12) => {
    const lines = wrapQuotationPdfText(font, value, size, contentWidth);
    for (const line of lines) {
      if (y - lineHeight < bottomMargin + 4) startNewPage();
      text(page, line, margin, y, size, font);
      y -= lineHeight;
    }
  };
  const addFlowSpace = (amount: number) => {
    if (y - amount < bottomMargin + 4) startNewPage();
    else y -= amount;
  };

  const partBlockRows = (partTotals: QuoteGstTotals, partName: string, gstNote: string) => isLegacySavedQuote
    ? [
        ["Basic Sub Total", partTotals.subtotal - partTotals.discount, true] as const,
        [gstNote, null, false] as const,
      ]
    : !isPartTaxConvention ? [
        [`Subtotal - ${partName}`, partTotals.subtotal, true] as const,
        ...(partTotals.discount > 0 ? [["Discount", -partTotals.discount, false] as const] : []),
        [`GST @ ${Math.round((savedQuote?.gstBreakdown?.rate ?? GST_RATE) * 100)}%`, partTotals.gst, false] as const,
        [`Total - ${partName}`, partTotals.total, true] as const,
      ] : [
        [`${partName} subtotal`, partTotals.subtotal, true] as const,
        [`${partName} GST @ ${Math.round((savedQuote?.gstBreakdown?.rate ?? GST_RATE) * 100)}%`, partTotals.gst, false] as const,
        [`${partName} total`, partTotals.total, true] as const,
      ];

  const drawTotalsBlock = (rows: readonly (readonly [string, number | null, boolean])[], rowHeight = 15) => {
    ensureSpace(rows.length * rowHeight + 8);
    const labelX = colLeft(1) + cellPadding;
    const amountRight = rightEdge - cellPadding;
    for (const [label, amount, emphasis] of rows) {
      const font = emphasis ? bold : regular;
      text(page, label, labelX, y - rowHeight + 4, 8, font);
      if (amount !== null) drawRight(page, money(amount), amountRight, y - rowHeight + 4, 8, font);
      y -= rowHeight;
    }
    y -= 8;
  };

  const drawPart = (partItems: QuotationPresentationItem[], title: string, gstNote: string, partTotals: typeof totals) => {
    ensureSpace(60);
    drawTableHeader(page, title);
    partItems.forEach((item, index) => {
      const description = `${item.model}${item.description ? ` / ${item.description}` : ""}`;
      const descriptionLines = wrapQuotationPdfText(regular, description, tableFontSize, columns[1].width - cellPadding * 2);
      const rowHeight = Math.max(20, descriptionLines.length * lineHeight + cellPadding * 2);
      if (y - rowHeight < bottomMargin) startNewPage(title);
      const rowTop = y;
      const baseline = rowTop - cellPadding - tableFontSize;
      const bodyValues = [
        `${index + 1}`,
        descriptionLines[0] ?? "",
        "Nos",
        `${item.qty}`,
        money(item.price),
        money(item.qty * item.price - (item.discount ?? 0)),
      ];
      columns.forEach((column, columnIndex) => {
        const left = colLeft(columnIndex);
        const right = left + column.width;
        const value = bodyValues[columnIndex] ?? "";
        if (columnIndex === 1) {
          descriptionLines.forEach((line, lineIndex) => {
            text(page, line, left + cellPadding, baseline - lineIndex * lineHeight, tableFontSize);
          });
        } else if (column.align === "right") {
          drawRight(page, value, right - cellPadding, baseline, tableFontSize);
        } else if (column.align === "center") {
          text(page, value, left + (column.width - textWidth(value, tableFontSize, regular)) / 2, baseline, tableFontSize);
        } else {
          text(page, value, left + cellPadding, baseline, tableFontSize);
        }
      });
      page.drawLine({
        start: { x: margin, y: rowTop - rowHeight },
        end: { x: rightEdge, y: rowTop - rowHeight },
        thickness: 0.4,
        color: rgb(0.8, 0.8, 0.8),
      });
      y -= rowHeight;
    });
    const partName = title.includes("PART A") ? "Part A" : "Part B";
    drawTotalsBlock(partBlockRows(partTotals, partName, gstNote));
  };

  const { equipment, ancillary } = splitQuotationItems(items);
  drawPart(equipment, OFFER_TEXT.partA, OFFER_TEXT.partAGst, partATotals);
  if (ancillary.length) drawPart(ancillary, OFFER_TEXT.partB, OFFER_TEXT.partBGst, partBTotals);
  const finalRows: (readonly [string, number | null, boolean])[] = isLegacySavedQuote
    ? [["TOTAL PART A + B", totals.total, true]]
    : !isPartTaxConvention ? [
        ["TOTAL PART A + B", totals.total, true],
        ["Subtotal", totals.subtotal, false],
        ...(totals.discount > 0 ? [["Discount", -totals.discount, false] as const] : []),
        [`GST @ ${Math.round((savedQuote?.gstBreakdown?.rate ?? GST_RATE) * 100)}%`, totals.gst, false],
        ["Grand Total", totals.total, true],
      ] : [
        ["Subtotal", totals.subtotal, false],
        [`GST @ ${Math.round((savedQuote?.gstBreakdown?.rate ?? GST_RATE) * 100)}%`, totals.gst, false],
        ["Grand Total", totals.total, true],
      ];
  drawTotalsBlock(finalRows, 16);
  if (!isLegacySavedQuote) {
    y -= 8;
  }

  drawFlowText("NOTE", 9, bold, 14);
  drawFlowText(OFFER_TEXT.note);
  addFlowSpace(8);
  drawFlowText("ITEMS EXCLUDED", 9, bold, 14);
  OFFER_TEXT.excluded.forEach((line, index) => drawFlowText(`${index + 1}. ${line}`));
  addFlowSpace(8);
  drawFlowText("TERMS & CONDITIONS", 9, bold, 14);
  OFFER_TEXT.terms.forEach(([label, detail]) => drawFlowText(`${label}: ${detail}`));
  drawFlowText(OFFER_TEXT.paymentContinuation);
  addFlowSpace(6);
  drawFlowText(OFFER_TEXT.closing);
  addFlowSpace(4);
  drawFlowText(OFFER_TEXT.thanks);
  addFlowSpace(4);
  drawFlowText(`for ${COMPANY.name}`, 8, bold);
  drawFlowText(COMPANY.signatory);
  drawFlowText(COMPANY.phones);

  const bytes = await pdf.save();
  return new NextResponse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="offer-${offerNo.replace("/", "-")}.pdf"`, "Cache-Control": "private, no-store" },
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
  return formatINR(value);
}
