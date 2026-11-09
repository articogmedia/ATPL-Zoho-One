import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.resetModules();
  process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";
  process.env.DATA_SOURCE = "mock";
  process.env.ZOHO_SANDBOX = "true";
  vi.doUnmock("@/lib/zoho/client");
  vi.doUnmock("@/lib/auth/guard");
  vi.doUnmock("@/lib/crm");
  vi.doUnmock("next/cache");
});

const leadFieldSettings = {
  fields: [
    { api_name: "Last_Name" },
    { api_name: "Company" },
    { api_name: "Mobile" },
    { api_name: "Lead_Status" },
    { api_name: "Lead_Source", pick_list_values: [{ actual_value: "Meta Ads" }, { actual_value: "Direct Call" }, { actual_value: "Other" }] },
    { api_name: "City" },
    { api_name: "Description" },
  ],
};

describe("Zoho create-lead flow", () => {
  it("rebuilds Set metadata after the cached schema is serialized", async () => {
    const write = vi.fn(async (_method: string, path: string) => path === "/Leads" ? "serialized-lead" : "");
    vi.doMock("next/cache", () => ({
      revalidateTag: vi.fn(),
      revalidatePath: vi.fn(),
      unstable_cache: (load: () => Promise<unknown>) => async () =>
        JSON.parse(JSON.stringify(await load())) as unknown,
    }));
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {
        constructor(message: string, readonly status?: number, readonly code?: string, readonly field?: string) {
          super(message);
        }
      },
      zoho: vi.fn(async (_method: string, path: string) => path === "/settings/fields"
        ? leadFieldSettings
        : { data: [] }),
      zohoList: vi.fn(async () => []),
      zohoWrite: write,
    }));

    const { invalidate } = await import("@/lib/cache");
    const { zohoRepository } = await import("@/lib/zoho/repository");
    invalidate("zoho:lead-schema");
    const lead = await zohoRepository.createLead(
      { name: "Cache round-trip", company: "", phone: "9876543210", area: "", source: "Meta Ads", remarks: "" },
      { id: "manager-1", name: "Manager", role: "Manager" },
      null,
    );

    expect(lead.id).toBe("serialized-lead");
    expect(write).toHaveBeenCalledWith("POST", "/Leads", expect.objectContaining({
      Last_Name: "Cache round-trip",
      Company: "Cache round-trip",
      Mobile: "9876543210",
      Lead_Source: "Meta Ads",
      Lead_Status: "Fresh Lead",
    }), { trigger: ["workflow"] });
  });

  it("returns ok for a valid Add Lead action payload", async () => {
    const createLead = vi.fn(async () => ({
      id: "lead-created",
      name: "Sai Kiran prospect",
      company: "Sai Kiran prospect",
      phone: "9876543210",
      area: "",
      source: "Meta Ads",
      status: "Assigned to Sales",
      assignedTo: "Sai Kiran",
      assignedToId: "zoho-user-1",
      remarks: "",
      createdOn: "2026-11-06",
      address: "",
      touchedBy: ["Manager"],
    }));
    vi.doMock("next/cache", () => ({
      revalidateTag: vi.fn(),
      revalidatePath: vi.fn(),
      unstable_cache: (load: () => unknown) => load,
    }));
    vi.doMock("@/lib/auth/guard", () => ({
      ForbiddenError: class extends Error {},
      requireActionUser: vi.fn(async () => ({ id: "manager-1", name: "Manager", role: "Manager" })),
    }));
    vi.doMock("@/lib/crm", () => ({ crm: () => ({ createLead }) }));

    const { addLeadAction } = await import("@/app/actions/crm");
    const result = await addLeadAction({
      name: "Sai Kiran prospect",
      company: "",
      phone: "9876543210",
      area: "",
      source: "Meta Ads",
      remarks: "",
      assignedToId: "zoho-user-1",
    });

    expect(result).toMatchObject({ ok: true, data: { id: "lead-created", assignedTo: "Sai Kiran" } });
    expect(createLead).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Sai Kiran prospect", phone: "9876543210", source: "Meta Ads" }),
      { id: "manager-1", name: "Manager", role: "Manager" },
      "zoho-user-1",
      undefined,
    );
  });

  it("replays the same Add Lead result for a repeated idempotency key", async () => {
    const createLead = vi.fn(async () => ({
      id: "lead-idempotent",
      name: "Retry customer",
      company: "Retry customer",
      phone: "9876543210",
      area: "",
      source: "Meta Ads",
      status: "Fresh Lead",
      assignedTo: null,
      remarks: "",
      createdOn: "2026-11-06",
      address: "",
      touchedBy: ["Manager"],
    }));
    vi.doMock("next/cache", () => ({
      revalidateTag: vi.fn(),
      revalidatePath: vi.fn(),
      unstable_cache: (load: () => unknown) => load,
    }));
    vi.doMock("@/lib/auth/guard", () => ({
      ForbiddenError: class extends Error {},
      requireActionUser: vi.fn(async () => ({ id: "manager-1", name: "Manager", role: "Manager" })),
    }));
    vi.doMock("@/lib/crm", () => ({ crm: () => ({ createLead }) }));

    const { addLeadAction } = await import("@/app/actions/crm");
    const payload = {
      name: "Retry customer",
      company: "",
      phone: "9876543210",
      area: "",
      source: "Meta Ads",
      remarks: "",
      idempotencyKey: "a0d4c362-4e16-46e5-ae2d-a904a1670d43",
    };
    const first = await addLeadAction(payload);
    const retry = await addLeadAction(payload);

    expect(first).toEqual(retry);
    expect(createLead).toHaveBeenCalledTimes(1);
  });

  it("uses the duplicate-customer path for a different key with the same phone", async () => {
    class MockZohoError extends Error {
      readonly code = "DUPLICATE_LEAD";
      readonly status = 409;
      readonly field = undefined;
      readonly details = undefined;
      readonly operation = undefined;
      readonly reference = undefined;
    }
    const created = {
      id: "lead-first",
      name: "First customer",
      company: "First customer",
      phone: "9876543210",
      area: "",
      source: "Meta Ads",
      status: "Fresh Lead",
      assignedTo: null,
      remarks: "",
      createdOn: "2026-11-06",
      address: "",
      touchedBy: ["Manager"],
    };
    const createLead = vi.fn()
      .mockResolvedValueOnce(created)
      .mockRejectedValueOnce(new MockZohoError("Duplicate lead"));
    const findLeadByPhone = vi.fn(async () => ({
      lead: { ...created, assignedTo: null },
      matchedField: "Mobile" as const,
    }));
    vi.doMock("next/cache", () => ({
      revalidateTag: vi.fn(),
      revalidatePath: vi.fn(),
      unstable_cache: (load: () => unknown) => load,
    }));
    vi.doMock("@/lib/auth/guard", () => ({
      ForbiddenError: class extends Error {},
      requireActionUser: vi.fn(async () => ({ id: "manager-1", name: "Manager", role: "Manager" })),
    }));
    vi.doMock("@/lib/crm", () => ({ crm: () => ({ createLead, findLeadByPhone }) }));
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: MockZohoError,
      hosts: () => ({ api: "https://www.zohoapis.in" }),
      zoho: vi.fn(),
      zohoList: vi.fn(),
      zohoWrite: vi.fn(),
    }));

    const { addLeadAction } = await import("@/app/actions/crm");
    const basePayload = {
      name: "First customer",
      company: "",
      phone: "9876543210",
      area: "",
      source: "Meta Ads",
      remarks: "",
    };
    const first = await addLeadAction({ ...basePayload, idempotencyKey: "a0d4c362-4e16-46e5-ae2d-a904a1670d44" });
    const second = await addLeadAction({ ...basePayload, idempotencyKey: "a0d4c362-4e16-46e5-ae2d-a904a1670d45" });

    expect(first).toMatchObject({ ok: true, data: { id: "lead-first" } });
    expect(second).toMatchObject({ ok: false, duplicate: { id: "lead-first" } });
    expect(createLead).toHaveBeenCalledTimes(2);
    expect(findLeadByPhone).toHaveBeenCalledWith("9876543210");
  });

  it("shows a safe non-production reason for plain server errors", async () => {
    vi.doMock("next/cache", () => ({
      revalidateTag: vi.fn(),
      revalidatePath: vi.fn(),
      unstable_cache: (load: () => unknown) => load,
    }));
    vi.doMock("@/lib/auth/guard", () => ({
      ForbiddenError: class extends Error {},
      requireActionUser: vi.fn(async () => ({ id: "manager-1", name: "Manager", role: "Manager" })),
    }));
    vi.doMock("@/lib/crm", () => ({
      crm: () => ({ createLead: async () => { throw new TypeError("fetch failed with access_token=private-value"); } }),
    }));

    const { addLeadAction } = await import("@/app/actions/crm");
    const result = await addLeadAction({
      name: "Plain error case",
      company: "",
      phone: "9876543210",
      area: "",
      source: "Direct Call",
      remarks: "",
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toContain("Unable to complete this request");
      expect(result.error).not.toContain("TypeError:");
      expect(result.error).not.toContain("access_token");
      expect(result.error).not.toContain("private-value");
      expect(result.error).not.toContain("request failed before a CRM response");
    }
  });
});
