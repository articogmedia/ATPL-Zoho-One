import { beforeEach, describe, expect, it, vi } from "vitest";

const assignmentAfterTasks = vi.hoisted(() => [] as (() => Promise<void> | void)[]);

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (load: () => unknown) => load,
}));
vi.mock("next/server", () => ({
  after: (task: () => Promise<void> | void) => { assignmentAfterTasks.push(task); },
}));

beforeEach(async () => {
  const { resetMemoryCache } = await import("@/lib/cache");
  resetMemoryCache();
  process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";
  process.env.ZOHO_DC = "in";
  process.env.DATA_SOURCE = "mock";
  delete process.env.ZOHO_API_BASE_URL;
  delete process.env.ZOHO_API_DOMAIN;
  delete process.env.ZOHO_ACCOUNTS_URL;
  delete process.env.ZOHO_SANDBOX;
  delete process.env.ZOHO_QUEUE_OWNER_ID;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  assignmentAfterTasks.length = 0;
  vi.doUnmock("@/lib/zoho/client");
  vi.resetModules();
});

const leadRequiredFields = ["Last_Name", "Company", "Mobile", "Lead_Status"];
const leadSourceSettings = {
  fields: [
    ...leadRequiredFields.map((api_name) => ({ api_name })),
    { api_name: "City", field_label: "City" },
    {
      api_name: "Lead_Source",
      pick_list_values: ["Meta Ads", "Google Ads", "Direct Call", "Other"].map((actual_value) => ({ actual_value })),
    },
  ],
};

describe("Zoho products catalogue", () => {
  it("retries invalid fields and filters inactive or unnamed products", async () => {
    class MockZohoError extends Error {
      constructor(message: string, readonly status?: number, readonly code?: string, readonly field?: string) {
        super(message);
      }
    }
    const list = vi.fn(async (_module: string, fields: string[], _max?: number, _extra?: Record<string, string>) => {
      void _max;
      void _extra;
      if (fields.includes("Usage_Unit")) throw new MockZohoError("Invalid field", 400, "INVALID_DATA", "Usage_Unit");
      if (fields.length > 2) throw new MockZohoError("Invalid field", 400, "INVALID_DATA", "Product_Code");
      return [
        { id: "p2", Product_Name: "Split AC", Unit_Price: 5000, Product_Active: true },
        { id: "p1", Product_Name: "Cassette AC", Unit_Price: 7000, Product_Active: true },
        { id: "p3", Product_Name: "Inactive", Unit_Price: 1000, Product_Active: false },
        { id: "p4", Product_Name: "", Unit_Price: 1000, Product_Active: true },
      ];
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: MockZohoError,
      zoho: vi.fn(async (_method: string, path: string) => path === "/settings/fields"
        ? leadSourceSettings
        : path === "/Leads/lead-1"
          ? { data: [{ id: "lead-1", Last_Name: "Old Lead", Company: "Old Co", Mobile: "8888888888", Lead_Source: "Direct Call", Lead_Status: "Fresh Lead", Owner: { id: "queue-1", name: "Queue" } }] }
          : ({ data: [] })),
      zohoList: list,
      zohoWrite: vi.fn(),
    }));
    const { invalidate } = await import("@/lib/cache");
    invalidate("products");
    const { zohoRepository } = await import("@/lib/zoho/repository");

    const products = await zohoRepository.listProducts();

    expect(products.map((product) => product.model)).toEqual(["Cassette AC", "Split AC"]);
    expect(list.mock.calls.map((call) => call[1])).toEqual([
      ["Product_Name", "Product_Code", "Unit_Price", "Product_Active", "Usage_Unit"],
      ["Product_Name", "Unit_Price", "Product_Code", "Product_Active"],
      ["Product_Name", "Unit_Price"],
    ]);
    for (const call of list.mock.calls) {
      expect(call[3]).toEqual({ sort_by: "id", sort_order: "asc" });
    }

    const callsBeforeRefresh = list.mock.calls.length;
    invalidate("products");
    await zohoRepository.listProducts();
    expect(list.mock.calls).toHaveLength(callsBeforeRefresh + 1);
    expect(list.mock.calls.at(-1)?.[1]).toEqual(["Product_Name", "Unit_Price"]);
  });

  it("does not try alternate product fields after a transport timeout", async () => {
    class MockZohoError extends Error {
      constructor(message: string, readonly status?: number, readonly code?: string) {
        super(message);
      }
    }
    const list = vi.fn(async () => {
      throw new MockZohoError("Zoho timed out, please try again", undefined, "NETWORK_TIMEOUT");
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: MockZohoError,
      zoho: vi.fn(async () => ({ data: [] })),
      zohoList: list,
      zohoWrite: vi.fn(),
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.listProducts()).rejects.toMatchObject({ code: "NETWORK_TIMEOUT" });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]).toEqual([
      "Products",
      ["Product_Name", "Product_Code", "Unit_Price", "Product_Active", "Usage_Unit"],
      1000,
      { sort_by: "id", sort_order: "asc" },
    ]);
  });
});

