import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireActionUser: vi.fn(),
  getQuote: vi.fn(),
  getLead: vi.fn(),
  listInvoices: vi.fn(),
  createInvoice: vi.fn(),
  getInvoice: vi.fn(),
  addLeadNote: vi.fn(),
  getStoredInvoicePdf: vi.fn(),
  takeQuotationEmailRateLimit: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  requireActionUser: mocks.requireActionUser,
}));
vi.mock("@/lib/crm", () => ({
  crm: () => ({
    getQuote: mocks.getQuote,
    getLead: mocks.getLead,
    listInvoices: mocks.listInvoices,
    createInvoice: mocks.createInvoice,
    getInvoice: mocks.getInvoice,
    addLeadNote: mocks.addLeadNote,
  }),
}));
vi.mock("@/lib/cache", () => ({
  getCachedValue: vi.fn(),
  invalidate: vi.fn(),
  markStale: vi.fn(),
  setCachedValue: vi.fn(),
  withIdempotency: vi.fn((_key: string, operation: () => unknown) => operation()),
}));
vi.mock("@/lib/quotation-pdf-store", () => ({
  getStoredQuotationPdf: vi.fn(),
  invalidateStoredQuotationPdf: vi.fn(),
}));
vi.mock("@/lib/invoice-pdf-store", () => ({
  getStoredInvoicePdf: mocks.getStoredInvoicePdf,
  saveStoredInvoicePdf: vi.fn(),
}));
vi.mock("@/lib/invoice-pdf", () => ({ renderInvoicePdf: vi.fn() }));
vi.mock("@/lib/quotation-email-rate-limit", () => ({ takeQuotationEmailRateLimit: mocks.takeQuotationEmailRateLimit }));
vi.mock("@vercel/blob", () => ({ put: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/lib/zoho/client", () => ({
  ZohoError: class ZohoError extends Error {},
  hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
}));
vi.mock("@/lib/env", () => ({ env: () => ({ ZOHO_SANDBOX: "true" }) }));
vi.mock("@/lib/crm-action-errors", () => ({
  friendlyZohoError: vi.fn(),
  newErrorReference: () => "TEST-REF",
}));
vi.mock("@/lib/perf-log", () => ({ logPerf: vi.fn() }));

const executive = { id: "exec-1", name: "Pavan", role: "Sales Executive" as const };
const quote = {
  id: "quote-1",
  offerNo: "301/26-27",
  leadId: "lead-1",
  customer: "Customer Ltd",
  executive: "Pavan",
  ownerId: "exec-1",
  total: 118,
  date: "2026-04-02",
  items: [{ productId: "product-1", model: "Unit", unit: "Nos", qty: 1, price: 100 }],
};
const lead = {
  id: "lead-1",
  name: "Customer",
  company: "Customer Ltd",
  phone: "9999999999",
  area: "",
  source: "Direct Call" as const,
  status: "Won" as const,
  assignedTo: "Pavan",
  assignedToId: "exec-1",
  ownerId: "exec-1",
  remarks: "",
  createdOn: "2026-04-01",
  address: "",
  touchedBy: [],
};
const invoice = {
  id: "invoice-1",
  invoiceNo: "INV/26-27/0001",
  quoteId: quote.id,
  leadId: "lead-1",
  ownerId: "exec-1",
  executive: "Pavan",
  customer: "Customer Ltd",
  contactName: "Customer",
  email: "customer@example.com",
  phone: "9999999999",
  date: "2026-04-02",
  status: "Created",
  total: 118,
  items: [],
  gstBreakdown: { subtotal: 100, discount: 0, gst: 18, total: 118, rate: 0.18, partA: { subtotal: 100, discount: 0, gst: 18, total: 118 }, partB: { subtotal: 0, discount: 0, gst: 0, total: 0 } },
};

