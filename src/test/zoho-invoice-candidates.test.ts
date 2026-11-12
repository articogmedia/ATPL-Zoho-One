import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZohoError } from "@/lib/zoho/client";

const zoho = vi.hoisted(() => vi.fn());
const zohoList = vi.hoisted(() => vi.fn());
const includeLeadReference = vi.hoisted(() => ({ value: true }));
const cached = vi.hoisted(() => vi.fn(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load()));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (load: () => unknown) => load }));
vi.mock("next/server", () => ({ after: (task: () => Promise<void> | void) => { void task; } }));
vi.mock("@/lib/cache", () => ({
  cached,
  getCachedValue: vi.fn(async () => undefined),
  invalidate: vi.fn(async () => undefined),
  markStale: vi.fn(async () => undefined),
  setCachedValue: vi.fn(async () => undefined),
}));
vi.mock("@/lib/zoho/client", () => ({
  ZohoError: class ZohoError extends Error {
    constructor(
      message: string,
      readonly status?: number,
      readonly code?: string,
      readonly field?: string,
      readonly invalidValue?: unknown,
      readonly operation?: string,
      readonly details?: Record<string, unknown>,
      readonly reference?: string,
    ) { super(message); }
  },
  hosts: () => ({ api: "https://www.zohoapis.in" }),
  zoho,
  zohoList,
  zohoWrite: vi.fn(),
  ZOHO_CRM_API_VERSION: "v6",
}));

const quoteFields = () => [
  "Subject", "Quote_Stage", "Owner", "Created_Time", "Sub_Total", "Discount", "Tax",
  "Adjustment", "Grand_Total", "Account_Name", "Contact_Name", "Valid_Till",
  "Description", "Offer_No", ...(includeLeadReference.value ? ["Lead_Ref"] : []),
].map((api_name) => ({ api_name }));

