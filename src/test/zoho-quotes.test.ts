import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapQuote, quoteLineItemsField } from "@/lib/zoho/mappers";

const cacheMode = vi.hoisted(() => ({ roundTrip: false }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (load: () => Promise<unknown>) => async () => {
    const value = await load();
    return cacheMode.roundTrip ? JSON.parse(JSON.stringify(value)) as unknown : value;
  },
}));

beforeEach(async () => {
  process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";
  process.env.DATA_SOURCE = "mock";
  cacheMode.roundTrip = false;
  const { resetMemoryCache } = await import("@/lib/cache");
  resetMemoryCache();
  vi.resetModules();
});

const userRecords = [{ id: "manager-1", full_name: "Manager", role: { name: "Manager" } }];
const leadRecord = {
  id: "lead-1", Last_Name: "Customer", Company: "Customer Co", Mobile: "9876543210",
  Lead_Status: "Fresh Lead", Lead_Source: "Direct Call", Owner: { id: "manager-1", name: "Manager" },
};
const quoteFields = {
  fields: [
    { api_name: "Subject", data_type: "text" },
    { api_name: "Quoted_Items", data_type: "subform", subform_fields: [
      { api_name: "Product_Name", data_type: "lookup" },
      { api_name: "Quantity", data_type: "integer" },
      { api_name: "List_Price", data_type: "currency" },
      { api_name: "Discount", data_type: "currency" },
      { api_name: "Total", data_type: "currency" },
      { api_name: "Net_Total", data_type: "currency" },
      { api_name: "Total_After_Discount", data_type: "currency" },
    ] },
    { api_name: "Offer_No" },
    { api_name: "Lead_Ref", data_type: "lookup", lookup: { module: { api_name: "Leads" } }, system_mandatory: true },
  ],
};

