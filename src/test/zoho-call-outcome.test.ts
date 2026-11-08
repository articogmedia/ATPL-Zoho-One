import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const afterJobs = vi.hoisted(() => ({ jobs: [] as Array<() => Promise<void>> }));
vi.mock("next/server", () => ({
  after: (callback: () => Promise<void>) => { afterJobs.jobs.push(callback); },
}));
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
  afterJobs.jobs.length = 0;
  const { resetMemoryCache } = await import("@/lib/cache");
  resetMemoryCache();
});

async function flushAfterJobs() {
  const jobs = afterJobs.jobs.splice(0);
  await Promise.all(jobs.map((job) => job()));
}

function mockRepository(options: { noteFailure?: boolean; statusFailure?: boolean; taskFailure?: boolean; unassignedLead?: boolean } = {}) {
  const calls: { method: string; path: string; record: Record<string, unknown> }[] = [];
  const write = vi.fn(async (method: string, path: string, record: Record<string, unknown>) => {
    calls.push({ method, path, record });
    if (path === "/Notes" && options.noteFailure) throw new Error("Zoho Notes unavailable");
    if (path.startsWith("/Leads/") && method === "PUT" && options.statusFailure) throw new Error("Zoho lead update unavailable");
    if (path === "/Tasks" && options.taskFailure) throw new Error("Zoho Tasks unavailable");
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
      if (path === `/Leads/${leadId}`) return { data: [{ id: leadId, Last_Name: "Call test lead", Company: "Call test lead", Mobile: "9876543210", Lead_Status: "Fresh Lead", ...(options.unassignedLead ? {} : { Owner: { id: "manager-1", name: "Manager" } }) }] };
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
    const { calls } = mockRepository({ noteFailure: true });
    const { zohoRepository } = await import("@/lib/zoho/repository");

    const result = await zohoRepository.logCall(
      { leadId, outcome: "Connected", remarks: "Answered" },
      { id: "manager-1", name: "Manager", role: "Manager" },
    );
    expect(result).toEqual({});
    await flushAfterJobs();

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/Calls",
      record: expect.objectContaining({
        What_Id: { id: leadId },
        $se_module: "Leads",
        Subject: "Connected - Call test lead",
      }),
    });
    expect(calls[0]?.record.Call_Start_Time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
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
  });

  it("links follow-up Tasks to the exact Zoho Lead ID with $se_module", async () => {
    const { calls } = mockRepository();
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await zohoRepository.logCall(
      { leadId, outcome: "Call Back Later", remarks: "", followUp: "2026-11-07", followUpTime: "11:30" },
      { id: "manager-1", name: "Manager", role: "Manager" },
    );
    await flushAfterJobs();

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

  it("resolves an empty portal actor ID from the Zoho user name before writing Owner", async () => {
    const { calls } = mockRepository();
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await zohoRepository.logCall(
      { leadId, outcome: "Connected", remarks: "" },
      { id: "", name: "Manager", role: "Manager" },
    );

    expect(calls[0]?.record.Owner).toEqual({ id: "manager-1" });
    expect(JSON.stringify(calls[0]?.record)).not.toContain('"id":""');
    expect(calls[0]?.record.What_Id).toEqual({ id: leadId });
    expect(calls[0]?.record.$se_module).toBe("Leads");
  });

  it("omits Owner for an unmatched actor and an unassigned lead", async () => {
    const { calls } = mockRepository({ unassignedLead: true });
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await zohoRepository.logCall(
      { leadId, outcome: "Call Back Later", remarks: "", followUp: "2026-11-07" },
      { id: "", name: "Unmatched Portal User", role: "Manager" },
    );
    await flushAfterJobs();

    expect(calls[0]?.record).not.toHaveProperty("Owner");
    const followUpTask = calls.find((call) => call.path === "/Tasks");
    expect(followUpTask?.record).not.toHaveProperty("Owner");
  });

  it("returns partial-success warnings when later updates fail after the Calls POST", async () => {
    const { calls } = mockRepository({ statusFailure: true, taskFailure: true });
    const { zohoRepository } = await import("@/lib/zoho/repository");

    const result = await zohoRepository.logCall(
      { leadId, outcome: "Call Back Later", remarks: "", followUp: "2026-11-07" },
      { id: "manager-1", name: "Manager", role: "Manager" },
    );
    await flushAfterJobs();

    expect(calls[0]?.path).toBe("/Calls");
    expect(result).toEqual({});
    expect(calls.some((call) => call.path === `/Leads/${leadId}` && call.method === "PUT")).toBe(true);
    expect(calls.some((call) => call.path === "/Tasks")).toBe(true);
  });

  it.each([
    ["Connected", "Contacted"],
    ["No Answer", "Attempted to Contact"],
    ["Busy", "Attempted to Contact"],
    ["Wrong Number", "Not Responsive"],
    ["Call Back Later", "Callback in Future"],
  ] as const)("writes call outcome %s to Zoho and updates status", async (outcome, status) => {
    const { calls } = mockRepository();
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await zohoRepository.logCall({ leadId, outcome, remarks: "" }, {
      id: "manager-1", name: "Manager", role: "Manager",
    });
    await flushAfterJobs();

    expect(calls[0]?.record.Call_Result).toBe(outcome);
    expect(calls[0]?.record.Call_Start_Time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(calls.find((call) => call.path === `/Leads/${leadId}`)?.record.Lead_Status).toBe(status);
  });

  it("identifies the failing nested Zoho field path in user-facing errors", async () => {
    const { friendlyZohoError } = await import("@/lib/crm-action-errors");
    expect(friendlyZohoError(400, "INVALID_DATA", "invalid value", "id", "REF", undefined, {
      json_path: "What_Id.id",
    })).toContain("What_Id.id");
  });
});
