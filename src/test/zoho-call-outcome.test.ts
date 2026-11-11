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

function mockRepository(options: { noteFailure?: boolean; statusFailure?: boolean; taskFailure?: boolean; unassignedLead?: boolean; callFailure?: boolean; dependentCallFirst?: boolean } = {}) {
  const calls: { method: string; path: string; record: Record<string, unknown> }[] = [];
  let callAttempts = 0;
  class MockZohoError extends Error {
    constructor(
      message: string,
      readonly status?: number,
      readonly code?: string,
      readonly field?: string,
      readonly details?: Record<string, unknown>,
      readonly operation?: string,
    ) {
      super(message);
    }
  }
  const write = vi.fn(async (method: string, path: string, record: Record<string, unknown>) => {
    calls.push({ method, path, record });
    if (path === "/Calls") {
      callAttempts += 1;
      if (options.dependentCallFirst && callAttempts === 1) {
        throw new MockZohoError("Dependent field missing", 400, "DEPENDENT_FIELD_MISSING", "Call_Category", {
          api_name: "Call_Category", json_path: "$.data[0].Call_Category", dependee: "Call_Type",
        }, "POST /Calls");
      }
      if (options.callFailure) throw new MockZohoError("Call rejected", 400, "INVALID_DATA", "Call_Purpose");
    }
    if (path === "/Notes" && options.noteFailure) throw new Error("Zoho Notes unavailable");
    if (path.startsWith("/Leads/") && method === "PUT" && options.statusFailure) throw new Error("Zoho lead update unavailable");
    if (path === "/Tasks" && options.taskFailure) throw new Error("Zoho Tasks unavailable");
    return "created";
  });
  vi.doMock("@/lib/zoho/client", () => ({
    ZOHO_CRM_API_VERSION: "v6",
    ZohoError: MockZohoError,
    zoho: vi.fn(async (_method: string, path: string, opts?: { query?: { module?: string } }) => {
      if (path === `/Leads/${leadId}`) return { data: [{ id: leadId, Last_Name: "Call test lead", Company: "Call test lead", Mobile: "9876543210", Lead_Status: "Fresh Lead", ...(options.unassignedLead ? {} : { Owner: { id: "manager-1", name: "Manager" } }) }] };
      if (path === `/Leads/${leadId}/Calls`) return { data: calls.filter((entry) => entry.path === "/Calls").map((entry, index) => ({
        id: String(index + 1),
        Call_Start_Time: String(entry.record.Call_Start_Time ?? ""),
        Call_Result: entry.record.Call_Result,
        Owner: entry.record.Owner,
      })) };
      if (path === "/users") return { users: [{ id: "manager-1", full_name: "Manager", role: { name: "Manager" }, profile: { name: "Administrator" } }] };
      if (path === "/settings/fields") {
        if (opts?.query?.module === "Calls") return { fields: [
          { api_name: "Subject" },
          { api_name: "Call_Type", required: true, pick_list_values: [{ actual_value: "Inbound" }, { actual_value: "Outbound" }] },
          { api_name: "Call_Result", pick_list_values: ["Connected", "No Answer", "Busy", "Call Back Later", "Wrong Number"].map((actual_value) => ({ actual_value })) },
          { api_name: "Call_Status", pick_list_values: [{ actual_value: "Completed" }, { actual_value: "Not Connected" }] },
          { api_name: "Call_Purpose", pick_list_values: [{ actual_value: "Prospecting" }, { actual_value: "Customer Support" }] },
          { api_name: "Call_Category", pick_list_values: [{ actual_value: "Category A" }, { actual_value: "Category B" }] },
        ] };
        if (opts?.query?.module === "Leads") return { fields: [
          { api_name: "Lead_Status", pick_list_values: ["Fresh Lead", "Contacted", "Attempted to Contact", "Callback in Future", "Not Responsive"].map((actual_value) => ({ actual_value })) },
          { api_name: "Description" },
        ] };
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
  it("counts consecutive missed calls, ignores Wrong Number, resets on Connected, and records each attempt", async () => {
    const { calls } = mockRepository();
    const { zohoRepository } = await import("@/lib/zoho/repository");
    const actor = { id: "manager-1", name: "Manager", role: "Manager" as const };
    const outcomes = ["No Answer", "Wrong Number", "Busy", "Connected", "Busy", "No Answer", "Busy"] as const;
    const expected = [1, 1, 2, 0, 1, 2, 3];
    for (const [index, outcome] of outcomes.entries()) {
      const result = await zohoRepository.logCall(
        { leadId, outcome, remarks: "", notResponsiveAttempts: 3 },
        actor,
      );
      expect(result.attempts).toBe(expected[index]);
      if (index === outcomes.length - 1) expect(result.status).toBe("Not Responsive");
    }
    expect(calls.filter((call) => call.path === "/Calls")).toHaveLength(outcomes.length);
    expect(calls.filter((call) => call.path === "/Calls").map((call) => call.record.Call_Result)).toEqual(outcomes);
  });

  it("uses the Zoho v6 call and note relationship payloads and tolerates a failed history note", async () => {
    const { calls } = mockRepository({ noteFailure: true });
    const { zohoRepository } = await import("@/lib/zoho/repository");

    const result = await zohoRepository.logCall(
      { leadId, outcome: "Connected", remarks: "Answered" },
      { id: "manager-1", name: "Manager", role: "Manager" },
    );
    expect(result).toMatchObject({ historyWarning: "The change was saved, but its history note could not be added." });
    await flushAfterJobs();

    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: `/Leads/${leadId}`,
      record: { Lead_Status: "Contacted", Description: "Answered" },
    });
    expect(calls[1]).toEqual({
      method: "POST",
      path: "/Notes",
      record: {
        Note_Title: "Call logged",
        Note_Content: expect.stringMatching(/^Connected: Answered \(by Manager at /),
        Parent_Id: { module: { api_name: "Leads" }, id: leadId },
      },
    });
    const callRecord = calls.find((call) => call.path === "/Calls");
    expect(callRecord).toEqual({
      method: "POST",
      path: "/Calls",
      record: expect.objectContaining({
        What_Id: { id: leadId },
        $se_module: "Leads",
        Subject: "Connected - Call test lead",
      }),
    });
    expect(callRecord?.record.Call_Start_Time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(calls[1]?.record).not.toHaveProperty("se_module");
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

    const call = calls.find((item) => item.path === "/Calls");
    expect(call?.record.Owner).toEqual({ id: "manager-1" });
    expect(JSON.stringify(call?.record)).not.toContain('"id":""');
    expect(call?.record.What_Id).toEqual({ id: leadId });
    expect(call?.record.$se_module).toBe("Leads");
  });

  it("omits Owner for an unmatched actor and an unassigned lead", async () => {
    const { calls } = mockRepository({ unassignedLead: true });
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await zohoRepository.logCall(
      { leadId, outcome: "Call Back Later", remarks: "", followUp: "2026-11-07" },
      { id: "", name: "Unmatched Portal User", role: "Manager" },
    );
    await flushAfterJobs();

    expect(calls.find((item) => item.path === "/Calls")?.record).not.toHaveProperty("Owner");
    const followUpTask = calls.find((call) => call.path === "/Tasks");
    expect(followUpTask?.record).not.toHaveProperty("Owner");
  });

  it("does not fail when the Call record fails and queues a background retry", async () => {
    const { calls } = mockRepository({ callFailure: true });
    const { zohoRepository } = await import("@/lib/zoho/repository");

    const result = await zohoRepository.logCall(
      { leadId, outcome: "Call Back Later", remarks: "", followUp: "2026-11-07" },
      { id: "manager-1", name: "Manager", role: "Manager" },
    );
    expect(result).toMatchObject({
      callLogPending: true,
      attempts: 0,
      lastOutcome: "Call Back Later",
      status: "Callback in Future",
    });
    expect(calls.some((call) => call.path === `/Leads/${leadId}` && call.method === "PUT")).toBe(true);
    expect(calls.some((call) => call.path === "/Notes")).toBe(true);
    expect(calls.filter((call) => call.path === "/Calls")).toHaveLength(1);
    await flushAfterJobs();

    expect(calls.filter((call) => call.path === "/Calls")).toHaveLength(2);
  });

  it.each([
    ["Connected", "Completed"],
    ["No Answer", "Not Connected"],
    ["Call Back Later", "Not Connected"],
    ["Wrong Number", "Not Connected"],
  ] as const)("retries a dependent-field error for %s with valid picklist values", async (outcome, callStatus) => {
    const { calls } = mockRepository({ dependentCallFirst: true });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { zohoRepository } = await import("@/lib/zoho/repository");
    const result = await zohoRepository.logCall({ leadId, outcome, remarks: "customer-only remark" }, {
      id: "manager-1", name: "Manager", role: "Manager",
    });
    await flushAfterJobs();

    const callWrites = calls.filter((call) => call.path === "/Calls");
    expect(result).toMatchObject({
      attempts: outcome === "No Answer" ? 1 : 0,
      lastOutcome: outcome,
      status: outcome === "Connected" ? "Contacted"
        : outcome === "No Answer" ? "Attempted to Contact"
          : outcome === "Call Back Later" ? "Callback in Future" : "Fresh Lead",
    });
    expect(callWrites).toHaveLength(2);
    expect(callWrites[0]?.record.Call_Status).toBe(callStatus);
    expect(callWrites[0]?.record.Call_Purpose).toBe("Prospecting");
    expect(callWrites[0]?.record).not.toHaveProperty("Call_Category");
    expect(callWrites[1]?.record.Call_Category).toBe("Category A");
    expect(errorLog).toHaveBeenCalledWith("[zoho] required/dependent field missing", expect.objectContaining({
      module: "Calls",
      api_name: "Call_Category",
      json_path: "$.data[0].Call_Category",
      dependee: "Call_Type",
      payloadKeys: expect.arrayContaining(["Subject", "Description", "Call_Type", "Call_Purpose"]),
    }));
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("customer-only remark");
    errorLog.mockRestore();
  });

  it.each([
    ["Connected", "Contacted"],
    ["No Answer", "Attempted to Contact"],
    ["Busy", "Attempted to Contact"],
    ["Wrong Number", "Fresh Lead"],
    ["Call Back Later", "Callback in Future"],
  ] as const)("writes call outcome %s to Zoho and updates status", async (outcome, status) => {
    const { calls } = mockRepository();
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await zohoRepository.logCall({ leadId, outcome, remarks: "" }, {
      id: "manager-1", name: "Manager", role: "Manager",
    });
    await flushAfterJobs();

    const call = calls.find((item) => item.path === "/Calls");
    expect(call?.record.Call_Result).toBe(outcome);
    expect(call?.record.Call_Start_Time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(calls.find((call) => call.path === `/Leads/${leadId}`)?.record.Lead_Status).toBe(status);
  });

  it("identifies the failing nested Zoho field path in user-facing errors", async () => {
    const { friendlyZohoError } = await import("@/lib/crm-action-errors");
    expect(friendlyZohoError(400, "INVALID_DATA", "invalid value", "id", "REF", undefined, {
      json_path: "What_Id.id",
    })).toContain("What_Id.id");
  });
});
