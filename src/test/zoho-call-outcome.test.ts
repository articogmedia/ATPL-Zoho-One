import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (load: () => Promise<unknown>) => load,
}));

const leadId = "5725767000000123456";

beforeEach(async () => {
  vi.resetModules();
  process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";
  process.env.DATA_SOURCE = "mock";
  process.env.ZOHO_DC = "in";
  delete process.env.ZOHO_QUEUE_OWNER_ID;
  const { resetMemoryCache } = await import("@/lib/cache");
  resetMemoryCache();
});

function mockRepository(noteFailure = false) {
  const calls: { method: string; path: string; record: Record<string, unknown> }[] = [];
  const write = vi.fn(async (method: string, path: string, record: Record<string, unknown>) => {
    calls.push({ method, path, record });
    if (path === "/Notes" && noteFailure) throw new Error("Zoho Notes unavailable");
    return "created";
  });
  vi.doMock("@/lib/zoho/client", () => ({
    ZOHO_CRM_API_VERSION: "v6",
    ZohoError: class extends Error {
      constructor(message: string, readonly status?: number, readonly code?: string, readonly field?: string) {
        super(message);
      }
    },
    zoho: vi.fn(async (_method: string, path: string) => {
      if (path === `/Leads/${leadId}`) return { data: [{ id: leadId, Last_Name: "Call test lead", Company: "Call test lead", Mobile: "9876543210", Lead_Status: "Fresh Lead", Owner: { id: "manager-1", name: "Manager" } }] };
      if (path === "/users") return { users: [{ id: "manager-1", full_name: "Manager", role: { name: "Manager" }, profile: { name: "Administrator" } }] };
      if (path === "/settings/fields") {
        return { fields: ["Subject", "Status", "Due_Date", "Owner", "What_Id", "Who_Id", "Description"].map((api_name) => ({ api_name })) };
      }
      return { data: [] };
    }),
    zohoList: vi.fn(async (module: string) => module === "Leads"
      ? [{ id: leadId, Last_Name: "Call test lead", Company: "Call test lead", Mobile: "9876543210", Lead_Status: "Fresh Lead" }]
      : []),
    zohoWrite: write,
  }));
  return { calls, write };
}

describe("Zoho call outcome persistence", () => {
  it("uses the Zoho v6 call and note relationship payloads and tolerates a failed history note", async () => {
    const { calls } = mockRepository(true);
    const { zohoRepository } = await import("@/lib/zoho/repository");

    const result = await zohoRepository.logCall(
      { leadId, outcome: "Connected", remarks: "Answered" },
      { id: "manager-1", name: "Manager", role: "Manager" },
    );

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/Calls",
      record: expect.objectContaining({
        What_Id: { id: leadId },
        $se_module: "Leads",
        Subject: "Connected - Call test lead",
      }),
    });
    expect(calls[1]).toMatchObject({
      method: "PUT",
      path: `/Leads/${leadId}`,
      record: { Lead_Status: "Contacted" },
    });
    expect(calls[2]).toEqual({
      method: "POST",
      path: "/Notes",
      record: {
        Note_Title: "Call logged",
        Note_Content: expect.stringMatching(/^Connected: Answered \(by Manager at /),
        Parent_Id: { module: { api_name: "Leads" }, id: leadId },
      },
    });
    expect(calls[2]?.record).not.toHaveProperty("se_module");
    expect(result.historyWarning).toMatch(/outcome saved.*history note could not be added/i);
  });

  it("links follow-up Tasks to the exact Zoho Lead ID with $se_module", async () => {
    const { calls } = mockRepository();
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await zohoRepository.logCall(
      { leadId, outcome: "Call Back Later", remarks: "", followUp: "2026-11-07", followUpTime: "11:30" },
      { id: "manager-1", name: "Manager", role: "Manager" },
    );

    const task = calls.find((call) => call.path === "/Tasks");
    expect(task).toEqual({
      method: "POST",
      path: "/Tasks",
      record: expect.objectContaining({
        What_Id: { id: leadId },
        $se_module: "Leads",
        Due_Date: "2026-11-07",
        Owner: { id: "manager-1" },
      }),
    });
    const note = calls.find((call) => call.path === "/Notes");
    expect(note?.record).toEqual({
      Note_Title: "Call logged",
      Note_Content: expect.stringContaining("Call Back Later"),
      Parent_Id: { module: { api_name: "Leads" }, id: leadId },
    });
  });
});
