import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (load: () => unknown) => load,
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
  vi.doUnmock("@/lib/zoho/client");
  vi.resetModules();
});

const leadSourceSettings = {
  fields: [{
    api_name: "Lead_Source",
    pick_list_values: ["Meta Ads", "Google Ads", "Direct Call"].map((actual_value) => ({ actual_value })),
  }],
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
      if (fields.includes("Description")) throw new MockZohoError("Invalid field", 400, "INVALID_DATA", "Description");
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
      zoho: vi.fn(async (_method: string, path: string) => path === "/settings/fields" ? leadSourceSettings : ({ data: [] })),
      zohoList: list,
      zohoWrite: vi.fn(),
    }));
    const { invalidate } = await import("@/lib/cache");
    invalidate("products");
    const { zohoRepository } = await import("@/lib/zoho/repository");

    const products = await zohoRepository.listProducts();

    expect(products.map((product) => product.model)).toEqual(["Cassette AC", "Split AC"]);
    expect(list.mock.calls.map((call) => call[1])).toEqual([
      ["Product_Name", "Product_Code", "Description", "Unit_Price", "Usage_Unit", "Product_Active"],
      ["Product_Name", "Unit_Price", "Product_Code", "Product_Active"],
      ["Product_Name", "Unit_Price"],
    ]);
    for (const call of list.mock.calls) {
      expect(call[3]).toEqual({ sort_by: "id", sort_order: "asc" });
    }
  });
});

describe("Zoho lead actions", () => {
  it("matches +91, spaced, and leading-zero phone formats by phone field", async () => {
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      zoho: vi.fn(async (_method: string, path: string) => path === "/settings/fields" ? leadSourceSettings : ({ data: [] })),
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
      zoho: vi.fn(async (_method: string, path: string) => path === "/settings/fields" ? leadSourceSettings : ({ data: [] })),
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
    const write = vi.fn(async (method: string, path: string, record: Record<string, unknown>) => {
      writes.push({ method, path, record });
      return path === "/Leads/lead-1" ? "ok" : "created";
    });

    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      zoho: vi.fn(async (_method: string, path: string) => path === "/Leads/lead-1"
        ? { data: [{ id: "lead-1", Last_Name: "Lead", Lead_Status: "Assigned to Sales", Owner: { id: "1394515000001147001", name: "Pavan" } }] }
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

    await zohoRepository.assignLead("lead-1", "Pavan", { id: "manager-1", name: "Reshma", role: "Manager" });

    expect(writes[0]).toMatchObject({
      method: "PUT", path: "/Leads/lead-1",
      record: { Owner: { id: "1394515000001147001" }, Lead_Status: "Assigned to Sales" },
    });
    expect(writes[1]).toMatchObject({
      method: "POST", path: "/Tasks",
      record: { Subject: "Call new lead", Due_Date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), Owner: { id: "1394515000001147001" } },
    });
    expect(writes[2]).toMatchObject({ method: "POST", path: "/Notes", record: { Note_Title: "Lead assigned" } });
    expect(writes[2]?.record.Note_Content).toMatch(/Assigned to Pavan by Reshma on \d{4}-\d{2}-\d{2}/);
  });

  it("does not move a progressed lead backwards during assignment", async () => {
    const writes: Record<string, unknown>[] = [];
    const write = vi.fn(async (method: string, path: string, record: Record<string, unknown>) => {
      writes.push({ method, path, record });
      return "ok";
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      zoho: vi.fn(async (_method: string, path: string) => path === "/Leads/lead-2"
        ? { data: [{ id: "lead-2", Last_Name: "Lead", Lead_Status: "Contacted", Owner: { id: "1394515000001147001", name: "Pavan" } }] }
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
    await zohoRepository.assignLead("lead-2", "Pavan", { id: "manager-1", name: "Reshma", role: "Manager" });
    expect(writes[0]?.record).toEqual({ Owner: { id: "1394515000001147001" } });
  });

  it("reports partial assignment success when follow-up task creation fails", async () => {
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
    const result = await zohoRepository.assignLead("lead-partial", "Pavan", { id: "manager-1", name: "Reshma", role: "Manager" });
    expect(result.owner).toBe("Pavan");
    expect(result.taskWarning).toContain("Follow-up task creation failed");
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
    const result = await zohoRepository.assignLead("lead-dup", "Pavan", { id: "manager-1", name: "Reshma", role: "Manager" });
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
    await expect(reassignLeadAction({ id: "lead-1", assignedTo: "Manager" })).resolves.toMatchObject({
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
      "Other Executive",
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
        "Executive",
      );

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
});
