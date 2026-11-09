import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { canCreateQuotationPdf, needsPdfTotalsPage, quotationPresentation } from "@/lib/quotation-presentation";
import { quotationRequestSchema } from "@/lib/quotation-request";

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
    expect(presentation.totals).toEqual({ subtotal: 25000, discount: 0, gst: 4500, total: 29500 });
    expect(needsPdfTotalsPage(25, 120)).toBe(true);
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
      items: [{ model: "Equipment", unit: "Nos", qty: 1, price: 100 }],
      gstBreakdown: {
        subtotal: 100, discount: 0, gst: 18, total: 118, rate: 0.18,
        partA: { subtotal: 100, discount: 0, gst: 18, total: 118 },
        partB: { subtotal: 0, discount: 0, gst: 0, total: 0 },
      },
    });
    const { POST } = await import("@/app/api/quotations/pdf/route");
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
