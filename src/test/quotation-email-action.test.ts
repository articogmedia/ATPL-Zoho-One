import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireActionUser: vi.fn(),
  getQuote: vi.fn(),
  addLeadNote: vi.fn(),
  getStoredQuotationPdf: vi.fn(),
  saveStoredQuotationPdf: vi.fn(),
  takeQuotationEmailRateLimit: vi.fn(),
  sendEmail: vi.fn(),
  generatePdf: vi.fn(),
  put: vi.fn(),
  env: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ put: mocks.put }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  requireActionUser: mocks.requireActionUser,
}));
vi.mock("@/lib/crm", () => ({
  crm: () => ({ getQuote: mocks.getQuote, addLeadNote: mocks.addLeadNote }),
}));
vi.mock("@/lib/cache", () => ({
  getCachedValue: vi.fn(),
  invalidate: vi.fn(),
  markStale: vi.fn(),
  setCachedValue: vi.fn(),
  withIdempotency: vi.fn(),
}));
vi.mock("@/lib/quotation-pdf-store", () => ({
  getStoredQuotationPdf: mocks.getStoredQuotationPdf,
  saveStoredQuotationPdf: mocks.saveStoredQuotationPdf,
  invalidateStoredQuotationPdf: vi.fn(),
}));
vi.mock("@/lib/quotation-pdf", () => ({ generateQuotationPdfBytes: mocks.generatePdf }));
vi.mock("@/lib/quotation-pdf-snapshot", () => ({ signQuotationPdfSnapshot: vi.fn(() => "fresh-snapshot") }));
vi.mock("@/lib/quotation-email-rate-limit", () => ({
  takeQuotationEmailRateLimit: mocks.takeQuotationEmailRateLimit,
}));
vi.mock("@/lib/email", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/lib/zoho/client", () => ({
  ZohoError: class ZohoError extends Error {},
  hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
}));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/crm-action-errors", () => ({
  friendlyZohoError: vi.fn(),
  newErrorReference: () => "TEST-REF",
}));
vi.mock("@/lib/perf-log", () => ({ logPerf: vi.fn() }));

const manager = { id: "manager-1", name: "Manager", role: "Manager" as const };
const quote = {
  id: "quote-1",
  offerNo: "301/26-27",
  revision: 2,
  leadId: "lead-1",
  customer: "Customer Co",
  contactName: "Customer",
  executive: "Pavan",
  ownerId: "manager-1",
  total: 118,
  date: "2026-11-11",
  items: [{ productId: "product-1", model: "AC", unit: "Nos", qty: 1, price: 100, taxRate: 0.18 }],
};

describe("sendQuotationEmailAction", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.requireActionUser.mockReset().mockResolvedValue(manager);
    mocks.getQuote.mockReset().mockResolvedValue(quote);
    mocks.addLeadNote.mockReset().mockResolvedValue(undefined);
    mocks.getStoredQuotationPdf.mockReset().mockResolvedValue({ url: "https://blob.example/offer.pdf" });
    mocks.saveStoredQuotationPdf.mockReset().mockResolvedValue(undefined);
    mocks.takeQuotationEmailRateLimit.mockReset().mockResolvedValue(true);
    mocks.sendEmail.mockReset().mockResolvedValue(undefined);
    mocks.generatePdf.mockReset().mockResolvedValue({ bytes: Buffer.from("%PDF-fixture"), filename: "offer.pdf" });
    mocks.put.mockReset().mockResolvedValue({ url: "https://blob.example/generated.pdf" });
    mocks.env.mockReset().mockReturnValue({
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: "sales@example.com",
      RESEND_API_KEY: "test-key",
      APP_URL: "https://sales.example.com",
      BLOB_READ_WRITE_TOKEN: "blob-token",
      ZOHO_SANDBOX: "true",
    });
  });

  it("sends the stored PDF link and logs a note on the lead", async () => {
    const { sendQuotationEmailAction } = await import("@/app/actions/crm");

    await expect(sendQuotationEmailAction({ quoteId: "quote-1", to: "customer@example.com" }))
      .resolves.toMatchObject({ ok: true, data: { noteLogged: true } });
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "customer@example.com",
      subject: "Quotation 301/26-27/R2 from Air Trendz P Ltd",
      text: expect.stringContaining("https://blob.example/offer.pdf"),
    }));
    expect(mocks.sendEmail.mock.calls[0]?.[0].text).toContain("GSTIN: 36AANCA9304M2Z7");
    expect(mocks.addLeadNote).toHaveBeenCalledWith(
      "lead-1",
      "Quotation emailed",
      expect.stringContaining("customer@example.com"),
    );
    expect(mocks.takeQuotationEmailRateLimit).toHaveBeenCalledWith("manager-1", "quote-1");
  });

  it("rejects malformed recipients and enforces the send limit before delivery", async () => {
    const { sendQuotationEmailAction } = await import("@/app/actions/crm");

    await expect(sendQuotationEmailAction({ quoteId: "quote-1", to: "not-an-email" }))
      .resolves.toMatchObject({ ok: false });
    mocks.takeQuotationEmailRateLimit.mockResolvedValue(false);
    await expect(sendQuotationEmailAction({ quoteId: "quote-1", to: "customer@example.com" }))
      .resolves.toMatchObject({ ok: false, error: "Email limit reached. Try again later." });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.addLeadNote).not.toHaveBeenCalled();
  });

  it("does not hide a successful delivery when CRM note logging fails", async () => {
    mocks.addLeadNote.mockRejectedValue(new Error("Zoho Notes unavailable"));
    const { sendQuotationEmailAction } = await import("@/app/actions/crm");

    await expect(sendQuotationEmailAction({ quoteId: "quote-1", to: "customer@example.com" }))
      .resolves.toMatchObject({ ok: true, data: { noteLogged: false } });
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
  });

  it("generates and uploads the saved quote PDF when Redis has no cached URL", async () => {
    mocks.getStoredQuotationPdf.mockRejectedValueOnce(new Error("Redis unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendQuotationEmailAction } = await import("@/app/actions/crm");

    await expect(sendQuotationEmailAction({ quoteId: "quote-1", to: "customer@example.com" }))
      .resolves.toMatchObject({ ok: true, data: { noteLogged: true } });
    expect(mocks.generatePdf).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: "quote-1", quoteSnapshotToken: "fresh-snapshot" }),
      manager,
    );
    expect(mocks.put).toHaveBeenCalledWith(
      "quotations/301-26-27-quote-1.pdf",
      Buffer.from("%PDF-fixture"),
      expect.objectContaining({ access: "public", allowOverwrite: true }),
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("https://blob.example/generated.pdf"),
    }));
    warning.mockRestore();
  });

  it("returns a clear configuration error when email is disabled", async () => {
    mocks.env.mockReturnValue({ EMAIL_PROVIDER: "disabled", ZOHO_SANDBOX: "true" });
    const { sendQuotationEmailAction } = await import("@/app/actions/crm");

    await expect(sendQuotationEmailAction({ quoteId: "quote-1", to: "customer@example.com" }))
      .resolves.toMatchObject({ ok: false, error: "Email is not configured." });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
