import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PDFDocument, PDFPage, StandardFonts } from "pdf-lib";
import { COMPANY, OFFER_TEXT, offerSubject } from "@/lib/company";
import { canCreateQuotationPdf, displayProductUnit, formatOfferReference, formatQuotationMoney, needsPdfTotalsPage, quotationPresentation, splitQuotationItems } from "@/lib/quotation-presentation";
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
    process.env.SESSION_SECRET = "pdf-snapshot-test-secret-that-is-long-enough";
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

  it("uses equipment-only units, clean product descriptions, generic subjects, and decimal money", () => {
    const presentation = quotationPresentation([
      {
        model: "Samsung Product",
        description: "Samsung Product / 3.0 TR; Selling price excl GST; Price circular w.e.f. 01-04-2026",
        unit: "Nos",
        qty: 2,
        price: 1000,
      },
      { model: "B - Installation", unit: "Nos", qty: 7, price: 100 },
    ]);

    expect(presentation.totalUnits).toBe(2);
    expect(splitQuotationItems([
      {
        model: "Samsung Product",
        description: "Samsung Product / 3.0 TR; Selling price excl GST; Price circular w.e.f. 01-04-2026",
        unit: "Nos",
        qty: 1,
        price: 1000,
      },
    ]).equipment[0]).toMatchObject({ model: "Samsung Product", description: "3.0 TR" });
    expect(formatQuotationMoney(171000)).toBe("Rs. 1,71,000.00");
    expect(offerSubject(["Samsung 4 Way AC"])).toBe("Your requirement for Air Conditioners - reg.");
    expect(offerSubject(["Samsung 4 Way AC"])).not.toContain("Samsung");
  });

  it("formats offer references with the product brand and revision", () => {
    expect(formatOfferReference("236/26-27", [{ model: "Samsung 4 Way Cassette AC" }], 1))
      .toBe("236/26-27/SAMSUNG /R1");
    expect(formatOfferReference("238/26-27", [{ model: "Split AC" }])).toBe("238/26-27");
    expect(formatOfferReference("239/26-27", [
      { model: "Samsung Split AC" },
      { model: "Daikin Split AC" },
    ])).toBe("239/26-27/MULTI-BRAND");
  });

  it("uses readable product unit labels without changing unfamiliar Zoho values", () => {
    expect(displayProductUnit("Rmt")).toBe("Running Meter");
    expect(displayProductUnit("nos")).toBe("Numbers");
    expect(displayProductUnit("Set")).toBe("Set");
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
        subtotal: 100, discount: 0, gst: 30, total: 230, rate: 0.18, partAGstMode: "extra",
        partA: { subtotal: 100, discount: 0, gst: 18, total: 118 },
        partB: { subtotal: 0, discount: 0, gst: 0, total: 0 },
        extraCharges: [{ label: "Freight", amount: 100, taxRate: 0.12 }],
        zoho: { subtotal: 100, discount: 0, tax: 30, adjustment: 100 },
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
    expect(renderedText).toContain("Set");
    expect(renderedText).not.toContain("Nos");
    expect(renderedText).toContain("Grand Total");
    expect(renderedText).not.toContain("SHIP TO");
    expect(renderedText).toContain("Taxes: GST at applicable line-item and extra-charge rates, as shown above");
    expect(renderedText).toContain("GST @ 18%");
    expect(renderedText).toContain("GST @ 12%");
    expect(renderedText).toContain("Extra charge: Freight");
    expect(renderedText).toContain("Rs. 230.00");
    expect(drawText.mock.calls.filter(([value]) => String(value).includes("Long equipment")).length).toBeGreaterThan(1);
    drawText.mockRestore();
  });

  it("renders a saved quote snapshot without relying on current product data", async () => {
    currentUser.mockResolvedValue({ id: "U1", name: "User", role: "Manager" });
    const quote = {
      id: "Q-SNAPSHOT",
      offerNo: "241/26-27",
      leadId: "L1",
      customer: "Customer Co",
      contactName: "Customer",
      company: "Customer Co",
      phone: "9876543210",
      area: "",
      address: "",
      subject: "Air conditioning quotation",
      executive: "User",
      total: 118,
      date: "2026-11-09",
      ownerId: "U1",
      items: [{ productId: "P1", model: "Saved AC", unit: "Nos", qty: 1, price: 100, discount: 10, taxRate: 0.18 }],
      gstBreakdown: {
        subtotal: 100, discount: 10, gst: 18.6, total: 128.6, rate: 0.18,
        partA: { subtotal: 100, discount: 10, gst: 16.2, total: 106.2 },
        partB: { subtotal: 0, discount: 0, gst: 0, total: 0 },
        extraCharges: [{ label: "Freight", amount: 20, taxRate: 0.12 }],
      },
    };
    process.env.SESSION_SECRET = "pdf-snapshot-test-secret-that-is-long-enough";
    const { signQuotationPdfSnapshot } = await import("@/lib/quotation-pdf-snapshot");
    const token = signQuotationPdfSnapshot(quote, "U1");
    quoteRepository.listProducts.mockRejectedValue(new Error("Current product data is unavailable"));
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    const { POST } = await import("@/app/api/quotations/pdf/route");

    const response = await POST(new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({
        quoteId: "Q-SNAPSHOT",
        quoteSnapshotToken: token,
        offerNo: "241/26-27",
        subject: "Air conditioning quotation",
        items: [{ qty: 1 }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(quoteRepository.getQuote).not.toHaveBeenCalled();
    expect(quoteRepository.getLead).not.toHaveBeenCalled();
    expect(quoteRepository.listProducts).not.toHaveBeenCalled();
    const renderedText = drawText.mock.calls.map(([value]) => String(value)).join("\n");
    expect(renderedText).toContain("Rs. 100.00");
    expect(renderedText).toContain("Rs. 128.60");
    expect(renderedText).toContain("Discount");
    expect(renderedText).toContain("Extra charge: Freight");
    expect(renderedText).toContain("GST @ 18%");
    expect(renderedText).toContain("GST @ 12%");
    drawText.mockRestore();
  });

  it("falls back to the existing Zoho quote when its snapshot token has expired", async () => {
    vi.resetModules();
    vi.doMock("@/lib/quotation-pdf-snapshot", () => ({
      verifyQuotationPdfSnapshot: vi.fn(() => null),
    }));
    currentUser.mockResolvedValue({ id: "U1", name: "Manager", role: "Manager" });
    quoteRepository.getQuote.mockResolvedValue({
      id: "Q-EXPIRED",
      offerNo: "242/26-27",
      leadId: "",
      customer: "Customer",
      executive: "Manager",
      ownerId: "U1",
      total: 118,
      date: "2026-11-09",
      items: [{ model: "Saved AC", unit: "Nos", qty: 1, price: 100 }],
    });
    const { POST } = await import("@/app/api/quotations/pdf/route");

    const response = await POST(new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({
        quoteId: "Q-EXPIRED",
        quoteSnapshotToken: "expired-snapshot",
        offerNo: "242/26-27",
        subject: "Air conditioning quotation",
        items: [{ qty: 1 }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(quoteRepository.getQuote).toHaveBeenCalledWith("Q-EXPIRED");
    vi.doUnmock("@/lib/quotation-pdf-snapshot");
  });

  it("logs the PDF preparation stage and original cause when product retrieval fails", async () => {
    currentUser.mockResolvedValue({ id: "U1", name: "User", role: "Manager" });
    quoteRepository.getLead.mockResolvedValue({
      id: "L1", name: "Customer", company: "Customer Co", phone: "9876543210", area: "", address: "",
      source: "Direct Call", status: "Fresh Lead", assignedTo: null, remarks: "", createdOn: "2026-11-09", touchedBy: [],
    });
    quoteRepository.listProducts.mockRejectedValue(new Error("Product catalogue unavailable", {
      cause: new Error("Zoho connection reset"),
    }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("@/app/api/quotations/pdf/route");
    const response = await POST(new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({
        leadId: "L1",
        offerNo: "279/26-27",
        subject: "Air conditioning quotation",
        items: [{ productId: "P1", qty: 1 }],
      }),
    }));

    expect(response.status).toBe(500);
    expect(errorLog).toHaveBeenCalledWith(
      "[api] quotation PDF generation failed",
      expect.objectContaining({
        stage: "related_data_retrieval",
        message: "Product catalogue unavailable",
        stack: expect.stringContaining("Product catalogue unavailable"),
        cause: expect.objectContaining({
          message: "Zoho connection reset",
          stack: expect.stringContaining("Zoho connection reset"),
        }),
      }),
    );
    errorLog.mockRestore();
  });

  it("renders GST separately for Part A and Part B", async () => {
    currentUser.mockResolvedValue({ id: "U1", name: "User", role: "Manager" });
    quoteRepository.getLead.mockResolvedValue({
      id: "L1", name: "Customer", company: "Customer Co", phone: "9876543210", area: "", address: "",
      source: "Direct Call", status: "Fresh Lead", assignedTo: null, remarks: "", createdOn: "2026-11-09", touchedBy: [],
    });
    quoteRepository.listProducts.mockResolvedValue([
      { id: "A1", model: "Samsung 4 Way 3.0 TR", unit: "Nos", price: 59724 },
      { id: "B1", model: "B - Copper piping (per Rmt)", unit: "Rmt", price: 1220 },
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
    expect(renderedText).toContain("Subtotal - Part A");
    expect(renderedText).toContain("Rs. 59,724.00");
    expect(renderedText).toContain("GST @ 18%");
    expect(renderedText).toContain("Rs. 10,750.32");
    expect(renderedText).toContain("Total - Part A");
    expect(renderedText).toContain("Rs. 70,474.32");
    expect(renderedText).toContain("Subtotal - Part B");
    expect(renderedText).toContain("Rs. 1,220.00");
    expect(renderedText).toContain("Running Meter");
    expect(renderedText).toContain("Total - Part B");
    expect(renderedText).toContain("Rs. 219.60");
    expect(renderedText).toContain("Grand Total");
    expect(renderedText).toContain("Rs. 60,944.00");
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
    expect(renderedText).toContain("Rs. 90.00");
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
    const excludedIndices = drawText.mock.calls.flatMap(([value], index) =>
      /^(?:ITEMS EXCLUDED|1\.|2\.)/.test(String(value)) ? [index] : [],
    );
    expect(excludedIndices).toHaveLength(3);
    expect(new Set(excludedIndices.map((index) => drawText.mock.contexts[index])).size).toBe(1);
    drawText.mockRestore();
  });

  it("prints customer-facing product details without status or internal pricing text", async () => {
    currentUser.mockResolvedValue({ id: "U1", name: "User", role: "Manager" });
    quoteRepository.getQuote.mockResolvedValue({
      id: "Q-CUSTOMER-PDF",
      offerNo: "268/26-27",
      leadId: "",
      customer: "Customer",
      executive: "User",
      total: 1_000_000,
      date: "2026-11-10",
      ownerId: "U1",
      status: "Draft",
      items: [
        {
          model: "Samsung Product",
          description: "Samsung Product / 3.0 TR; Selling price excl GST; Price circular w.e.f. 01-04-2026",
          unit: "Nos",
          qty: 2,
          price: 1000,
        },
        { model: "B - Installation", description: "Price list w.e.f. 01-04-2026", unit: "Nos", qty: 7, price: 100 },
      ],
    });

    const { POST } = await import("@/app/api/quotations/pdf/route");
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    const response = await POST(new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({
        quoteId: "Q-CUSTOMER-PDF",
        offerNo: "268/26-27",
        subject: "Air Conditioner offer",
        items: [{ qty: 1 }],
      }),
    }));

    expect(response.status).toBe(200);
    const renderedText = drawText.mock.calls.map(([value]) => String(value)).join("\n");
    expect(renderedText).not.toContain("STAGE");
    expect(renderedText).not.toContain("Draft");
    expect(renderedText).toContain("Total Units: 2");
    expect(renderedText).not.toContain("Selling price excl GST");
    expect(renderedText).not.toContain("Price circular w.e.f.");
    expect(renderedText).not.toContain("Price list w.e.f.");
    expect(renderedText).toContain("3.0 TR");
    expect(renderedText).toContain("Rs. 1,000.00");
    expect(renderedText).toContain("Rs. 2,000.00");
    expect(renderedText.match(/Samsung Product/g)).toHaveLength(1);
    drawText.mockRestore();
  });

  it("allows saved quote PDFs to use mapped line snapshots without product IDs", () => {
    const request = {
      quoteId: "Q1", offerNo: "239/26-27", subject: "Offer",
      items: [{ qty: 1 }],
    };
    expect(quotationRequestSchema.safeParse(request).success).toBe(true);
    expect(quotationRequestSchema.safeParse({
      ...request,
      items: [{ productId: "P1", qty: 1, taxRate: 0.05 }],
      extraCharges: [{ label: "Freight", amount: 10, taxRate: 0.12 }],
    }).success).toBe(true);
    expect(quotationRequestSchema.safeParse({
      ...request, extraCharges: [{ label: "", amount: 10 }],
    }).success).toBe(false);
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

  it("generates a valid PDF when the bundled logo is unavailable", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("logo file not found")),
    }));
    currentUser.mockResolvedValue({ id: "U1", name: "Manager", role: "Manager" });
    quoteRepository.getQuote.mockResolvedValue({
      id: "Q-LOGO",
      offerNo: "239/26-27",
      leadId: "",
      customer: "Customer",
      executive: "Manager",
      ownerId: "U1",
      total: 118,
      date: "2026-10-29",
      items: [{ model: "Cassette AC", unit: "Nos", qty: 1, price: 100 }],
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { POST } = await import("@/app/api/quotations/pdf/route");
    const response = await POST(new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({
        quoteId: "Q-LOGO",
        offerNo: "239/26-27",
        subject: "AC quotation",
        items: [{ qty: 1 }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(warning).toHaveBeenCalledWith(
      "[quotation-pdf] logo unavailable; generating without it",
      expect.objectContaining({ message: "logo file not found" }),
    );
    warning.mockRestore();
    vi.doUnmock("node:fs/promises");
  });
});
