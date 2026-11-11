import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireActionUser: vi.fn(),
  getQuote: vi.fn(),
  updateQuote: vi.fn(),
  invalidateStoredQuotationPdf: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  requireActionUser: mocks.requireActionUser,
}));
vi.mock("@/lib/crm", () => ({ crm: () => ({ getQuote: mocks.getQuote, updateQuote: mocks.updateQuote }) }));
vi.mock("@/lib/cache", () => ({
  getCachedValue: vi.fn(),
  invalidate: mocks.invalidate,
  markStale: vi.fn(),
  setCachedValue: vi.fn(),
  withIdempotency: vi.fn(),
}));
vi.mock("@/lib/quotation-pdf-store", () => ({
  getStoredQuotationPdf: vi.fn(),
  invalidateStoredQuotationPdf: mocks.invalidateStoredQuotationPdf,
}));

const manager = { id: "manager-1", name: "Manager", role: "Manager" as const };
const executive = { id: "executive-1", name: "Pavan", role: "Sales Executive" as const };
const quote = {
  id: "quote-1",
  offerNo: "301/26-27",
  leadId: "lead-1",
  customer: "Customer Co",
  executive: "Pavan",
  ownerId: "executive-1",
  total: 118,
  date: "2026-11-11",
  status: "Draft",
};
const input = {
  quoteId: "quote-1",
  leadId: "lead-1",
  subject: "Revised offer",
  items: [{ productId: "product-1", qty: 1, discount: 0, taxRate: 0.18 }],
  extraCharges: [],
};

describe("updateQuoteAction", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.requireActionUser.mockReset().mockResolvedValue(executive);
    mocks.getQuote.mockReset().mockResolvedValue(quote);
    mocks.updateQuote.mockReset().mockResolvedValue({ ...quote, revision: 1 });
    mocks.invalidateStoredQuotationPdf.mockReset().mockResolvedValue(undefined);
    mocks.invalidate.mockReset().mockResolvedValue(undefined);
  });

  it("allows an executive to edit their own draft and invalidates its saved PDF", async () => {
    const { updateQuoteAction } = await import("@/app/actions/crm");

    const result = await updateQuoteAction(input);

    expect(result).toMatchObject({ ok: true, data: { id: "quote-1", revision: 1 } });
    expect(mocks.updateQuote).toHaveBeenCalledWith("quote-1", expect.objectContaining({ leadId: "lead-1" }), executive);
    expect(mocks.invalidateStoredQuotationPdf).toHaveBeenCalledWith("quote-1");
  });

  it("denies executives access to another user's quotation", async () => {
    mocks.getQuote.mockResolvedValue({ ...quote, ownerId: "executive-2", executive: "Sai Kiran" });
    const { updateQuoteAction } = await import("@/app/actions/crm");

    const result = await updateQuoteAction(input);

    expect(result).toMatchObject({ ok: false, error: "Quotation not found or access denied." });
    expect(mocks.updateQuote).not.toHaveBeenCalled();
  });

  it.each(["Won", "Sent"])("blocks executive edits of %s quotations but allows Managers", async (status) => {
    mocks.getQuote.mockResolvedValue({ ...quote, status });
    const { updateQuoteAction } = await import("@/app/actions/crm");

    const denied = await updateQuoteAction(input);
    expect(denied).toMatchObject({ ok: false, error: "Only managers can edit Sent or Won quotations." });
    expect(mocks.updateQuote).not.toHaveBeenCalled();

    mocks.requireActionUser.mockResolvedValue(manager);
    await expect(updateQuoteAction(input)).resolves.toMatchObject({
      ok: true,
      data: { id: "quote-1", revision: 1 },
    });
    expect(mocks.updateQuote).toHaveBeenCalledOnce();
  });

  it("rejects a changed customer and malformed quote lines", async () => {
    const { updateQuoteAction } = await import("@/app/actions/crm");

    await expect(updateQuoteAction({ ...input, leadId: "lead-2" })).resolves.toMatchObject({
      ok: false,
      error: "The customer cannot be changed while editing a quotation.",
    });
    await expect(updateQuoteAction({ ...input, items: [] })).resolves.toMatchObject({
      ok: false,
    });
    expect(mocks.updateQuote).not.toHaveBeenCalled();
  });
});
