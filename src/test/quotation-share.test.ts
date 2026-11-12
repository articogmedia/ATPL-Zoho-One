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
  put: vi.fn<(_pathname: string, _pdf: Buffer, _options: Record<string, unknown>) => Promise<{ url: string }>>(async () => ({
    url: "https://blob.example/quotation.pdf",
  })),
  generatePdf: vi.fn(),
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
vi.mock("@/lib/quotation-pdf", () => ({
  generateQuotationPdfBytes: mocks.generatePdf,
  QuotationPdfGenerationError: class QuotationPdfGenerationError extends Error {
    constructor(readonly stage: string, readonly status: number, cause: unknown) {
      super("Quotation PDF generation failed.", { cause });
    }
  },
}));
vi.mock("@/lib/perf-log", () => ({ logPerf: vi.fn() }));

describe("quotation PDF storage route", () => {
  beforeEach(() => {
    mocks.storedPdf = undefined;
    mocks.getQuote.mockReset().mockResolvedValue(mocks.quote);
    mocks.getStoredQuotationPdf.mockClear();
    mocks.saveStoredQuotationPdf.mockClear();
    mocks.put.mockClear();
    mocks.generatePdf.mockReset().mockResolvedValue({
      bytes: Buffer.from("%PDF-fixture"),
      filename: "offer-301-26-27.pdf",
    });
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
    expect(mocks.generatePdf).toHaveBeenCalledOnce();
    expect(mocks.generatePdf).toHaveBeenCalledWith(expect.objectContaining({
      quoteId: "quote-1",
      quoteSnapshotToken: "signed-snapshot",
    }), mocks.user);
    expect(mocks.put).toHaveBeenCalledOnce();
    const [pathname, pdf, uploadOptions] = mocks.put.mock.calls[0]!;
    expect(pathname).toBe("quotations/301-26-27-quote-1.pdf");
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(uploadOptions).toMatchObject({
      access: "public",
      contentType: "application/pdf",
      token: "blob-token",
      allowOverwrite: true,
    });
    expect(mocks.saveStoredQuotationPdf).toHaveBeenCalledWith("quote-1", {
      url: "https://blob.example/quotation.pdf",
      ownerId: "manager-1",
      executive: "Manager",
    });
  });

  it("returns a safe reference when the PDF renderer fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.generatePdf.mockRejectedValueOnce(new Error("Internal database details must not reach the customer."));
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
    const body = await response.json() as { error: string; reference: string; stage: string };
    expect(body.error).toContain(body.reference);
    expect(body.error).toContain("step: pdf_generation");
    expect(body.error).not.toContain("Internal database details");
    expect(errorLog).toHaveBeenCalledWith(
      "[api] quotation share preparation failed",
      expect.objectContaining({ stage: "pdf_generation", message: "Internal database details must not reach the customer." }),
    );
    expect(mocks.put).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("logs the PDF upload failure stage and does not expose storage details", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.put.mockRejectedValueOnce(new Error("private storage endpoint credentials failed", {
      cause: new Error("storage connection reset"),
    }));
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
    const body = await response.json() as { error: string; reference: string; stage: string };
    expect(body.error).toContain(body.reference);
    expect(body.error).toContain("step: blob_upload");
    expect(body.stage).toBe("blob_upload");
    expect(body.error).not.toContain("private storage endpoint");
    expect(errorLog).toHaveBeenCalledWith(
      "[api] quotation share preparation failed",
      expect.objectContaining({
        stage: "blob_upload",
        message: "private storage endpoint credentials failed",
        stack: expect.stringContaining("private storage endpoint credentials failed"),
        cause: expect.objectContaining({
          message: "storage connection reset",
          stack: expect.stringContaining("storage connection reset"),
        }),
      }),
    );
    errorLog.mockRestore();
  });

  it("returns the uploaded URL when Redis lookup and cache writes fail", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getStoredQuotationPdf.mockRejectedValueOnce(new Error("Redis unavailable"));
    mocks.saveStoredQuotationPdf.mockRejectedValueOnce(new Error("shared PDF cache is unavailable"));
    const { POST } = await import("@/app/api/quotations/share/route");
    const request = () => new NextRequest("http://localhost/api/quotations/share", {
      method: "POST",
      body: JSON.stringify({
        quoteId: "quote-1",
        offerNo: "301/26-27",
        subject: "Air conditioning quotation",
        items: [{ productId: "product-1", qty: 1 }],
      }),
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: "https://blob.example/quotation.pdf" });
    expect(mocks.getQuote).toHaveBeenCalledOnce();
    expect(mocks.generatePdf).toHaveBeenCalledOnce();
    expect(mocks.put).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
});
