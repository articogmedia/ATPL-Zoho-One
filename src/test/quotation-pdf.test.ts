import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { canCreateQuotationPdf, needsPdfTotalsPage, quotationPresentation } from "@/lib/quotation-presentation";
import { quotationRequestSchema } from "@/lib/quotation-request";

vi.mock("server-only", () => ({}));

const currentUser = vi.fn();
vi.mock("@/lib/auth/guard", () => ({ currentUser }));
vi.mock("@/lib/crm", () => ({ crm: vi.fn(() => ({ getLead: vi.fn(() => Promise.resolve(null)), listProducts: vi.fn(() => []) })) }));

describe("quotation PDF route", () => {
  beforeEach(() => currentUser.mockReset());

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
    expect(presentation.grandTotal).toBe(25000);
    expect(needsPdfTotalsPage(25, 120)).toBe(true);
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
  });
});