describe("Zoho lead actions", () => {
  it("does not retry Tasks with standard fields after an authentication error", async () => {
    class MockZohoError extends Error {
      constructor(message: string, readonly status: number, readonly code: string) {
        super(message);
      }
    }
    const list = vi.fn(async (module: string, _fields: string[]) => {
      if (module === "Tasks") throw new MockZohoError("Zoho connection problem: token refresh blocked", 400, "TOKEN_REFRESH_RATE_LIMITED");
      return [];
    });
    const taskFields = [
      "Subject", "Status", "Due_Date", "Owner", "What_Id",
      "Is_Site_Visit", "Visit_Time", "Next_Action", "Follow_Up_Date", "Task_Type",
    ];
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: MockZohoError,
      zoho: vi.fn(async (_method: string, path: string) => path === "/settings/fields"
        ? { fields: taskFields.map((api_name) => ({ api_name })) }
        : { data: [] }),
      zohoList: list,
      zohoWrite: vi.fn(),
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.listVisits()).rejects.toMatchObject({
      code: "TOKEN_REFRESH_RATE_LIMITED",
    });
    const taskCalls = list.mock.calls.filter(([module]) => module === "Tasks");
    expect(taskCalls).toHaveLength(2);
    expect(taskCalls.every(([, fields]) => !(fields as string[]).includes("Description") && !(fields as string[]).includes("Who_Id"))).toBe(true);
  });

  it("does not request Tasks with fallback fields when field metadata fails authentication", async () => {
    class MockZohoError extends Error {
      constructor(message: string, readonly status: number, readonly code: string) {
        super(message);
      }
    }
    const list = vi.fn(async (_module: string, _fields: string[]) => []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: MockZohoError,
      zoho: vi.fn(async (_method: string, path: string) => {
        if (path === "/settings/fields") throw new MockZohoError("Zoho connection problem: token refresh blocked", 400, "TOKEN_REFRESH_RATE_LIMITED");
        return { users: [] };
      }),
      zohoList: list,
      zohoWrite: vi.fn(),
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await zohoRepository.listLeads();

    expect(list.mock.calls.some(([module]) => module === "Tasks")).toBe(false);
  });

  it("matches +91, spaced, and leading-zero phone formats by phone field", async () => {
    vi.doMock("@/lib/zoho/client", () => ({
      ZOHO_CRM_API_VERSION: "v6",
      ZohoError: class extends Error {},
      zoho: vi.fn(async (_method: string, path: string) => path === "/settings/fields"
        ? leadSourceSettings
        : path === "/Leads/lead-1"
          ? { data: [{ id: "lead-1", Last_Name: "Old Lead", Company: "Old Co", Mobile: "8888888888", Lead_Source: "Direct Call", Lead_Status: "Fresh Lead", Owner: { id: "queue-1", name: "Queue" } }] }
          : ({ data: [] })),
      zohoList: vi.fn(async () => []),
      zohoWrite: vi.fn(),
    }));
    const { leadPhoneMatch } = await import("@/lib/zoho/repository");

    expect(leadPhoneMatch({ Mobile: "+91 98765 43210" } as never, "9876543210")).toBe("Mobile");
    expect(leadPhoneMatch({ Phone: "98765 43210" } as never, "9876543210")).toBe("Phone");
    expect(leadPhoneMatch({ Mobile: "09876543210" } as never, "9876543210")).toBe("Mobile");
  });

  it("rejects unrelated search results, accepts Phone matches, and handles no content", async () => {
    let searchRecords: unknown[] = [{ id: "wrong", Last_Name: "Wrong", Mobile: "9123456780", Lead_Status: "Fresh Lead" }];
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/Leads/search") return { data: searchRecords };
      if (path === "/users") return { users: [] };
      return {};
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZOHO_CRM_API_VERSION: "v6",
      ZohoError: class extends Error {},
      zoho,
      zohoList: vi.fn(async () => []),
      zohoWrite: vi.fn(),
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.findLeadByPhone("9491609192")).resolves.toBeNull();

    searchRecords = [{ id: "phone-match", Last_Name: "Phone Match", Phone: "+91 94916 09192", Lead_Status: "Fresh Lead" }];
    await expect(zohoRepository.findLeadByPhone("9491609192")).resolves.toMatchObject({ matchedField: "Phone", lead: { id: "phone-match" } });

    searchRecords = [];
    await expect(zohoRepository.findLeadByPhone("9491609192")).resolves.toBeNull();
  });

  it("propagates phone-search failures instead of treating them as no duplicate", async () => {
    class MockZohoError extends Error {
      constructor(message: string, readonly status: number) {
        super(message);
      }
    }
    const zoho = vi.fn(async () => {
      throw new MockZohoError("Zoho search unavailable", 401);
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: MockZohoError,
      zoho,
      zohoList: vi.fn(async () => []),
      zohoWrite: vi.fn(),
    }));
    const { invalidate } = await import("@/lib/cache");
    invalidate("leads", "users");
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.findLeadByPhone("9491609192")).rejects.toThrow("Zoho search unavailable");
    expect(zoho).toHaveBeenCalledOnce();
  });

  it("updates editable lead fields", async () => {
    const write = vi.fn(async (_method: string, path: string, record: Record<string, unknown>) => {
      if (path === "/Leads/lead-1") expect(record).toMatchObject({
        Last_Name: "Updated Lead", Company: "Updated Co", Mobile: "9999999999", Lead_Source: "Google Ads",
      });

      return "ok";
    });

    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      zoho: vi.fn(async (_method: string, path: string) => path === "/settings/fields"
        ? leadSourceSettings
        : path === "/Leads/lead-1"
          ? { data: [{ id: "lead-1", Last_Name: "Old Lead", Company: "Old Co", Mobile: "8888888888", Lead_Source: "Direct Call", Lead_Status: "Fresh Lead", Owner: { id: "queue-1", name: "Queue" } }] }
          : ({ data: [] })),
      zohoList: vi.fn(async () => [{ id: "lead-1", Last_Name: "Old Lead", Company: "Old Co", Mobile: "8888888888", Lead_Source: "Direct Call", Lead_Status: "Fresh Lead", Owner: { id: "queue-1", name: "Queue" } }]),
      zohoWrite: write,
    }));
    const { invalidate } = await import("@/lib/cache");
    invalidate("leads", "users");
    const { zohoRepository } = await import("@/lib/zoho/repository");
    await zohoRepository.updateLead("lead-1", {
      name: "Updated Lead", company: "Updated Co", phone: "9999999999", source: "Google Ads",
    }, { id: "manager-1", name: "Manager", role: "Manager" });
    expect(write).toHaveBeenCalledWith("PUT", "/Leads/lead-1", expect.objectContaining({
      Last_Name: "Updated Lead", Company: "Updated Co", Mobile: "9999999999", Lead_Source: "Google Ads",
    }), { trigger: ["workflow"] });
  });

  it("assigns a lead, advances Fresh Lead, notes it, and creates a call task", async () => {
    const writes: { method: string; path: string; record: Record<string, unknown> }[] = [];
    let leadReads = 0;
    const write = vi.fn(async (method: string, path: string, record: Record<string, unknown>) => {
      writes.push({ method, path, record });
      return path === "/Leads/lead-1" ? "ok" : "created";
    });

    vi.doMock("@/lib/zoho/client", () => ({
      ZOHO_CRM_API_VERSION: "v6",
      ZohoError: class extends Error {},
      zoho: vi.fn(async (_method: string, path: string) => path === "/Leads/lead-1"
        ? { data: [{ id: "lead-1", Last_Name: "Lead", Lead_Status: leadReads++ === 0 ? "Fresh Lead" : "Assigned to Sales", Owner: leadReads === 1 ? { id: "queue-1", name: "Queue" } : { id: "1394515000001147001", name: "Pavan" } }] }
        : path === "/Tasks" ? { data: [] }
        : { users: [{ id: "1394515000001147001", full_name: "Pavan", role: { name: "Sales Executive" } }] }),
      zohoList: vi.fn(async (module: string) => module === "Leads"
        ? [{ id: "lead-1", Last_Name: "Lead", Lead_Status: "Fresh Lead", Owner: { id: "queue-1", name: "Queue" } }]
        : []),
      zohoWrite: write,
    }));
    const { invalidate } = await import("@/lib/cache");
    invalidate("users", "leads", "visits");
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await zohoRepository.assignLead("lead-1", "1394515000001147001", { id: "manager-1", name: "Reshma", role: "Manager" });
    await assignmentAfterTasks.shift()?.();

    expect(writes[0]).toMatchObject({
      method: "PUT", path: "/Leads/lead-1",
      record: { Owner: { id: "1394515000001147001" }, Lead_Status: "Assigned to Sales" },
    });
    const task = writes.find((entry) => entry.path === "/Tasks");
    expect(task).toMatchObject({
      method: "POST", path: "/Tasks",
      record: { Subject: "Call new lead", Due_Date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), Owner: { id: "1394515000001147001" } },
    });
    const note = writes.find((entry) => entry.path === "/Notes");
    expect(note).toMatchObject({ method: "POST", record: { Note_Title: "Lead assigned" } });
    expect(note?.record.Note_Content).toMatch(/Assigned to Pavan by Reshma on \d{4}-\d{2}-\d{2}/);
    const { cached } = await import("@/lib/cache");
    await expect(cached("visits", 60_000, async () => [])).resolves.toEqual([
      expect.objectContaining({ id: "created", leadId: "lead-1", executiveId: "1394515000001147001" }),
    ]);
  });

  it("does not move a progressed lead backwards during assignment", async () => {
    const writes: Record<string, unknown>[] = [];
    let leadReads = 0;
    const write = vi.fn(async (method: string, path: string, record: Record<string, unknown>) => {
      writes.push({ method, path, record });
      return "ok";
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      zoho: vi.fn(async (_method: string, path: string) => path === "/Leads/lead-2"
        ? { data: [{ id: "lead-2", Last_Name: "Lead", Lead_Status: "Contacted", Owner: { id: leadReads++ === 0 ? "queue-1" : "1394515000001147001", name: "Pavan" } }] }
        : path === "/Tasks" ? { data: [] }
        : { users: [{ id: "1394515000001147001", full_name: "Pavan", role: { name: "Sales Executive" } }] }),
      zohoList: vi.fn(async (module: string) => module === "Leads"
        ? [{ id: "lead-2", Last_Name: "Lead", Lead_Status: "Contacted", Owner: { id: "queue-1", name: "Queue" } }]
        : []),
      zohoWrite: write,
    }));
    const { invalidate } = await import("@/lib/cache");
    invalidate("users", "leads", "visits");
    const { zohoRepository } = await import("@/lib/zoho/repository");
    await zohoRepository.assignLead("lead-2", "1394515000001147001", { id: "manager-1", name: "Reshma", role: "Manager" });
    await assignmentAfterTasks.shift()?.();
    expect(writes[0]?.record).toEqual({ Owner: { id: "1394515000001147001" } });
  });

  it("keeps assignment successful when background follow-up task creation fails", async () => {
    const write = vi.fn(async (_method: string, path: string) => {
      if (path === "/Tasks") throw new Error("invalid data");
      return "ok";
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      zoho: vi.fn(async (_method: string, path: string) => path === "/Leads/lead-partial"
        ? { data: [{ id: "lead-partial", Last_Name: "Partial", Lead_Status: "Assigned to Sales", Owner: { id: "exec-1", name: "Pavan" } }] }
        : path === "/Tasks" ? { data: [] }
        : { users: [{ id: "exec-1", full_name: "Pavan", role: { name: "Sales Executive" } }] }),
      zohoList: vi.fn(async () => [{ id: "lead-partial", Last_Name: "Partial", Lead_Status: "Fresh Lead", Owner: { id: "queue-1" } }]),
      zohoWrite: write,
    }));
    const { invalidate } = await import("@/lib/cache");
    invalidate("leads", "users");
    const { zohoRepository } = await import("@/lib/zoho/repository");
    const result = await zohoRepository.assignLead("lead-partial", "exec-1", { id: "manager-1", name: "Reshma", role: "Manager" });
    await assignmentAfterTasks.shift()?.();
    expect(result.owner).toBe("Pavan");
    const { cached } = await import("@/lib/cache");
    await expect(cached(`assignment-warnings:${result.warningCheckId}`, 60_000, async () => null))
      .resolves.toMatchObject({ taskWarning: "Follow-up task creation failed." });
  });

  it("does not create a duplicate assignment task", async () => {
    const write = vi.fn(async (...args: unknown[]) => { void args.length; return "ok"; });
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      zoho: vi.fn(async (_method: string, path: string) => path === "/Leads/lead-dup"
        ? { data: [{ id: "lead-dup", Last_Name: "Duplicate", Lead_Status: "Assigned to Sales", Owner: { id: "exec-1", name: "Pavan" } }] }
        : path === "/Tasks" ? { data: [{ Subject: "Call new lead", Owner: { id: "exec-1" }, What_Id: { id: "lead-dup" } }] }
        : { users: [{ id: "exec-1", full_name: "Pavan", role: { name: "Sales Executive" } }] }),
      zohoList: vi.fn(async () => [{ id: "lead-dup", Last_Name: "Duplicate", Lead_Status: "Assigned to Sales", Owner: { id: "exec-1" } }]),
      zohoWrite: write,
    }));
    const { invalidate } = await import("@/lib/cache");
    invalidate("leads", "users");
    const { zohoRepository } = await import("@/lib/zoho/repository");
    const result = await zohoRepository.assignLead("lead-dup", "exec-1", { id: "manager-1", name: "Reshma", role: "Manager" });
    await assignmentAfterTasks.shift()?.();
    expect(result.taskCreated).toBe(false);
    expect(write.mock.calls.some(([, path]) => path === "/Tasks")).toBe(false);
  });

  it("deletes a lead through the Zoho recycle-bin endpoint", async () => {
    const request = vi.fn(async (method: string, path: string, opts: { query?: Record<string, string> }) => {
      expect(method).toBe("DELETE");
      expect(path).toBe("/Leads");
      expect(opts.query).toEqual({ ids: "lead-1" });
      return { data: [{ code: "SUCCESS" }] };
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      zoho: request,
      zohoList: vi.fn(async () => []),
      zohoWrite: vi.fn(),
    }));
    const { invalidate } = await import("@/lib/cache");
    invalidate("leads", "users");
    const { zohoRepository } = await import("@/lib/zoho/repository");
    await zohoRepository.deleteLead("lead-1");
    expect(request).toHaveBeenCalledWith("DELETE", "/Leads", { query: { ids: "lead-1" } });
  });

  it("rejects reassign and delete actions for non-managers", async () => {
    const user = { id: "sales-1", name: "Sales", role: "Sales Executive" as const };
    vi.doMock("@/lib/auth/guard", () => ({
      ForbiddenError: class extends Error {},
      requireActionUser: vi.fn(async () => user),
    }));
    vi.doMock("@/lib/crm", () => ({ crm: vi.fn() }));
    const { reassignLeadAction, deleteLeadAction } = await import("@/app/actions/crm");
    await expect(reassignLeadAction({ id: "lead-1", assignedToId: "manager-1" })).resolves.toMatchObject({
      ok: false, error: "Only managers can reassign leads.",
    });
    await expect(deleteLeadAction({ id: "lead-1" })).resolves.toMatchObject({
      ok: false, error: "Only managers can delete leads.",
    });
  });
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

  it("uses explicit Zoho hosts only when they match the configured data centre", async () => {
    process.env.ZOHO_DC = "com";
    process.env.ZOHO_API_DOMAIN = "www.zohoapis.com";
    process.env.ZOHO_ACCOUNTS_URL = "https://accounts.zoho.com";
    const { hosts } = await import("@/lib/zoho/client");
    expect(hosts()).toMatchObject({
      accounts: "https://accounts.zoho.com",
      api: "https://www.zohoapis.com",
    });

    vi.resetModules();
    process.env.ZOHO_DC = "in";
    const { env } = await import("@/lib/env");
    expect(() => env()).toThrow("ZOHO_API_DOMAIN must use HTTPS and the in Zoho CRM data center");

    vi.resetModules();
    process.env.ZOHO_API_DOMAIN = "http://www.zohoapis.in";
    const insecureEnv = await import("@/lib/env");
    expect(() => insecureEnv.env()).toThrow("ZOHO_API_DOMAIN must use HTTPS");
  });
});

