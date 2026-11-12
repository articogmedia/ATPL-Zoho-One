import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("react", () => ({ cache: (load: (...args: never[]) => unknown) => load }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/cache", () => ({
  cached: vi.fn((_key: string, _ttl: number, load: () => unknown) => load()),
  getCachedValue: vi.fn(),
  invalidate: vi.fn(),
  markStale: vi.fn(),
  setCachedValue: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  env: () => ({ DATA_SOURCE: "zoho", ZOHO_MAX_LEADS: 5000 }),
}));

const zoho = vi.hoisted(() => vi.fn());

describe("Zoho Leads pagination sorting", () => {
  beforeEach(() => {
    vi.resetModules();
    zoho.mockReset().mockImplementation(async (_method: string, path: string) => {
      if (path === "/users") return { users: [] };
      if (path === "/Leads/search") return {
        data: [
          { id: "lead-older", Last_Name: "Older", Lead_Status: "Contacted", Created_Time: "2025-01-01T00:00:00Z" },
          { id: "lead-newer", Last_Name: "Newer", Lead_Status: "Contacted", Created_Time: "2026-01-01T00:00:00Z" },
        ],
        info: { count: 2, more_records: false },
      };
      if (path === "/Leads") return { data: [], info: { count: 0, more_records: false } };
      return {};
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class ZohoError extends Error {},
      ZOHO_CRM_API_VERSION: "v6",
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: vi.fn(async () => []),
      zohoWrite: vi.fn(),
    }));
  });

  it("omits unsupported sort parameters from owner-scoped Search Records and keeps newest leads first", async () => {
    const { zohoRepository } = await import("@/lib/zoho/repository");
    const listLeadsPage = zohoRepository.listLeadsPage;
    if (!listLeadsPage) throw new Error("The Zoho repository does not support paged leads.");

    const result = await listLeadsPage(2, 25, "exec-1");
    const request = zoho.mock.calls.find((call) => call[1] === "/Leads/search");
    const query = request?.[2]?.query as Record<string, unknown>;

    expect(query).toMatchObject({
      fields: expect.any(String),
      page: 2,
      per_page: 25,
      criteria: "(Owner.id:equals:exec-1)",
    });
    expect(query).not.toHaveProperty("sort_by");
    expect(query).not.toHaveProperty("sort_order");
    expect(result.leads.map((lead) => lead.id)).toEqual(["lead-newer", "lead-older"]);
  });

  it("retains Created_Time sorting for the supported unfiltered Get Records request", async () => {
    const { zohoRepository } = await import("@/lib/zoho/repository");
    const listLeadsPage = zohoRepository.listLeadsPage;
    if (!listLeadsPage) throw new Error("The Zoho repository does not support paged leads.");

    await listLeadsPage(1, 50);

    expect(zoho).toHaveBeenCalledWith("GET", "/Leads", expect.objectContaining({
      query: expect.objectContaining({
        page: 1,
        per_page: 50,
        sort_by: "Created_Time",
        sort_order: "desc",
      }),
    }));
  });
});