describe("Zoho quotation creation", () => {
  it("loads only the first quote page and does not request the complete leads list", async () => {
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return { fields: quoteFields.fields };
      if (path === "/settings/layouts") return { layouts: [] };
      if (path === "/Quotes") return {
        data: [{ id: "quote-first", Subject: "Offer 239/26-27 - AC", Lead_Ref: { id: "lead-1", name: "Customer Co" }, Grand_Total: 100 }],
        info: { more_records: true },
      };
      return {};
    });
    const list = vi.fn(async () => []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZOHO_CRM_API_VERSION: "v6",
      ZohoError: class extends Error {},
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: vi.fn(),
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.listQuotesPage(1)).resolves.toMatchObject({
      hasMore: true,
      quotes: [{ id: "quote-first", customer: "Customer Co", offerNo: "239/26-27" }],
    });
    expect(zoho).toHaveBeenCalledWith("GET", "/Quotes", expect.objectContaining({
      query: expect.objectContaining({ page: 1, per_page: 200 }),
    }));
    expect(zoho).not.toHaveBeenCalledWith("GET", "/Leads", expect.anything());
    expect(list).not.toHaveBeenCalled();
  });

  it("does not probe alternate quote fields after a transport timeout", async () => {
    class MockZohoError extends Error {
      constructor(message: string, readonly status?: number, readonly code?: string) {
        super(message);
      }
    }
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return { fields: quoteFields.fields };
      if (path === "/Quotes") throw new MockZohoError("Zoho timed out", undefined, "NETWORK_TIMEOUT");
      return {};
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: MockZohoError,
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: vi.fn(),
      zohoWrite: vi.fn(),
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.listQuotesPage(1)).rejects.toMatchObject({ code: "NETWORK_TIMEOUT" });
    expect(zoho.mock.calls.filter((call) => call[1] === "/Quotes")).toHaveLength(1);
  });

  it("uses Quoted_Items for the v6 field schema and reads saved Quoted_Items back", () => {
    expect(quoteLineItemsField(["Subject", "Quoted_Items", "Product_Details"])).toBe("Quoted_Items");
    expect(quoteLineItemsField(["Subject", "Product_Details"])).toBe("Product_Details");

    const mapped = mapQuote({
      id: "quote-1",
      Subject: "Offer 239/26-27 - AC",
      Quoted_Items: [{
        Product_Name: { id: "product-1", name: "Cassette AC" },
        Quantity: 2,
        List_Price: 122000,
        Discount: 4000,
        Total: 244000,
        Total_After_Discount: 240000,
        Net_Total: 240000,
      }],
    }, new Map(), undefined, ["Quoted_Items"]);

    expect(mapped.items).toEqual([{
      productId: "product-1",
      model: "Cassette AC",
      description: "",
      unit: "Nos",
      price: 122000,
      qty: 2,
      discount: 4000,
    }]);
  });

  it("requests and maps the schema-selected line-item field when loading a saved quote", async () => {
    const savedQuote = {
      id: "quote-read",
      Subject: "Offer 248/26-27 - Customer Co",
      Lead_Ref: { id: "lead-1" },
      Grand_Total: 122000,
      Quoted_Items: [{
        Product_Name: { id: "product-1", name: "Cassette AC" },
        Quantity: 1,
        List_Price: 122000,
        Discount: 0,
      }],
    };
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return { fields: quoteFields.fields };
      if (path === "/settings/layouts") return { layouts: [] };
      if (path === "/Quotes/quote-read") return { data: [savedQuote] };
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => {
      if (module === "Leads") return [leadRecord];
      if (module === "Products") return [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos" }];
      return [];
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZOHO_CRM_API_VERSION: "v6",
      ZohoError: class extends Error {},
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: vi.fn(),
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.getQuote("quote-read")).resolves.toMatchObject({
      id: "quote-read",
      leadId: "lead-1",
      items: [{ productId: "product-1", model: "Cassette AC", qty: 1, price: 122000 }],
    });
    expect(zoho).toHaveBeenCalledWith("GET", "/Quotes/quote-read", {
      query: { fields: expect.stringContaining("Quoted_Items") },
    });
  });

  it("writes the CRM Quoted_Items shape and keeps note failures from masking a saved quote", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
    const write = vi.fn(async (...args: unknown[]) => {
      if (args[1] === "/Notes") throw new Error("history note permission missing");
      return "quote-1";
    });
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return quoteFields;
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => {
      if (module === "Products") {
        return [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Product_Active: true }];
      }
      return [];
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZOHO_CRM_API_VERSION: "v6",
      ZohoError: class extends Error {},
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.createQuote({
      offerNo: "239/26-27",
      leadId: "lead-1",
      subject: "Cassette AC quotation",
      items: [{ productId: "product-1", qty: 2, discount: 4000 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" }, "Manager")).resolves.toMatchObject({
      id: "quote-1", offerNo: "239/26-27", leadId: "lead-1", customer: "Customer Co", total: 240000,
    });

    expect(write).toHaveBeenCalledWith("POST", "/Quotes", expect.objectContaining({
      Subject: "Offer 239/26-27 - Cassette AC quotation",
      Offer_No: "239/26-27",
      Lead_Ref: { id: "lead-1" },
      Quoted_Items: [{
        Product_Name: { id: "product-1" },
        Quantity: 2,
        List_Price: 122000,
        Discount: 4000,
        Total: 244000,
        Total_After_Discount: 240000,
        Net_Total: 240000,
      }],
      Sub_Total: 244000,
      Discount: 4000,
      Grand_Total: 240000,
    }));
    expect(infoLog).toHaveBeenCalledWith("[zoho] creating quote", expect.objectContaining({
      leadId: "lead-1",
      leadIdMatchesRequest: true,
      leadRefField: "Lead_Ref",
      leadRefValue: { id: "lead-1" },
      leadRefValueType: "object",
      fieldMetadata: expect.objectContaining({
        api_name: "Lead_Ref",
        data_type: "lookup",
        lookup_module_api_name: "Leads",
        system_mandatory: true,
      }),
      payloadKeys: expect.arrayContaining(["Lead_Ref", "Quoted_Items"]),
      requestBody: {
        data: [expect.objectContaining({
          Lead_Ref: { id: "lead-1" },
          Quoted_Items: [expect.objectContaining({ Product_Name: { id: "product-1" } })],
        })],
      },
    }));
    expect(errorLog).toHaveBeenCalledWith("[zoho] primary change succeeded but history note failed", expect.objectContaining({
      action: "create quote",
      quoteId: "quote-1",
      leadId: "lead-1",
      message: "history note permission missing",
    }));
    errorLog.mockRestore();
    infoLog.mockRestore();
  });

  it("writes the legacy Product_Details shape when that is the only line-item field in metadata", async () => {
    const write = vi.fn(async () => "quote-legacy");
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return {
        fields: quoteFields.fields.map((field) => field.api_name === "Quoted_Items"
          ? { api_name: "Product_Details", data_type: "subform" }
          : field),
      };
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => module === "Products"
      ? [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Product_Active: true }]
      : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await zohoRepository.createQuote({
      offerNo: "239/26-27",
      leadId: "lead-1",
      items: [{ productId: "product-1", qty: 1, discount: 0 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" }, "Manager");

    expect(write).toHaveBeenCalledWith("POST", "/Quotes", expect.objectContaining({
      Product_Details: [{
        product: { id: "product-1" },
        quantity: 1,
        list_price: 122000,
        Discount: 0,
        total: 122000,
        total_after_discount: 122000,
        net_total: 122000,
      }],
    }));
  });

  it("writes Lead_Ref as text when Quotes metadata declares a text field", async () => {
    const write = vi.fn(async () => "quote-2");
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") {
        return { fields: quoteFields.fields.map((field) => field.api_name === "Lead_Ref"
          ? { api_name: "Lead_Ref", data_type: "text", json_type: "string", max_length: 20, system_mandatory: true }
          : field) };
      }
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => module === "Products"
      ? [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Product_Active: true }]
      : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await zohoRepository.createQuote({
      offerNo: "240/26-27",
      leadId: "lead-1",
      items: [{ productId: "product-1", qty: 1, discount: 0 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" }, "Manager");

    expect(write).toHaveBeenCalledWith("POST", "/Quotes", expect.objectContaining({
      Lead_Ref: "lead-1",
    }));
  });

  it("omits an unusable lookup and keeps the lead ID in the subject", async () => {
    const write = vi.fn(async () => "should-not-save");
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") {
        return { fields: quoteFields.fields.map((field) => field.api_name === "Lead_Ref"
          ? { api_name: "Lead_Ref", data_type: "lookup", lookup: { module: { api_name: "Accounts" } } }
          : field) };
      }
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => module === "Products"
      ? [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Product_Active: true }]
      : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {
        constructor(message: string, readonly status?: number, readonly code?: string, readonly field?: string, readonly invalidValue?: unknown, readonly operation?: string, readonly details?: Record<string, unknown>) {
          super(message);
        }
      },
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.createQuote({
      offerNo: "245/26-27",
      leadId: "lead-1",
      items: [{ productId: "product-1", qty: 1, discount: 0 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" }, "Manager")).resolves.toMatchObject({
      leadId: "lead-1",
    });
    expect(write).toHaveBeenCalledWith("POST", "/Quotes", expect.objectContaining({
      Subject: expect.stringContaining("[Lead ID: lead-1]"),
    }));
    expect(write).not.toHaveBeenCalledWith("POST", "/Quotes", expect.objectContaining({ Lead_Ref: expect.anything() }));
  });

  it("creates the quote without guessing when Lead_Ref is missing from metadata", async () => {
    const write = vi.fn(async () => "quote-absent");
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return { fields: quoteFields.fields.filter((field) => field.api_name !== "Lead_Ref") };
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => module === "Products"
      ? [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Product_Active: true }]
      : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {
        constructor(message: string, readonly status?: number, readonly code?: string, readonly field?: string, readonly invalidValue?: unknown, readonly operation?: string, readonly details?: Record<string, unknown>) {
          super(message);
        }
      },
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.createQuote({
      offerNo: "243/26-27",
      leadId: "lead-1",
      items: [{ productId: "product-1", qty: 1, discount: 0 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" }, "Manager")).resolves.toMatchObject({
      leadId: "lead-1",
    });
    expect(write).toHaveBeenCalledWith("POST", "/Quotes", expect.objectContaining({
      Subject: expect.stringContaining("[Lead ID: lead-1]"),
    }));
    expect(write).not.toHaveBeenCalledWith("POST", "/Quotes", expect.objectContaining({ Lead_Ref: expect.anything() }));
  });

  it("reports all mandatory Quotes fields omitted by the payload together", async () => {
    const write = vi.fn(async () => "quote-3");
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") {
        return { fields: [
          ...quoteFields.fields,
          { api_name: "Account_Name", data_type: "lookup", system_mandatory: true },
          { api_name: "Contact_Name", data_type: "lookup", system_mandatory: true },
        ] };
      }
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => module === "Products"
      ? [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Product_Active: true }]
      : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.createQuote({
      offerNo: "241/26-27",
      leadId: "lead-1",
      items: [{ productId: "product-1", qty: 1, discount: 0 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" }, "Manager"))
      .rejects.toMatchObject({
        message: "Required fields missing: Account_Name, Contact_Name",
      });
    expect(write).not.toHaveBeenCalled();
  });

  it("includes the selected Quotes layout's required fields in mandatory validation", async () => {
    const write = vi.fn(async () => "should-not-save");
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return quoteFields;
      if (path === "/settings/layouts") return {
        layouts: [{
          id: "layout-1",
          name: "Standard",
          is_default: true,
          sections: [{ fields: [{ api_name: "Account_Name", required: true }] }],
        }],
      };
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });

    const list = vi.fn(async (module: string) => module === "Products"
      ? [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Product_Active: true }]
      : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {
        constructor(message: string, readonly status?: number, readonly code?: string, readonly field?: string, readonly invalidValue?: unknown, readonly operation?: string, readonly details?: Record<string, unknown>) {
          super(message);
        }
      },
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.createQuote({
      offerNo: "244/26-27",
      leadId: "lead-1",
      items: [{ productId: "product-1", qty: 1, discount: 0 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" }, "Manager")).rejects.toMatchObject({
      message: 'Required fields missing: Account_Name (required by Quotes layout "Standard")',
      details: { mandatoryLayout: "Standard", layoutRequiredMissing: ["Account_Name"] },
    });
    expect(write).not.toHaveBeenCalledWith("POST", "/Quotes", expect.anything());
  });

  it("treats a non-empty dynamically named line-item field as satisfying layout requirements", async () => {
    const write = vi.fn(async (_method: string, path: string) => path === "/Quotes" ? "quote-layout" : "note-1");
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return quoteFields;
      if (path === "/settings/layouts") return {
        layouts: [{
          id: "layout-1",
          name: "Standard",
          is_default: true,
          sections: [{ fields: [{ api_name: "Quoted_Items", required: true }] }],
        }],
      };
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => module === "Products"
      ? [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Product_Active: true }]
      : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.createQuote({
      offerNo: "246/26-27",
      leadId: "lead-1",
      items: [{ productId: "product-1", qty: 1, discount: 0 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" }, "Manager")).resolves.toMatchObject({
      id: "quote-layout",
    });
    expect(write).toHaveBeenCalledWith("POST", "/Quotes", expect.objectContaining({
      Quoted_Items: [expect.objectContaining({ Product_Name: { id: "product-1" } })],
    }));
    await expect(zohoRepository.createQuote({
      offerNo: "249/26-27",
      leadId: "lead-1",
      items: [],
    }, { id: "manager-1", name: "Manager", role: "Manager" }, "Manager")).rejects.toMatchObject({
      message: 'Required fields missing: Quoted_Items (required by Quotes layout "Standard")',
    });
  });

  it("fills known Standard layout defaults and reports unresolved required fields together", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.fn(async () => "quote-defaults");
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return {
        fields: [
          ...quoteFields.fields,
          { api_name: "Valid_Till", data_type: "date" },
          { api_name: "Quote_Stage", data_type: "picklist", pick_list_values: [{ actual_value: "Draft" }] },
          { api_name: "Account_Name", data_type: "lookup", system_mandatory: true },
          { api_name: "Contact_Name", data_type: "lookup", system_mandatory: true },
        ],
      };
      if (path === "/settings/layouts") return {
        layouts: [{
          id: "layout-1",
          name: "Standard",
          is_default: true,
          sections: [{ fields: [
            { api_name: "Valid_Till", required: true },
            { api_name: "Quote_Stage", required: true },
          ] }],
        }],
      };
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => module === "Products"
      ? [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Product_Active: true }]
      : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.createQuote({
      offerNo: "247/26-27",
      leadId: "lead-1",
      items: [{ productId: "product-1", qty: 1, discount: 0 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" }, "Manager")).rejects.toMatchObject({
      message: "Required fields missing: Account_Name, Contact_Name",
    });
    expect(errorLog).toHaveBeenCalledWith("[zoho] quote payload is missing mandatory module fields", expect.objectContaining({
      payloadFields: expect.arrayContaining(["Valid_Till", "Quote_Stage", "Quoted_Items"]),
      missingMandatory: ["Account_Name", "Contact_Name"],
    }));
    expect(write).not.toHaveBeenCalledWith("POST", "/Quotes", expect.anything());
    errorLog.mockRestore();
  });

  it("rebuilds quote schema collections after cache serialization and saves the quote", async () => {
    cacheMode.roundTrip = true;
    const write = vi.fn(async (_method: string, path: string) => path === "/Quotes" ? "quote-serialized" : "note-1");
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") {
        return { fields: [
          ...quoteFields.fields,
          { api_name: "Status" },
          { api_name: "Due_Date" },
          { api_name: "Owner" },
          { api_name: "What_Id" },
          { api_name: "Who_Id" },
          { api_name: "Description" },
          { api_name: "Created_Time" },
          { api_name: "Modified_Time" },
          { api_name: "Is_Site_Visit" },
          { api_name: "Visit_Time" },
          { api_name: "Next_Action" },
          { api_name: "Follow_Up_Date" },
          { api_name: "Task_Type" },
        ] };
      }
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => {
      if (module === "Leads") return [leadRecord];
      if (module === "Products") {
        return [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Product_Active: true }];
      }
      return [];
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {
        constructor(message: string, readonly status?: number, readonly code?: string, readonly field?: string, readonly invalidValue?: unknown, readonly operation?: string, readonly details?: Record<string, unknown>) {
          super(message);
        }
      },
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.createQuote({
      offerNo: "242/26-27",
      leadId: "lead-1",
      subject: "Cache round-trip offer",
      items: [{ productId: "product-1", qty: 1, discount: 2000 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" }, "Manager")).resolves.toMatchObject({
      id: "quote-serialized",
      offerNo: "242/26-27",
      leadId: "lead-1",
      customer: "Customer Co",
    });

    expect(write).toHaveBeenCalledWith("POST", "/Quotes", expect.objectContaining({
      Subject: "Offer 242/26-27 - Cache round-trip offer",
      Offer_No: "242/26-27",
      Lead_Ref: { id: "lead-1" },
      Quoted_Items: [{
        Product_Name: { id: "product-1" },
        Quantity: 1,
        List_Price: 122000,
        Discount: 2000,
        Total: 122000,
        Total_After_Discount: 120000,
        Net_Total: 120000,
      }],
    }));
  });
});
