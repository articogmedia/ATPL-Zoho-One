import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  user: { id: "manager-1", name: "Manager", role: "Manager" },
  quote: {
    id: "quote-1",
    offerNo: "301/26-27",
    leadId: "lead-1",
    customer: "Customer Co",
    executive: "Manager",
    ownerId: "manager-1",
    total: 118,
    date: "2026-11-11",
    items: [{ productId: "product-1", model: "AC", unit: "Nos", qty: 1, price: 100 }],
  },
  storedPdf: undefined as { url: string; ownerId?: string; executive?: string } | undefined,
  getQuote: vi.fn(),
  getStoredQuotationPdf: vi.fn(async () => mocks.storedPdf),
  saveStoredQuotationPdf: vi.fn(async (_id: string, value: { url: string; ownerId?: string; executive?: string }) => {
    mocks.storedPdf = value;
  }),
  put: vi.fn(async () => ({ url: "https://blob.example/quotation.pdf" })),
  renderPdf: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ put: mocks.put }));
vi.mock("@/lib/auth/guard", () => ({ currentUser: vi.fn(async () => mocks.user) }));
vi.mock("@/lib/crm", () => ({ crm: () => ({ getQuote: mocks.getQuote }) }));
vi.mock("@/lib/env", () => ({ env: () => ({ BLOB_READ_WRITE_TOKEN: "blob-token" }) }));
vi.mock("@/lib/quotation-pdf-store", () => ({
  getStoredQuotationPdf: mocks.getStoredQuotationPdf,
  saveStoredQuotationPdf: mocks.saveStoredQuotationPdf,
}));
vi.mock("@/lib/quotation-pdf-snapshot", () => ({
  signQuotationPdfSnapshot: vi.fn(() => "signed-snapshot"),
  verifyQuotationPdfSnapshot: vi.fn(),
}));
vi.mock("@/app/api/quotations/pdf/route", () => ({ POST: mocks.renderPdf }));
vi.mock("@/lib/perf-log", () => ({ logPerf: vi.fn() }));

describe("quotation PDF storage route", () => {
  beforeEach(() => {
    mocks.storedPdf = undefined;
    mocks.getQuote.mockReset().mockResolvedValue(mocks.quote);
    mocks.getStoredQuotationPdf.mockClear();
    mocks.saveStoredQuotationPdf.mockClear();
    mocks.put.mockClear();
    mocks.renderPdf.mockReset().mockResolvedValue(new Response("%PDF-fixture", {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    }));
  });

  it("generates and stores a PDF once, then reuses its saved URL", async () => {
    const { POST } = await import("@/app/api/quotations/share/route");
    const request = () => new NextRequest("http://localhost/api/quotations/share", {
      method: "POST",
      headers: { Cookie: "atpl-session=valid" },
      body: JSON.stringify({
        quoteId: "quote-1",
        offerNo: "301/26-27",
        subject: "Air conditioning quotation",
        items: [{ productId: "product-1", qty: 1 }],
      }),
    });

    const first = await POST(request());
    const second = await POST(request());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ url: "https://blob.example/quotation.pdf" });
    await expect(second.json()).resolves.toEqual({ url: "https://blob.example/quotation.pdf" });
    expect(mocks.getQuote).toHaveBeenCalledOnce();
    expect(mocks.renderPdf).toHaveBeenCalledOnce();
    const pdfRequest = mocks.renderPdf.mock.calls[0]?.[0] as NextRequest;
    await expect(pdfRequest.json()).resolves.toMatchObject({
      quoteId: "quote-1",
      quoteSnapshotToken: "signed-snapshot",
    });
    expect(pdfRequest.headers.get("cookie")).toBe("atpl-session=valid");
    expect(mocks.put).toHaveBeenCalledOnce();
    expect(mocks.saveStoredQuotationPdf).toHaveBeenCalledWith("quote-1", {
      url: "https://blob.example/quotation.pdf",
      ownerId: "manager-1",
      executive: "Manager",
    });
  });

  it("returns a safe reference when the PDF renderer fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.renderPdf.mockResolvedValue(new Response(JSON.stringify({
      error: "Internal database details must not reach the customer. (Ref: PDF-REF)",
    }), { status: 500, headers: { "Content-Type": "application/json" } }));
    const { POST } = await import("@/app/api/quotations/share/route");
    const response = await POST(new NextRequest("http://localhost/api/quotations/share", {
      method: "POST",
      body: JSON.stringify({
        quoteId: "quote-1",
        offerNo: "301/26-27",
        subject: "Air conditioning quotation",
        items: [{ productId: "product-1", qty: 1 }],
      }),
    }));

    expect(response.status).toBe(500);
    const body = await response.json() as { error: string; reference: string };
    expect(body.error).toContain(body.reference);
    expect(body.error).not.toContain("Internal database details");
    expect(errorLog).toHaveBeenCalledWith(
      "[api] quotation share PDF generation failed",
      expect.objectContaining({ stage: "pdf_generation", innerReference: "PDF-REF" }),
    );
    expect(mocks.put).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("logs the PDF upload failure stage and does not expose storage details", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.put.mockRejectedValueOnce(new Error("private storage endpoint credentials failed"));
    const { POST } = await import("@/app/api/quotations/share/route");
    const response = await POST(new NextRequest("http://localhost/api/quotations/share", {
      method: "POST",
      body: JSON.stringify({
        quoteId: "quote-1",
        offerNo: "301/26-27",
        subject: "Air conditioning quotation",
        items: [{ productId: "product-1", qty: 1 }],
      }),
    }));

    expect(response.status).toBe(500);
    const body = await response.json() as { error: string; reference: string };
    expect(body.error).toContain(body.reference);
    expect(body.error).not.toContain("private storage endpoint");
    expect(errorLog).toHaveBeenCalledWith(
      "[api] quotation share preparation failed",
      expect.objectContaining({ stage: "blob_upload", message: "private storage endpoint credentials failed" }),
    );
    errorLog.mockRestore();
  });
});
