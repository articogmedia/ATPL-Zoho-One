import { beforeEach, describe, expect, it, vi } from "vitest";

const zoho = vi.hoisted(() => vi.fn());
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
    constructor(message: string, readonly status?: number) { super(message); }
  },
  hosts: () => ({ api: "https://www.zohoapis.in" }),
  zoho,
  zohoList: vi.fn(),
  zohoWrite: vi.fn(),
  ZOHO_CRM_API_VERSION: "v6",
}));

describe("Zoho invoice candidate loading", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "invoice-candidates-test-secret-long-enough";
    process.env.DATA_SOURCE = "mock";
    process.env.ZOHO_MAX_LEADS = "1000";
    delete process.env.CACHE_SHORT_TTL_MS;
    cached.mockClear();
    zoho.mockReset();
    zoho.mockImplementation(async (_method: string, path: string, options?: { query?: Record<string, unknown> }) => {
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
        expect(options?.query?.criteria).toContain("(Status:equals:Accepted)");
        expect(options?.query?.criteria).toContain("(Status:equals:Won)");
        expect(options?.query?.criteria).toContain("(Lead_Ref.id:in:won-lead)");
        return {
          data: [
            {
              id: "accepted-quote",
              Status: "Accepted",
              Lead_Ref: { id: "accepted-lead", name: "Accepted" },
              Grand_Total: 118,
              Created_Time: "2026-11-01T10:00:00+05:30",
              Owner: { id: "owner-accepted", name: "Executive" },
            },
            {
              id: "won-lead-quote",
              Status: "Sent",
              Lead_Ref: { id: "won-lead", name: "Won" },
              Grand_Total: 236,
              Created_Time: "2026-11-02T10:00:00+05:30",
              Owner: { id: "owner-won", name: "Executive" },
            },
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
    vi.resetModules();
  });

  it("searches only relevant quotes and returns only their associated leads", async () => {
    const { zohoRepository } = await import("@/lib/zoho/repository");
    const result = await zohoRepository.listInvoiceCandidates();

    expect(result.quotes.map((quote) => quote.id)).toEqual(["won-lead-quote", "accepted-quote"]);
    expect(result.leads.map((lead) => lead.id).sort()).toEqual(["accepted-lead", "won-lead"]);
    expect(zoho.mock.calls.map((call) => call[1])).toEqual([
      "/Leads/search",
      "/Quotes/search",
      "/Leads/accepted-lead",
    ]);
    expect(cached).toHaveBeenCalledWith("leads:invoice-won", 30_000, expect.any(Function), { keepStale: true });
  });
});