describe("convertQuoteToInvoiceAction", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.requireActionUser.mockReset().mockResolvedValue(executive);
    mocks.getQuote.mockReset().mockResolvedValue(quote);
    mocks.getLead.mockReset().mockResolvedValue(lead);
    mocks.listInvoices.mockReset().mockResolvedValue([]);
    mocks.createInvoice.mockReset().mockResolvedValue(invoice);
    mocks.getInvoice.mockReset().mockResolvedValue(invoice);
    mocks.addLeadNote.mockReset().mockResolvedValue(undefined);
    mocks.getStoredInvoicePdf.mockReset().mockResolvedValue({ url: "https://blob.example/invoice.pdf" });
    mocks.takeQuotationEmailRateLimit.mockReset().mockResolvedValue(true);
    mocks.sendEmail.mockReset().mockResolvedValue(undefined);
  });

  it("creates an invoice from an owned Won quotation", async () => {
    const { convertQuoteToInvoiceAction } = await import("@/app/actions/crm");
    await expect(convertQuoteToInvoiceAction({ quoteId: quote.id, gstin: "invalid" }))
      .resolves.toMatchObject({ ok: false });
    expect(mocks.createInvoice).not.toHaveBeenCalled();
    await expect(convertQuoteToInvoiceAction({ quoteId: quote.id, gstin: "36ABCDE1234F1Z5" }))
      .resolves.toMatchObject({ ok: true, data: invoice });
    expect(mocks.createInvoice).toHaveBeenCalledWith(quote, lead, executive, "36ABCDE1234F1Z5");
  });

  it("rejects drafts and quotations owned by another executive", async () => {
    const { convertQuoteToInvoiceAction } = await import("@/app/actions/crm");
    mocks.getLead.mockResolvedValue({ ...lead, status: "Contacted" });
    await expect(convertQuoteToInvoiceAction({ quoteId: quote.id }))
      .resolves.toMatchObject({ ok: false });
    expect(mocks.createInvoice).not.toHaveBeenCalled();

    mocks.getLead.mockResolvedValue(lead);
    mocks.getQuote.mockResolvedValue({ ...quote, ownerId: "exec-2" });
    await expect(convertQuoteToInvoiceAction({ quoteId: quote.id }))
      .resolves.toMatchObject({ ok: false, error: "Quotation not found or access denied." });
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("returns an existing invoice instead of creating a duplicate", async () => {
    mocks.listInvoices.mockResolvedValue([invoice]);
    const { convertQuoteToInvoiceAction } = await import("@/app/actions/crm");
    await expect(convertQuoteToInvoiceAction({ quoteId: quote.id }))
      .resolves.toMatchObject({ ok: true, data: invoice });
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it("emails the stored PDF link and logs the invoice on its lead", async () => {
    const { sendInvoiceEmailAction } = await import("@/app/actions/crm");
    await expect(sendInvoiceEmailAction({ invoiceId: invoice.id, to: "customer@example.com" }))
      .resolves.toMatchObject({ ok: true, data: { noteLogged: true } });
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "customer@example.com",
      subject: "Invoice INV/26-27/0001 from Air Trendz P Ltd",
      text: expect.stringContaining("https://blob.example/invoice.pdf"),
    }));
    expect(mocks.addLeadNote).toHaveBeenCalledWith("lead-1", "Invoice emailed", expect.stringContaining(invoice.invoiceNo));
  });

  it("validates the email recipient and rate-limits invoice sends", async () => {
    const { sendInvoiceEmailAction } = await import("@/app/actions/crm");
    await expect(sendInvoiceEmailAction({ invoiceId: invoice.id, to: "invalid" }))
      .resolves.toMatchObject({ ok: false });
    mocks.takeQuotationEmailRateLimit.mockResolvedValue(false);
    await expect(sendInvoiceEmailAction({ invoiceId: invoice.id, to: "customer@example.com" }))
      .resolves.toMatchObject({ ok: false, error: "Email limit reached. Try again later." });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});