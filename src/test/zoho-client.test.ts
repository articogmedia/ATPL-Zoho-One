import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (load: () => unknown) => load,
}));

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";
  process.env.ZOHO_DC = "in";
  process.env.DATA_SOURCE = "mock";
  delete process.env.ZOHO_API_BASE_URL;
  delete process.env.ZOHO_SANDBOX;
  delete process.env.ZOHO_QUEUE_OWNER_ID;
  vi.doUnmock("@/lib/zoho/client");
  vi.resetModules();
});

describe("Zoho hosts", () => {
  it("refuses production Zoho CRM outside production", async () => {
    process.env.DATA_SOURCE = "zoho";
    process.env.ZOHO_CLIENT_ID = "client";
    process.env.ZOHO_CLIENT_SECRET = "secret";
    process.env.ZOHO_REFRESH_TOKEN = "refresh";

    const { env } = await import("@/lib/env");

    expect(() => env()).toThrow(
      "Refusing to connect to production Zoho CRM in development. Set ZOHO_SANDBOX=true.",
    );
  });

  it("uses the sandbox API host while keeping the accounts host unchanged", async () => {
    process.env.ZOHO_SANDBOX = "true";
    const { hosts } = await import("@/lib/zoho/client");

    expect(hosts()).toEqual({
      accounts: "https://accounts.zoho.in",
      api: "https://sandbox.zohoapis.in",
    });
  });

  it("uses the production API host when sandbox mode is false or unset", async () => {
    for (const value of ["false", undefined]) {
      if (value === undefined) delete process.env.ZOHO_SANDBOX;
      else process.env.ZOHO_SANDBOX = value;

      vi.resetModules();
      const { hosts } = await import("@/lib/zoho/client");
      expect(hosts()).toEqual({
        accounts: "https://accounts.zoho.in",
        api: "https://www.zohoapis.in",
      });
    }
  });
});

describe("Zoho lead owner fallbacks", () => {
    it("uses an explicitly assigned executive as owner", async () => {
      const write = vi.fn(async (_method: string, path: string, record: Record<string, unknown>) => {
        if (path === "/Leads") expect(record.Owner).toEqual({ id: "exec-1" });
        return "lead-1";
      });
      vi.doMock("@/lib/zoho/client", () => ({
        ZohoError: class extends Error {},
        zoho: vi.fn(async () => ({ users: [{ id: "exec-1", full_name: "Executive", role: { name: "Sales Executive" } }] })),
        zohoList: vi.fn(async () => []),
        zohoWrite: write,
      }));
      const { invalidate } = await import("@/lib/cache");
      invalidate("users", "leads");
      const { zohoRepository } = await import("@/lib/zoho/repository");

      await zohoRepository.createLead(
        { name: "New lead", company: "", phone: "9999999999", area: "", source: "Direct Call", remarks: "" },
        { id: "actor-1", name: "Manager", role: "Manager" },
        "Executive",
      );

      expect(write).toHaveBeenCalledWith("POST", "/Leads", expect.anything(), { trigger: ["workflow"] });
    });

    it("uses the active queue owner when creating without an assignee", async () => {
      process.env.ZOHO_QUEUE_OWNER_ID = "queue-1";
      const write = vi.fn(async (_method: string, path: string, record: Record<string, unknown>) => {
        if (path === "/Leads") expect(record.Owner).toEqual({ id: "queue-1" });
        return "lead-1";
      });
      vi.doMock("@/lib/zoho/client", () => ({
        ZohoError: class extends Error {},
        zoho: vi.fn(async () => ({ users: [
          { id: "queue-1", full_name: "Queue Owner", role: { name: "Calling Team" } },
          { id: "exec-1", full_name: "Executive", role: { name: "Sales Executive" } },
        ] })),
        zohoList: vi.fn(async () => []),
        zohoWrite: write,
      }));
      const { invalidate } = await import("@/lib/cache");
      invalidate("users", "leads");
      const { zohoRepository } = await import("@/lib/zoho/repository");

      await zohoRepository.createLead(
        { name: "New lead", company: "", phone: "9999999999", area: "", source: "Direct Call", remarks: "" },
        { id: "actor-1", name: "Manager", role: "Manager" },
        null,
      );

      expect(write).toHaveBeenCalledWith("POST", "/Leads", expect.anything(), { trigger: ["workflow"] });
    });

    it("uses the active queue owner when un-assigning", async () => {
      process.env.ZOHO_QUEUE_OWNER_ID = "queue-1";
      const write = vi.fn(async (_method: string, path: string, record: Record<string, unknown>) => {
        if (path === "/Leads/lead-1") expect(record.Owner).toEqual({ id: "queue-1" });
        return "ok";
      });
      vi.doMock("@/lib/zoho/client", () => ({
        ZohoError: class extends Error {},
        zoho: vi.fn(async () => ({ users: [
          { id: "queue-1", full_name: "Queue Owner", role: { name: "Calling Team" } },
          { id: "exec-1", full_name: "Executive", role: { name: "Sales Executive" } },
        ] })),
        zohoList: vi.fn(async () => [{ id: "lead-1", Last_Name: "Lead", Owner: { id: "exec-1", name: "Executive" } }]),
        zohoWrite: write,
      }));
      const { invalidate } = await import("@/lib/cache");
      invalidate("users", "leads");
      const { zohoRepository } = await import("@/lib/zoho/repository");

      await zohoRepository.updateLead("lead-1", { assignedTo: null }, { id: "actor-1", name: "Manager", role: "Manager" });

      expect(write).toHaveBeenCalledWith("PUT", "/Leads/lead-1", { Owner: { id: "queue-1" } }, { trigger: ["workflow"] });
    });

    it("throws when the queue owner is missing or inactive", async () => {
      vi.doMock("@/lib/zoho/client", () => ({
        ZohoError: class extends Error {},
        zoho: vi.fn(async () => ({ users: [] })),
        zohoList: vi.fn(async () => []),
        zohoWrite: vi.fn(),
      }));
      const { invalidate } = await import("@/lib/cache");
      invalidate("users", "leads");
      const { zohoRepository } = await import("@/lib/zoho/repository");

      await expect(zohoRepository.createLead(
        { name: "New lead", company: "", phone: "9999999999", area: "", source: "Direct Call", remarks: "" },
        { id: "actor-1", name: "Manager", role: "Manager" },
        null,
      )).rejects.toThrow("Set ZOHO_QUEUE_OWNER_ID to an active Zoho user");
    });
});
