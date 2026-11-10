import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PDFDocument, PDFPage, StandardFonts } from "pdf-lib";
import { COMPANY, OFFER_TEXT } from "@/lib/company";
import { canCreateQuotationPdf, needsPdfTotalsPage, quotationPresentation } from "@/lib/quotation-presentation";
import { quotationRequestSchema } from "@/lib/quotation-request";
import { wrapQuotationPdfText } from "@/lib/quotation-pdf-layout";

vi.mock("server-only", () => ({}));

const currentUser = vi.fn();
const quoteRepository = vi.hoisted(() => ({
  getLead: vi.fn(),
  getQuote: vi.fn(),
  listProducts: vi.fn(),
}));
vi.mock("@/lib/auth/guard", () => ({ currentUser }));
vi.mock("@/lib/crm", () => ({ crm: vi.fn(() => quoteRepository) }));

describe("quotation PDF route", () => {
  beforeEach(() => {
    currentUser.mockReset();
    quoteRepository.getLead.mockReset().mockResolvedValue(null);
    quoteRepository.getQuote.mockReset().mockResolvedValue(null);
    quoteRepository.listProducts.mockReset().mockResolvedValue([]);
  });

  it("rejects unauthenticated requests", async () => {
    currentUser.mockResolvedValue(null);
    const { POST } = await import("@/app/api/quotations/pdf/route");
    const request = new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({ leadId: "L1", offerNo: "239/26-27", subject: "Offer", items: [{ productId: "P1", qty: 1 }] }),
    });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("rejects client-supplied prices", async () => {
    currentUser.mockResolvedValue({ id: "U1", name: "User", role: "Manager" });
    const { POST } = await import("@/app/api/quotations/pdf/route");
    const request = new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({
        leadId: "L1", offerNo: "239/26-27", subject: "Offer",
        items: [{ productId: "P1", qty: 1, price: 1 }],
      }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("reserves space for totals when rendering many item rows", () => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      model: `Product ${index + 1}`, unit: "Nos", qty: 1, price: 1000,
    }));
    const presentation = quotationPresentation(items);
    expect(presentation.grandTotal).toBe(29500);
    expect(presentation.totals).toMatchObject({
      subtotal: 25000, discount: 0, gst: 4500, total: 29500,
      partA: { subtotal: 25000, gst: 4500, total: 29500 },
    });
    expect(needsPdfTotalsPage(25, 120)).toBe(true);
  });

  it("wraps long descriptions and set codes inside the fixed description column", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const setCode = Array.from({ length: 10 }, (_, index) => `VRF-SET-${String(index + 1).padStart(3, "0")}`).join("+");
    const description = `${setCode}/VERY-LONG-SET-CODE+${"Very long equipment specification ".repeat(18)}`;
    const lines = wrapQuotationPdfText(font, description, 7, 244);

    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((line) => font.widthOfTextAtSize(line, 7) <= 244)).toBe(true);
    expect(lines.some((line) => line.endsWith("+") || line.endsWith("/"))).toBe(true);
  });

  it("renders a saved GST breakdown from the stored quote snapshot", async () => {
    currentUser.mockResolvedValue({ id: "U1", name: "User", role: "Manager" });
    quoteRepository.getQuote.mockResolvedValue({
      id: "Q-GST",
      offerNo: "240/26-27",
      leadId: "",
      customer: "Customer",
      executive: "User",
      total: 118,
      date: "2026-11-09",
      ownerId: "U1",
      items: [{
        model: "VRF-SET-001+VRF-SET-002/VRF-SET-003",
        description: "Long equipment specification ".repeat(16),
        unit: "Set",
        qty: 1,
        price: 100,
      }],
      gstBreakdown: {
        subtotal: 100, discount: 0, gst: 18, total: 118, rate: 0.18, partAGstMode: "extra",
        partA: { subtotal: 100, discount: 0, gst: 18, total: 118 },
        partB: { subtotal: 0, discount: 0, gst: 0, total: 0 },
        zoho: { subtotal: 100, discount: 0, tax: 18, adjustment: 0 },
      },
    });
    const { POST } = await import("@/app/api/quotations/pdf/route");
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    const response = await POST(new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({
        quoteId: "Q-GST",
        offerNo: "240/26-27",
        subject: "Offer",
        items: [{ qty: 1 }],
      }),
    }));

    expect(response.status).toBe(200);
    const pdfBytes = Buffer.from(await response.arrayBuffer());
    expect(pdfBytes.subarray(0, 4).toString("ascii")).toBe("%PDF");
    const renderedText = drawText.mock.calls.map(([value]) => String(value)).join("\n");
    expect(renderedText).toContain("Nos");
    expect(renderedText).not.toContain("Set");
    expect(renderedText).toContain("Taxes: GST @ 18% extra on all items, as shown above");
    expect(renderedText).toContain("GST @ 18%");
    expect(drawText.mock.calls.filter(([value]) => String(value).includes("Long equipment")).length).toBeGreaterThan(1);
    drawText.mockRestore();
  });

  it("renders GST separately for Part A and Part B", async () => {
    currentUser.mockResolvedValue({ id: "U1", name: "User", role: "Manager" });
    quoteRepository.getLead.mockResolvedValue({
      id: "L1", name: "Customer", company: "Customer Co", phone: "9876543210", area: "", address: "",
      source: "Direct Call", status: "Fresh Lead", assignedTo: null, remarks: "", createdOn: "2026-11-09", touchedBy: [],
    });
    quoteRepository.listProducts.mockResolvedValue([
      { id: "A1", model: "Samsung 4 Way 3.0 TR", unit: "Nos", price: 59724 },
      { id: "B1", model: "B - Installation", unit: "Nos", price: 1220 },
    ]);
    const { POST } = await import("@/app/api/quotations/pdf/route");
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    const response = await POST(new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({
        leadId: "L1",
        offerNo: "301/26-27",
        subject: "Offer",
        items: [
          { productId: "A1", qty: 1, discount: 0 },
          { productId: "B1", qty: 1, discount: 0 },
        ],
      }),
    }));

    expect(response.status).toBe(200);
    const renderedText = drawText.mock.calls.map(([value]) => String(value)).join("\n");
    expect(renderedText).toContain("Part A subtotal");
    expect(renderedText).toContain("Rs. 59,724");
    expect(renderedText).toContain("Part A GST @ 18%");
    expect(renderedText).toContain("Rs. 10,750.32");
    expect(renderedText).toContain("Part A total");
    expect(renderedText).toContain("Rs. 70,474.32");
    expect(renderedText).toContain("Part B subtotal");
    expect(renderedText).toContain("Rs. 1,220");
    expect(renderedText).toContain("Part B GST @ 18%");
    expect(renderedText).toContain("Rs. 219.60");
    expect(renderedText).toContain("Grand Total");
    expect(renderedText).toContain("Rs. 60,944");
    expect(renderedText).toContain("Rs. 10,969.92");
    expect(renderedText).toContain("Rs. 71,913.92");
    expect(renderedText).not.toContain("GST included");
    drawText.mockRestore();
  });

  it("uses the stored grand total for a legacy saved quotation", async () => {
    currentUser.mockResolvedValue({ id: "U1", name: "User", role: "Manager" });
    quoteRepository.getQuote.mockResolvedValue({
      id: "Q-LEGACY",
      offerNo: "302/26-27",
      leadId: "",
      customer: "Customer",
      executive: "User",
      total: 90,
      date: "2026-11-09",
      items: [{ model: "Old saved item", unit: "Nos", qty: 1, price: 100 }],
    });
    const { POST } = await import("@/app/api/quotations/pdf/route");
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    const response = await POST(new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({ quoteId: "Q-LEGACY", offerNo: "302/26-27", subject: "Old offer", items: [{ qty: 1 }] }),
    }));

    expect(response.status).toBe(200);
    const renderedText = drawText.mock.calls.map(([value]) => String(value)).join("\n");
    expect(renderedText).toContain("Rs. 90");
    expect(renderedText).toContain("TOTAL PART A + B");
    drawText.mockRestore();
  });

  it("continues long quote content and terms on new pages without clipping", async () => {
    currentUser.mockResolvedValue({ id: "U1", name: "User", role: "Manager" });
    quoteRepository.getQuote.mockResolvedValue({
      id: "Q-LONG",
      offerNo: "268/26-27",
      leadId: "",
      customer: "Customer",
      executive: "User",
      total: 1_000_000,
      date: "2026-11-10",
      ownerId: "U1",
      items: Array.from({ length: 18 }, (_, index) => ({
        model: `Long product ${index + 1}`,
        description: "Long equipment specification with installation and technical requirements ".repeat(9),
        unit: "Nos",
        qty: 1,
        price: 1000,
      })),
    });

    const { POST } = await import("@/app/api/quotations/pdf/route");
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    const response = await POST(new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({
        quoteId: "Q-LONG",
        offerNo: "268/26-27",
        subject: "Long quotation",
        items: [{ qty: 1 }],
      }),
    }));

    expect(response.status).toBe(200);
    const pdfBytes = Buffer.from(await response.arrayBuffer());
    const renderedPdf = await PDFDocument.load(pdfBytes);
    expect(renderedPdf.getPageCount()).toBeGreaterThan(1);

    const renderedText = drawText.mock.calls
      .map(([value]) => String(value))
      .join(" ")
      .replace(/\s+/g, " ");
    for (const [label, detail] of OFFER_TEXT.terms) {
      expect(renderedText).toContain(`${label}: ${detail}`);
    }
    for (const closingText of [
      OFFER_TEXT.paymentContinuation,
      OFFER_TEXT.closing,
      OFFER_TEXT.thanks,
      `for ${COMPANY.name}`,
      COMPANY.signatory,
      COMPANY.phones,
    ]) {
      expect(renderedText).toContain(closingText);
    }
    expect(drawText.mock.calls.every(([, options]) =>
      Number((options as { y?: number }).y ?? 0) >= 48,
    )).toBe(true);
    drawText.mockRestore();
  });

  it("allows saved quote PDFs to use mapped line snapshots without product IDs", () => {
    const request = {
      quoteId: "Q1", offerNo: "239/26-27", subject: "Offer",
      items: [{ qty: 1 }],
    };
    expect(quotationRequestSchema.safeParse(request).success).toBe(true);
    expect(quotationRequestSchema.safeParse({
      ...request, quoteId: undefined, leadId: "L1",
    }).success).toBe(false);
    expect(canCreateQuotationPdf({
      offerNo: "239/26-27", customer: "Customer", leadId: "", items: [{}],
    }, true)).toBe(true);
    expect(canCreateQuotationPdf({
      offerNo: "239/26-27", customer: "", leadId: "", items: [{}],
    }, true)).toBe(true);
    expect(canCreateQuotationPdf({
      offerNo: "239/26-27", customer: "", leadId: "", items: [],
    }, true)).toBe(false);
  });

  it("creates a saved quote PDF when both the customer snapshot and linked lead are unavailable", async () => {
    currentUser.mockResolvedValue({ id: "U1", name: "Manager", role: "Manager" });
    quoteRepository.getQuote.mockResolvedValue({
      id: "Q1",
      offerNo: "239/26-27",
      leadId: "deleted-lead",
      customer: "",
      contactName: "",
      company: "",
      phone: "",
      area: "",
      address: "",
      executive: "Manager",
      ownerId: "U1",
      subject: "AC quotation",
      total: 122000,
      date: "2026-10-29",
      items: [{ model: "Cassette AC", unit: "Nos", qty: 1, price: 122000 }],
    });
    quoteRepository.getLead.mockRejectedValue(new Error("Lead deleted"));
    const { POST } = await import("@/app/api/quotations/pdf/route");
    const request = new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({
        quoteId: "Q1",
        offerNo: "239/26-27",
        subject: "AC quotation",
        items: [{ qty: 1 }],
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString("ascii")).toBe("%PDF");
  });
});