describe("Zoho lead owner fallbacks", () => {
  it("assigns an executive-created lead to that executive and marks it Assigned to Sales", async () => {
    const write = vi.fn(async (_method: string, path: string, record: Record<string, unknown>) => {
      if (path === "/Leads") {
        expect(record.Owner).toEqual({ id: "exec-1" });
        expect(record.Lead_Status).toBe("Assigned to Sales");
        expect(record.Lead_Source).toBe("Direct Call");
      }
      return "lead-exec";
    });

    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      zoho: vi.fn(async (_method: string, path: string) => path === "/Leads/lead-exec"
        ? { data: [{ id: "lead-exec", Full_Name: "Executive lead", Mobile: "9999999998", Lead_Source: "Direct Call", Lead_Status: "Assigned to Sales", Owner: { id: "exec-1", name: "Executive" } }] }
        : path === "/settings/fields" ? leadSourceSettings
        : { users: [{ id: "exec-1", full_name: "Executive", role: { name: "Sales Executive" } }] }),
      zohoList: vi.fn(async () => []),
      zohoWrite: write,
    }));
    const { invalidate } = await import("@/lib/cache");
    invalidate("users", "leads");
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await zohoRepository.createLead(
      { name: "Executive lead", company: "", phone: "9999999998", area: "", source: "Direct Call", remarks: "" },
      { id: "exec-1", name: "Executive", role: "Sales Executive" },
      "exec-1",
    );

    expect(write).toHaveBeenCalledWith("POST", "/Leads", expect.objectContaining({
      Owner: { id: "exec-1" },
      Lead_Status: "Assigned to Sales",
      Lead_Source: "Direct Call",
    }), { trigger: ["workflow"] });
  });

    it("uses an explicitly assigned executive as owner", async () => {
      const write = vi.fn(async (_method: string, path: string, record: Record<string, unknown>) => {
        if (path === "/Leads") {
          expect(record.Owner).toEqual({ id: "exec-1" });
          expect(record.Lead_Status).toBe("Assigned to Sales");
        }
        return "lead-1";
      });

      vi.doMock("@/lib/zoho/client", () => ({
        ZOHO_CRM_API_VERSION: "v6",
        ZohoError: class extends Error {},
        zoho: vi.fn(async (_method: string, path: string) => path === "/Leads/lead-1"
          ? { data: [{ id: "lead-1", Full_Name: "New lead", Mobile: "9999999999", Lead_Source: "Direct Call", Lead_Status: "Assigned to Sales", Owner: { id: "exec-1", name: "Executive" } }] }
          : path === "/settings/fields" ? leadSourceSettings
          : { users: [{ id: "exec-1", full_name: "Executive", role: { name: "Sales Executive" } }] }),
        zohoList: vi.fn(async () => []),
        zohoWrite: write,
      }));
      const { invalidate } = await import("@/lib/cache");
      invalidate("users", "leads");
      const { zohoRepository } = await import("@/lib/zoho/repository");

      await zohoRepository.createLead(
        { name: "New lead", company: "", phone: "9999999999", area: "", source: "Direct Call", remarks: "" },
        { id: "actor-1", name: "Manager", role: "Manager" },
        "exec-1",
      );
      await Promise.all(assignmentAfterTasks.splice(0).map((task) => Promise.resolve(task())));

      expect(write).toHaveBeenCalledWith("POST", "/Leads", expect.anything(), { trigger: ["workflow"] });
      expect(write).toHaveBeenCalledWith("POST", "/Notes", expect.objectContaining({ Note_Title: "Lead assigned" }));
      expect(write).toHaveBeenCalledWith("POST", "/Tasks", expect.objectContaining({ Subject: "Call new lead", Owner: { id: "exec-1" } }));
    });

    it("leaves a lead unassigned when no owner is selected", async () => {
      process.env.ZOHO_QUEUE_OWNER_ID = "queue-1";
      const write = vi.fn(async (_method: string, path: string, record: Record<string, unknown>) => {
        if (path === "/Leads") {
          expect(record).not.toHaveProperty("Owner");
          expect(record.Company).toBe("New lead");
          expect(record.Lead_Status).toBe("Fresh Lead");
        }
        return "lead-1";
      });
      vi.doMock("@/lib/zoho/client", () => ({
        ZohoError: class extends Error {},
        zoho: vi.fn(async (_method: string, path: string) => path === "/Leads/lead-1"
          ? { data: [{ id: "lead-1", Full_Name: "New lead", Mobile: "9999999999", Lead_Source: "Direct Call", Lead_Status: "Fresh Lead", Owner: { id: "queue-1", name: "Queue Owner" } }] }
          : path === "/settings/fields" ? leadSourceSettings
          : { users: [
              { id: "queue-1", full_name: "Queue Owner", role: { name: "Calling Team" } },
              { id: "exec-1", full_name: "Executive", role: { name: "Sales Executive" } },
            ] }),
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
      expect(write.mock.calls.some(([, path]) => path === "/Tasks")).toBe(false);
    });

    it("uses the active queue owner when un-assigning", async () => {
      process.env.ZOHO_QUEUE_OWNER_ID = "queue-1";
      const write = vi.fn(async (_method: string, path: string, record: Record<string, unknown>) => {
        if (path === "/Leads/lead-1") expect(record.Owner).toEqual({ id: "queue-1" });
        return "ok";
      });
      vi.doMock("@/lib/zoho/client", () => ({
        ZohoError: class extends Error {},
        zoho: vi.fn(async (_method: string, path: string) => path === "/Leads/lead-1"
          ? { data: [{ id: "lead-1", Last_Name: "Lead", Lead_Status: "Assigned to Sales", Owner: { id: "exec-1", name: "Executive" } }] }
          : ({ users: [
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

    it("does not require a queue owner to create an unassigned lead", async () => {
      const write = vi.fn(async () => "lead-1");
      vi.doMock("@/lib/zoho/client", () => ({
        ZohoError: class extends Error {},
        zoho: vi.fn(async (_method: string, path: string) => path === "/settings/fields" ? leadSourceSettings : ({ users: [] })),
        zohoList: vi.fn(async () => []),
        zohoWrite: write,
      }));
      const { invalidate } = await import("@/lib/cache");
      invalidate("users", "leads");
      const { zohoRepository } = await import("@/lib/zoho/repository");

      await expect(zohoRepository.createLead(
        { name: "New lead", company: "", phone: "9999999999", area: "", source: "Direct Call", remarks: "" },
        { id: "actor-1", name: "Manager", role: "Manager" },
        null,
      )).resolves.toMatchObject({ company: "New lead", assignedTo: null });
      expect(write).toHaveBeenCalledWith("POST", "/Leads", expect.not.objectContaining({ Owner: expect.anything() }), { trigger: ["workflow"] });
    });

    it("reuses Lead field metadata and returns the created lead without fetching it again", async () => {
      let nextId = 0;
      const zoho = vi.fn(async (_method: string, path: string) => {
        if (path === "/settings/fields") return leadSourceSettings;
        if (path === "/Leads/search") return { data: [] };
        return {};
      });
      const write = vi.fn(async (_method: string, path: string) => {
        if (path === "/Leads") return `lead-${++nextId}`;
        return "note-1";
      });
      vi.doMock("@/lib/zoho/client", () => ({
        ZohoError: class extends Error {},
        zoho,
        zohoList: vi.fn(async () => []),
        zohoWrite: write,
      }));
      const { zohoRepository } = await import("@/lib/zoho/repository");
      const actor = { id: "manager-1", name: "Manager", role: "Manager" as const };

      const first = await zohoRepository.createLead(
        { name: "First customer", company: "", phone: "9999999991", area: "", source: "Direct Call", remarks: "" },
        actor,
        null,
      );
      const second = await zohoRepository.createLead(
        { name: "Second customer", company: "", phone: "9999999992", area: "", source: "Direct Call", remarks: "" },
        actor,
        null,
      );

      expect(first).toMatchObject({ id: "lead-1", name: "First customer", company: "First customer", phone: "9999999991" });
      expect(second).toMatchObject({ id: "lead-2", name: "Second customer", company: "Second customer", phone: "9999999992" });
      expect(zoho.mock.calls.filter(([, path]) => path === "/settings/fields")).toHaveLength(1);
      expect(zoho.mock.calls.some(([, path]) => path === "/Leads/lead-1" || path === "/Leads/lead-2")).toBe(false);
    });

    it("exposes only configured Lead Sources and rejects an unconfigured source with setup guidance", async () => {
      const settings = {
        fields: [
          ...leadRequiredFields.map((api_name) => ({ api_name })),
          { api_name: "City", field_label: "City" },
          { api_name: "Lead_Source", pick_list_values: [{ actual_value: "Other" }] },
        ],
      };
      const write = vi.fn(async () => "lead-1");
      vi.doMock("@/lib/zoho/client", () => ({
        ZohoError: class extends Error {},
        zoho: vi.fn(async (_method: string, path: string) => path === "/settings/fields" ? settings : ({ data: [] })),
        zohoList: vi.fn(async () => []),
        zohoWrite: write,
      }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { invalidate } = await import("@/lib/cache");
      invalidate("users", "leads");
      const { zohoRepository } = await import("@/lib/zoho/repository");

      expect(await zohoRepository.listLeadSources()).toEqual(["Other"]);
      await expect(zohoRepository.createLead(
        { name: "Fallback source lead", company: "", phone: "+91 98765-43210", area: "Madhapur", source: "Meta Ads", remarks: "" },
        { id: "manager-1", name: "Manager", role: "Manager" },
        null,
      )).rejects.toThrow('Lead source "Meta Ads" is not set up in Zoho. Add it under Setup → Modules and Fields → Leads → Lead Source.');
      expect(write).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("[zoho] requested Lead_Source is not configured", expect.any(Object));
      warn.mockRestore();
    });
});

describe("Zoho write error handling", () => {
  it("uses a token another instance stored in Redis after an OAuth 429", async () => {
    configureZoho();
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    let tokenRequests = 0;
    let accessTokenReads = 0;
    let anotherInstanceRefreshed = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("/oauth/v2/token")) {
        tokenRequests += 1;
        anotherInstanceRefreshed = true;
        return new Response(JSON.stringify({ error: "too_many_requests" }), { status: 429 });
      }
      const command = JSON.parse(String(init?.body)) as string[];
      if (command[0] === "GET" && command[1]?.endsWith(":access-token")) {
        accessTokenReads += 1;
        const value = anotherInstanceRefreshed
          ? JSON.stringify({ value: "shared-from-peer", exp: Date.now() + 60_000 })
          : null;
        return new Response(JSON.stringify({ result: value }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: command[0] === "SET" ? "OK" : 1 }), { status: 200 });
    });
    try {
      const { warmZohoToken } = await import("@/lib/zoho/client");
      await expect(warmZohoToken()).resolves.toBeUndefined();
      expect(tokenRequests).toBe(1);
      expect(accessTokenReads).toBeGreaterThanOrEqual(4);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("retries an OAuth 429 once after a short jittered delay", async () => {
    configureZoho();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    let tokenRequests = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/oauth/v2/token")) {
        tokenRequests += 1;
        return tokenRequests === 1
          ? new Response(JSON.stringify({ error: "too_many_requests" }), { status: 429 })
          : new Response(JSON.stringify({ access_token: "retried-access", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    try {
      const { warmZohoToken } = await import("@/lib/zoho/client");
      const warming = warmZohoToken();
      await vi.waitFor(() => expect(tokenRequests).toBe(1));
      await vi.advanceTimersByTimeAsync(1_000);
      await warming;
      expect(tokenRequests).toBe(2);
    } finally {
      fetchMock.mockRestore();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
      const configureZoho = () => {
        Reflect.deleteProperty(globalThis, "__atplZohoToken");
        Reflect.deleteProperty(globalThis, "__atplZohoRefresh");
        Reflect.deleteProperty(globalThis, "__atplZohoRefreshBlocked");
        Reflect.deleteProperty(globalThis, "__atplZohoForcedRefresh");
        process.env.ZOHO_CLIENT_ID = "test-client";
        process.env.ZOHO_CLIENT_SECRET = "test-secret";
        process.env.ZOHO_REFRESH_TOKEN = "test-refresh-token";
        process.env.ZOHO_SANDBOX = "true";
        process.env.ZOHO_DC = "in";
      };

      it("reports HTTP-200 per-record failures with a ref and masked request payload", async () => {
        configureZoho();
        const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes("/oauth/v2/token")) {
            return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), { status: 200 });
          }
          return new Response(JSON.stringify({
            data: [{
              status: "error", code: "DUPLICATE_DATA", message: "duplicate data",
              details: { api_name: "Mobile", expected_data_type: "text" },
            }],
          }), { status: 200 });
        });
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
          const { zohoWrite } = await import("@/lib/zoho/client");
          await expect(zohoWrite("POST", "/Leads", {
            Last_Name: "Test lead", Mobile: "9876543210", Phone: "9876543210",
          }, { trigger: ["workflow"] })).rejects.toMatchObject({
            status: 200,
            code: "DUPLICATE_DATA",
            reference: expect.stringMatching(/^[A-F0-9]{12}$/),
          });

          const logCall = log.mock.calls.find(([message]) => message === "[zoho] write rejected");
          expect(logCall?.[1]).toMatchObject({
            status: 200,
            recordStatus: "error",
            code: "DUPLICATE_DATA",
            api_name: "Mobile",
            expected_data_type: "text",
            payload: {
              data: [{ Mobile: "******10", Phone: "******10", Last_Name: "Test lead" }],
              trigger: ["workflow"],
            },
          });
          expect(logCall?.[1]).toHaveProperty("reference");
        } finally {
          fetchMock.mockRestore();
          log.mockRestore();
        }
      });

      it("refreshes and retries once when Zoho returns INVALID_TOKEN in a 200 response", async () => {
        configureZoho();
        let apiRequests = 0;
        let tokenRequests = 0;
        const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes("/oauth/v2/token")) {
            tokenRequests += 1;
            return new Response(JSON.stringify({ access_token: `access-${tokenRequests}`, expires_in: 3600 }), { status: 200 });
          }
          apiRequests += 1;
          if (apiRequests === 1) {
            return new Response(JSON.stringify({ code: "INVALID_TOKEN", message: "Access token expired" }), { status: 200 });
          }
          return new Response(JSON.stringify({ data: [{ status: "success", code: "SUCCESS", details: { id: "lead-1" } }] }), { status: 200 });
        });
        try {
          const { zohoWrite } = await import("@/lib/zoho/client");
          await expect(zohoWrite("POST", "/Leads", { Last_Name: "Test lead" })).resolves.toBe("lead-1");
          expect(apiRequests).toBe(2);
          expect(tokenRequests).toBe(2);
        } finally {
          fetchMock.mockRestore();
        }
    });

    it("logs the full HTTP 401 response and masked payload before retrying", async () => {
      configureZoho();
      let apiRequests = 0;
      let tokenRequests = 0;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/oauth/v2/token")) {
          tokenRequests += 1;
          return new Response(JSON.stringify({ access_token: `access-${tokenRequests}`, expires_in: 3600 }), { status: 200 });
        }
        apiRequests += 1;
        if (apiRequests === 1) {
          return new Response(JSON.stringify({
            code: "INVALID_TOKEN",
            message: "Access token expired",
            details: { param_name: "Authorization", expected_data_type: "oauth-token" },
          }), { status: 401 });
        }
        return new Response(JSON.stringify({ data: [{ status: "success", code: "SUCCESS", details: { id: "lead-1" } }] }), { status: 200 });
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const { zohoWrite } = await import("@/lib/zoho/client");
        await expect(zohoWrite("POST", "/Leads", {
          Last_Name: "Test lead", Mobile: "9876543210",
        })).resolves.toBe("lead-1");
        expect(apiRequests).toBe(2);
        expect(tokenRequests).toBe(2);
        expect(log).toHaveBeenCalledWith("[zoho] token rejected; retrying request once", expect.objectContaining({
          status: 401,
          code: "INVALID_TOKEN",
          message: "Access token expired",
          param_name: "Authorization",
          expected_data_type: "oauth-token",
          rawResponseBody: expect.objectContaining({ code: "INVALID_TOKEN" }),
          payload: { data: [{ Last_Name: "Test lead", Mobile: "******10" }] },
        }));
      } finally {
        fetchMock.mockRestore();
        log.mockRestore();
      }
    });

    it("surfaces Zoho OAuth scope errors without retrying an unchanged refresh token", async () => {
      configureZoho();
      let apiRequests = 0;
      let tokenRequests = 0;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/oauth/v2/token")) {
          tokenRequests += 1;
          return new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), { status: 200 });
        }
        apiRequests += 1;
        return new Response(JSON.stringify({
          status: "error",
          code: "OAUTH_SCOPE_MISMATCH",
          message: "invalid oauth scope to access this URL",
          details: {},
        }), { status: 401 });
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const { zoho } = await import("@/lib/zoho/client");
        await expect(zoho("GET", "/settings/fields", { query: { module: "Leads" } })).rejects.toMatchObject({
          status: 401,
          code: "OAUTH_SCOPE_MISMATCH",
          operation: "GET /settings/fields?module=Leads",
          details: expect.objectContaining({
            rawResponseBody: expect.objectContaining({ code: "OAUTH_SCOPE_MISMATCH" }),
          }),
          reference: expect.stringMatching(/^[A-F0-9]{12}$/),
        });
        expect(apiRequests).toBe(1);
        expect(tokenRequests).toBe(1);
        expect(log).toHaveBeenCalledWith("[zoho] request rejected", expect.objectContaining({
          status: 401,
          code: "OAUTH_SCOPE_MISMATCH",
          message: "invalid oauth scope to access this URL",
          rawResponseBody: expect.objectContaining({ status: "error" }),
        }));
      } finally {
        fetchMock.mockRestore();
        log.mockRestore();
      }
    });

    it("caches the access token and refreshes five minutes before expiry", async () => {
      configureZoho();
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
      let tokenRequests = 0;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("/oauth/v2/token")) {
          tokenRequests += 1;
          return new Response(JSON.stringify({ access_token: `access-${tokenRequests}`, expires_in: 3600 }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });
      try {
        const { zoho } = await import("@/lib/zoho/client");
        await zoho("GET", "/Leads");
        await zoho("GET", "/Products");
        expect(tokenRequests).toBe(1);

        await vi.advanceTimersByTimeAsync(54 * 60_000 + 59_000);
        await zoho("GET", "/Tasks");
        expect(tokenRequests).toBe(1);

        await vi.advanceTimersByTimeAsync(1_000);
        await zoho("GET", "/Quotes");
        expect(tokenRequests).toBe(2);
      } finally {
        fetchMock.mockRestore();
        vi.useRealTimers();
      }
    });

    it("shares one in-flight refresh across parallel Zoho requests", async () => {
      configureZoho();
      let tokenRequests = 0;
      let releaseToken!: (response: Response) => void;
      const tokenResponse = new Promise<Response>((resolve) => { releaseToken = resolve; });
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("/oauth/v2/token")) {
          tokenRequests += 1;
          return tokenResponse;
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });
      try {
        const { zoho } = await import("@/lib/zoho/client");
        const requests = Promise.all([
          zoho("GET", "/Leads"),
          zoho("GET", "/Tasks"),
          zoho("GET", "/Products"),
        ]);
        await vi.waitFor(() => expect(tokenRequests).toBe(1));
        releaseToken(new Response(JSON.stringify({ access_token: "shared-access", expires_in: 3600 }), { status: 200 }));
        await requests;
        expect(tokenRequests).toBe(1);
      } finally {
        fetchMock.mockRestore();
      }
    });

    it.each([
      {
        error: "Access Denied: You have made too many requests continuously",
        delay: 30_000,
        code: "TOKEN_REFRESH_RATE_LIMITED",
      },
      {
        error: "invalid_client",
        delay: 60_000,
        code: "TOKEN_REFRESH_INVALID_CLIENT",
      },
    ])("backs off after OAuth refresh failure ($code)", async ({ error, delay, code }) => {
      configureZoho();
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
      let tokenRequests = 0;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("/oauth/v2/token")) {
          tokenRequests += 1;
          if (tokenRequests === 1) {
            const body = error === "invalid_client"
              ? { error, error_description: "Client authentication failed" }
              : { error };
            return new Response(JSON.stringify(body), { status: 400 });
          }
          return new Response(JSON.stringify({ access_token: "recovered-access", expires_in: 3600 }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const { warmZohoToken } = await import("@/lib/zoho/client");
        await expect(warmZohoToken()).rejects.toMatchObject({
          code,
          message: code === "TOKEN_REFRESH_RATE_LIMITED"
            ? expect.stringContaining("temporarily limiting token refresh")
            : expect.stringContaining("Zoho token is blocked, retry in"),
          reference: expect.stringMatching(/^[A-F0-9]{12}$/),
        });
        await expect(warmZohoToken()).rejects.toMatchObject({ code });
        expect(tokenRequests).toBe(1);

        await vi.advanceTimersByTimeAsync(delay);
        await warmZohoToken();
        expect(tokenRequests).toBe(2);
      } finally {
        fetchMock.mockRestore();
        log.mockRestore();
        vi.useRealTimers();
      }
    });

    it("accepts the same api_domain from a sandbox token without blocking CRM requests", async () => {
      configureZoho();
      let tokenRequests = 0;
      let crmRequests = 0;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("/oauth/v2/token")) {
          tokenRequests += 1;
          return new Response(JSON.stringify({
            access_token: `access-${tokenRequests}`,
            expires_in: 3600,
            api_domain: "https://www.zohoapis.in",
          }), { status: 200 });
        }
        crmRequests += 1;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });
      try {
        const { warmZohoToken, zoho } = await import("@/lib/zoho/client");
        await warmZohoToken();
        await zoho("GET", "/Leads");
        expect(tokenRequests).toBe(1);
        expect(crmRequests).toBe(1);
        expect(Reflect.get(globalThis, "__atplZohoRefreshBlocked")).toBeUndefined();
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("does not start token-refresh back-off after a timeout", async () => {
      configureZoho();
      let tokenRequests = 0;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("/oauth/v2/token")) {
          tokenRequests += 1;
          if (tokenRequests === 1) throw new Error("fetch failed: timeout");
          return new Response(JSON.stringify({ access_token: "recovered-access", expires_in: 3600 }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const { warmZohoToken } = await import("@/lib/zoho/client");
        await expect(warmZohoToken()).rejects.toMatchObject({ code: "TOKEN_REFRESH_NETWORK_ERROR" });
        expect(Reflect.get(globalThis, "__atplZohoRefreshBlocked")).toBeUndefined();
        await warmZohoToken();
        expect(tokenRequests).toBe(2);
      } finally {
        fetchMock.mockRestore();
        log.mockRestore();
      }
    });

    it("retries a transient write transport failure once without refreshing the token", async () => {
      configureZoho();
      let tokenRequests = 0;
      let writeRequests = 0;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("/oauth/v2/token")) {
          tokenRequests += 1;
          return new Response(JSON.stringify({ access_token: "write-access", expires_in: 3600 }), { status: 200 });
        }
        writeRequests += 1;
        if (writeRequests === 1) throw new Error("fetch failed: ECONNRESET");
        return new Response(JSON.stringify({ data: [{ status: "success", code: "SUCCESS", details: { id: "lead-created" } }] }), { status: 200 });
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const { zohoWrite } = await import("@/lib/zoho/client");
        await expect(zohoWrite("POST", "/Leads", { Last_Name: "Test", Mobile: "9876543210" })).resolves.toBe("lead-created");
        expect(writeRequests).toBe(2);
        expect(tokenRequests).toBe(1);
        expect(log.mock.calls[0]?.[1]).toMatchObject({
          environment: "sandbox",
          apiHost: "https://sandbox.zohoapis.in",
          retrying: true,
        });
      } finally {
        fetchMock.mockRestore();
        log.mockRestore();
      }
    });

    it("reuses a shared Upstash access token after the local instance cache is cleared", async () => {
      configureZoho();
      process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.test";
      process.env.UPSTASH_REDIS_REST_TOKEN = "test-upstash-token";
      const store = new Map<string, string>();
      let tokenRequests = 0;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes("/oauth/v2/token")) {
          tokenRequests += 1;
          return new Response(JSON.stringify({ access_token: "shared-instance-access", expires_in: 3600 }), { status: 200 });
        }
        const args = JSON.parse(String(init?.body)) as string[];
        const [command, key, value] = args;
        if (command === "GET") return new Response(JSON.stringify({ result: store.get(key!) ?? null }), { status: 200 });
        if (command === "SET") {
          if (args.includes("NX") && store.has(key!)) return new Response(JSON.stringify({ result: null }), { status: 200 });
          store.set(key!, value!);
          return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
        }
        if (command === "DEL") {
          store.delete(key!);
          return new Response(JSON.stringify({ result: 1 }), { status: 200 });
        }
        if (command === "EVAL") {
          if (store.get(args[3]!) === args[4]) store.delete(args[3]!);
          return new Response(JSON.stringify({ result: 1 }), { status: 200 });
        }
        throw new Error(`Unexpected Redis command ${command}`);
      });
      try {
        let { warmZohoToken } = await import("@/lib/zoho/client");
        await warmZohoToken();
        expect(tokenRequests).toBe(1);
        Reflect.deleteProperty(globalThis, "__atplZohoToken");
        vi.resetModules();
        ({ warmZohoToken } = await import("@/lib/zoho/client"));
        await warmZohoToken();
        expect(tokenRequests).toBe(1);
        expect([...store.values()].some((value) => value.includes("shared-instance-access"))).toBe(true);
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("retries a transient read-side 5xx once without refreshing the access token", async () => {
      configureZoho();
      let tokenRequests = 0;
      let apiRequests = 0;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("/oauth/v2/token")) {
          tokenRequests += 1;
          return new Response(JSON.stringify({ access_token: "read-retry-access", expires_in: 3600 }), { status: 200 });
        }
        apiRequests += 1;
        return apiRequests === 1
          ? new Response(JSON.stringify({ code: "INTERNAL_ERROR" }), { status: 503 })
          : new Response(JSON.stringify({ data: [] }), { status: 200 });
      });
      try {
        const { zoho } = await import("@/lib/zoho/client");
        await expect(zoho("GET", "/Leads")).resolves.toMatchObject({ data: [] });
        expect(apiRequests).toBe(2);
        expect(tokenRequests).toBe(1);
      } finally {
        fetchMock.mockRestore();
      }
    });
});
