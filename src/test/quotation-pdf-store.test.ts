import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCache = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  getCachedValue: vi.fn(async (key: string) => mockCache.values.get(key)),
  setCachedValue: vi.fn(async (key: string, _ttl: number, value: unknown) => { mockCache.values.set(key, value); }),
  invalidate: vi.fn(async (key: string) => { mockCache.values.delete(key); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/cache", () => ({
  getCachedValue: mockCache.getCachedValue,
  setCachedValue: mockCache.setCachedValue,
  invalidate: mockCache.invalidate,
}));

describe("stored quotation PDFs", () => {
  beforeEach(() => {
    mockCache.values.clear();
    mockCache.getCachedValue.mockClear();
    mockCache.setCachedValue.mockClear();
    mockCache.invalidate.mockClear();
  });

  it("stores and retrieves a shared PDF URL with its quote owner", async () => {
    const { getStoredQuotationPdf, saveStoredQuotationPdf } = await import("@/lib/quotation-pdf-store");
    const pdf = { url: "https://blob.example/quotation.pdf", ownerId: "executive-1" };

    await saveStoredQuotationPdf("quote-1", pdf);

    await expect(getStoredQuotationPdf("quote-1")).resolves.toEqual(pdf);
    expect(mockCache.setCachedValue).toHaveBeenCalledWith(
      "quotation-pdf:quote-1",
      expect.any(Number),
      pdf,
      { keepStale: true },
    );
  });

  it("invalidates the stored PDF when its quote is edited", async () => {
    const { invalidateStoredQuotationPdf, saveStoredQuotationPdf } = await import("@/lib/quotation-pdf-store");
    await saveStoredQuotationPdf("quote-1", { url: "https://blob.example/old.pdf", ownerId: "manager-1" });

    await invalidateStoredQuotationPdf("quote-1");

    expect(mockCache.invalidate).toHaveBeenCalledWith("quotation-pdf:quote-1");
    expect(mockCache.values.has("quotation-pdf:quote-1")).toBe(false);
  });

  it("treats cache read and write failures as non-fatal", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockCache.getCachedValue.mockRejectedValueOnce(new Error("Redis unavailable"));
    mockCache.setCachedValue.mockRejectedValueOnce(new Error("Redis unavailable"));
    const { getStoredQuotationPdf, saveStoredQuotationPdf } = await import("@/lib/quotation-pdf-store");

    await expect(getStoredQuotationPdf("quote-1")).resolves.toBeUndefined();
    await expect(saveStoredQuotationPdf("quote-1", { url: "https://blob.example/quotation.pdf" })).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });
});