describe("Zoho invoice candidate loading", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "invoice-candidates-test-secret-long-enough";
    process.env.DATA_SOURCE = "mock";
    process.env.ZOHO_MAX_LEADS = "1000";
    delete process.env.CACHE_SHORT_TTL_MS;
    includeLeadReference.value = true;
    cached.mockClear();
    zoho.mockReset();
    zohoList.mockReset();
    zoho.mockImplementation(async (_method: string, path: string, options?: { query?: Record<string, unknown> }) => {
      if (path === "/settings/fields" && options?.query?.module === "Quotes") {
        return { fields: quoteFields() };
      }
      if (path === "/settings/layouts" && options?.query?.module === "Quotes") {
        return { layouts: [] };
      }
      if (path === "/Leads/search") {
        return {
          data: [{
            id: "won-lead",
            Last_Name: "Won",
            Company: "Won Co",
            Lead_Status: "Won",
            Owner: { id: "owner-won", name: "Executive" },
          }],
          info: { more_records: false },
        };
      }
      if (path === "/Quotes/search") {
        const criteria = String(options?.query?.criteria ?? "");
        expect(criteria).toContain("(Quote_Stage:equals:Accepted)");
        expect(criteria).toContain("(Quote_Stage:equals:Won)");
        expect(criteria).not.toContain("Status");
        expect(String(options?.query?.fields)).toContain("Quote_Stage");
        expect(String(options?.query?.fields)).not.toContain("Status");
        if (includeLeadReference.value) {
          expect(criteria).toContain("(Lead_Ref.id:in:won-lead)");
          expect(String(options?.query?.fields)).toContain("Lead_Ref");
        } else {
          expect(criteria).not.toContain("Lead_Ref");
          expect(String(options?.query?.fields)).not.toContain("Lead_Ref");
        }
        return {
          data: [
            {
              id: "accepted-quote",
              Quote_Stage: "Accepted",
              ...(includeLeadReference.value ? { Lead_Ref: { id: "accepted-lead", name: "Accepted" } } : {}),
              Description: JSON.stringify({ leadId: "accepted-lead" }),
              Grand_Total: 118,
              Created_Time: "2026-11-01T10:00:00+05:30",
              Owner: { id: "owner-accepted", name: "Executive" },
            },
            ...(includeLeadReference.value ? [{
              id: "won-lead-quote",
              Quote_Stage: "Sent",
              Lead_Ref: { id: "won-lead", name: "Won" },
              Grand_Total: 236,
              Created_Time: "2026-11-02T10:00:00+05:30",
              Owner: { id: "owner-won", name: "Executive" },
            }] : []),
          ],
          info: { more_records: false },
        };
      }
      if (path === "/Leads/accepted-lead") {
        return {
          data: [{
            id: "accepted-lead",
            Last_Name: "Accepted",
            Company: "Accepted Co",
            Lead_Status: "Contacted",
            Owner: { id: "owner-accepted", name: "Executive" },
          }],
        };
      }
      throw new Error(`Unexpected Zoho request: ${path}`);
    });
    zohoList.mockImplementation(async (module: string, fields: string[]) => {
      expect(module).toBe("Quotes");
      expect(fields).toContain("Description");
      expect(fields).not.toContain("Lead_Ref");
      return [{
        id: "won-lead-quote",
        Quote_Stage: "Sent",
        Description: JSON.stringify({ leadId: "won-lead" }),
        Grand_Total: 236,
        Created_Time: "2026-11-02T10:00:00+05:30",
        Owner: { id: "owner-won", name: "Executive" },
      }];
    });
    vi.resetModules();
  });

  it("searches only relevant quotes and returns only their associated leads", async () => {
    const { zohoRepository } = await import("@/lib/zoho/repository");
    const result = await zohoRepository.listInvoiceCandidates();

    expect(result.quotes.map((quote) => quote.id)).toEqual(["won-lead-quote", "accepted-quote"]);
    expect(result.leads.map((lead) => lead.id).sort()).toEqual(["accepted-lead", "won-lead"]);
    expect(zoho.mock.calls.map((call) => call[1]).filter((path) => path === "/Leads/search" || path === "/Quotes/search" || path === "/Leads/accepted-lead")).toEqual([
      "/Leads/search",
      "/Quotes/search",
      "/Leads/accepted-lead",
    ]);
    expect(cached).toHaveBeenCalledWith("leads:invoice-won", 30_000, expect.any(Function), { keepStale: true });
    expect(zohoList).not.toHaveBeenCalled();
  });

  it("omits a missing Lead_Ref and finds Won-lead quotes by saved snapshot lead ID", async () => {
    includeLeadReference.value = false;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { zohoRepository } = await import("@/lib/zoho/repository");

    const result = await zohoRepository.listInvoiceCandidates();

    expect(result.quotes.map((quote) => quote.id)).toEqual(["won-lead-quote", "accepted-quote"]);
    expect(result.leads.map((lead) => lead.id).sort()).toEqual(["accepted-lead", "won-lead"]);
    expect(zohoList).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Quotes module is missing the lead reference field"),
      { module: "Quotes", field: "Lead_Ref" },
    );
    warning.mockRestore();
  });

  it("logs the actual module and path when a search is rejected as INVALID_QUERY", async () => {
    const { zohoRepository } = await import("@/lib/zoho/repository");
    const originalImplementation = zoho.getMockImplementation();
    const rejection = new ZohoError(
      "Invalid query formed",
      400,
      "INVALID_QUERY",
      "Lead_Ref",
      undefined,
      "GET /Quotes/search?criteria=...",
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    if (!originalImplementation) throw new Error("Missing Zoho test mock implementation.");
    zoho.mockImplementation(async (method: string, path: string, options?: { query?: Record<string, unknown> }) => {
      if (path === "/Quotes/search") throw rejection;
      return originalImplementation(method, path, options);
    });

    await expect(zohoRepository.listInvoiceCandidates()).rejects.toBe(rejection);

    expect(errorLog).toHaveBeenCalledWith(
      "[zoho] CRM search query rejected",
      expect.objectContaining({
        module: "Quotes",
        path: "/Quotes/search",
        operation: "GET /Quotes/search?criteria=...",
        code: "INVALID_QUERY",
        field: "Lead_Ref",
      }),
    );
    errorLog.mockRestore();
  });
});
