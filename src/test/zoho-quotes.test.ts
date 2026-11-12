import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapLead, mapProduct, mapQuote, quoteLineItemsField } from "@/lib/zoho/mappers";
import { canCreateQuotationPdf } from "@/lib/quotation-presentation";

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
    { api_name: "Quote_Stage", pick_list_values: [{ actual_value: "Draft" }, { actual_value: "Sent" }] },
    { api_name: "Quoted_Items", data_type: "subform", subform: { fields: [
      { api_name: "Product_Name", data_type: "lookup" },
      { api_name: "Quantity", data_type: "integer" },
      { api_name: "List_Price", data_type: "currency" },
      { api_name: "Discount", data_type: "currency" },
      { api_name: "Total", data_type: "currency" },
      { api_name: "Net_Total", data_type: "currency" },
      { api_name: "Total_After_Discount", data_type: "currency" },
      { api_name: "Description", data_type: "text" },
      { api_name: "Line_Tax", data_type: "tax" },
    ] } },
    { api_name: "Offer_No" },
    { api_name: "Lead_Ref", data_type: "lookup", lookup: { module: { api_name: "Leads" } }, system_mandatory: true },
    { api_name: "Description", data_type: "textarea" },
    { api_name: "Mobile", data_type: "phone" },
    { api_name: "Phone", data_type: "phone" },
    { api_name: "Customer_Name", data_type: "text" },
  ],
};

it("maps the standard Zoho lead email field", () => {
  const mapped = mapLead({
    id: "lead-email",
    First_Name: "Customer",
    Email: "customer@example.com",
    Lead_Source: "Direct Call",
    Lead_Status: "Fresh Lead",
  }, new Set());

  expect(mapped.email).toBe("customer@example.com");
});

describe("Zoho quotation creation", () => {
  it("writes formula-compatible Zoho totals for Part A, Part B, and mixed quotations", async () => {
    const payloads: Record<string, unknown>[] = [];
    let quoteId = 0;
    const write = vi.fn(async (_method: string, path: string, payload: Record<string, unknown>) => {
      if (path === "/Quotes") {
        payloads.push(payload);
        quoteId += 1;
        return `quote-${quoteId}`;
      }
      return "side-effect";
    });
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return quoteFields;
      if (path === "/settings/layouts") return { layouts: [] };
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      if (path === "/Quotes") return { data: [], info: { more_records: false } };
      return {};
    });
    const list = vi.fn(async (module: string) => module === "Products" ? [
      { id: "part-a", Product_Name: "Samsung 4 Way 3.0 TR", Unit_Price: 112240, Usage_Unit: "Nos", Tax: [{ percentage: 18, name: "GST 18% - configured" }, { percentage: 5, name: "GST 5% - configured" }], Product_Active: true },
      { id: "part-b", Product_Name: "B - Installation", Unit_Price: 1000, Usage_Unit: "Nos", Tax: [{ percentage: 18, name: "GST 18% - configured" }], Product_Active: true },
    ] : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZOHO_CRM_API_VERSION: "v6",
      ZohoError: class extends Error {},
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");
    const actor = { id: "manager-1", name: "Manager", role: "Manager" as const };
    const quotes = [
      { offerNo: "301/26-27", items: [{ productId: "part-a", qty: 1, discount: 2240 }], expected: 129800 },
      { offerNo: "302/26-27", items: [{ productId: "part-b", qty: 1, discount: 100 }], expected: 1062 },
      { offerNo: "303/26-27", items: [
        { productId: "part-a", qty: 1, discount: 2240 },
        { productId: "part-b", qty: 1, discount: 100 },
      ], expected: 130862 },
      {
        offerNo: "304/26-27",
        items: [{ productId: "part-a", qty: 1, discount: 0, taxRate: 0.05 }],
        extraCharges: [{ label: "Freight", amount: 100, taxRate: 0.12 }],
        expected: 117964,
      },
    ];

    for (const quote of quotes) {
      const saved = await zohoRepository.createQuote({
        offerNo: quote.offerNo,
        leadId: "lead-1",
        subject: "Mixed GST quotation",
        items: quote.items,
        extraCharges: quote.extraCharges,
      }, actor, "Manager");
      expect(saved.total).toBe(quote.expected);
    }

    expect(payloads).toHaveLength(4);
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index]!;
      const zohoTotal = Number(payload.Sub_Total) - Number(payload.Discount)
        + Number(payload.Tax) + Number(payload.Adjustment);
      expect(Math.round(zohoTotal * 100) / 100).toBe(quotes[index]!.expected);
      expect(payload).not.toHaveProperty("Grand_Total");
    }
    expect(payloads[0]).toMatchObject({ Sub_Total: 112240, Discount: 2240, Tax: 19800, Adjustment: 0 });
    expect(payloads[1]).toMatchObject({ Sub_Total: 1000, Discount: 100, Tax: 162, Adjustment: 0 });
    expect(payloads[2]).toMatchObject({ Sub_Total: 113240, Discount: 2340, Tax: 19962, Adjustment: 0 });
    expect(payloads[3]).toMatchObject({ Sub_Total: 112240, Discount: 0, Tax: 5624, Adjustment: 100 });
    expect(payloads[3]?.Quoted_Items).toMatchObject([{ Line_Tax: [{ percentage: 5, name: "GST 5% - configured" }] }]);
  });

  it("loads only the first quote page and does not request the complete leads list", async () => {
    const zoho = vi.fn(async (_method: string, path: string, options?: { query?: Record<string, unknown> }) => {
      if (path === "/settings/fields") return { fields: quoteFields.fields };
      if (path === "/settings/layouts") return { layouts: [] };
      if (path === "/Quotes") {
        const fields = String(options?.query?.fields);
        expect(fields).toContain("Quote_Stage");
        expect(fields).not.toContain("Status");
        return {
          data: [{ id: "quote-first", Subject: "Offer 239/26-27 - AC", Quote_Stage: "Accepted", Lead_Ref: { id: "lead-1", name: "Customer Co" }, Grand_Total: 100 }],
          info: { more_records: true },
        };
      }
      return {};
    });
    const list = vi.fn(async (module: string) => module === "Quotes" ? [] : []);
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
      query: expect.objectContaining({ page: 1, per_page: 200, fields: expect.stringContaining("Quote_Stage") }),
    }));
    expect(zoho).not.toHaveBeenCalledWith("GET", "/Leads", expect.anything());
    expect(list).not.toHaveBeenCalled();
  });

  it("does not scan and rewrite all quotes while displaying the saved-quote list", async () => {
    const records: Record<string, unknown>[] = [
      { id: "quote-newer", Subject: "Offer 247/26-27 - Newer quote", Offer_No: "247/26-27", Created_Time: "2026-10-02T00:00:00Z" },
      { id: "quote-older", Subject: "Offer 247/26-27 - Original quote", Offer_No: "247/26-27", Created_Time: "2026-10-01T00:00:00Z" },
    ];
    const write = vi.fn(async (_method: string, path: string, payload: Record<string, unknown>) => {
      const id = decodeURIComponent(path.split("/").pop() ?? "");
      const existing = records.find((record) => record.id === id);
      if (existing) Object.assign(existing, payload);
      return id;
    });
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return { fields: quoteFields.fields };
      if (path === "/settings/layouts") return { layouts: [] };
      if (path === "/Quotes") return { data: records, info: { more_records: false, count: records.length } };
      return {};
    });
    const list = vi.fn(async (module: string) => module === "Quotes" ? records as never[] : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZOHO_CRM_API_VERSION: "v6",
      ZohoError: class extends Error {},
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    const page = await zohoRepository.listQuotesPage(1);

    expect(write).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(page.quotes.map((quote) => quote.offerNo)).toEqual(["247/26-27", "247/26-27"]);
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
    const list = vi.fn(async (module: string) => {
      if (module === "Quotes") return await zoho("GET", "/Quotes") as never[];
      return [];
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: MockZohoError,
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
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
        Line_Tax: [{ percentage: 12, name: "GST 12%" }],
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
      taxRate: 0.12,
    }]);
  });

  it("maps Quote_Stage and treats a missing Quote_Stage as empty", () => {
    expect(mapQuote({ id: "quote-stage", Quote_Stage: "Accepted" }, new Map()).status).toBe("Accepted");
    expect(mapQuote({ id: "quote-stage-missing" }, new Map()).status).toBe("");
  });

  it("maps revision suffixes separately from the base offer number", () => {
    const mapped = mapQuote({
      id: "quote-revision",
      Subject: "Offer 236/26-27/R2 - Revised AC package",
      Description: JSON.stringify({ leadId: "lead-1", revision: 2 }),
    }, new Map());

    expect(mapped).toMatchObject({
      offerNo: "236/26-27",
      revision: 2,
      subject: "Offer 236/26-27/R2 - Revised AC package",
    });
  });

  it("maps a saved quote to its customer, phone, validity, and discounted items", () => {
    const mapped = mapQuote({
      id: "saved-quote",
      Subject: "Offer 249/26-27 - AC package",
      Lead_Ref: { id: "lead-1" },
      Account_Name: { id: "account-1", name: "Customer Co" },
      Mobile: "9876543210",
      Valid_Till: "2026-12-15",
      Grand_Total: 240000,
      Tax: "",
      Quoted_Items: [{
        Product_Name: { id: "product-1", name: "Cassette AC" },
        Quantity: 2,
        List_Price: 122000,
        Discount: 4000,
      }],
    }, new Map([["lead-1", {
      id: "lead-1",
      name: "Customer",
      company: "Customer Co",
      phone: "9876543210",
      area: "Hyderabad",
      address: "",
      source: "Direct Call",
      status: "Quotation Sent",
      assignedTo: "Manager",
      ownerId: "manager-1",
      remarks: "",
      createdOn: "2026-11-01",
      touchedBy: [],
    }]]), undefined, ["Quoted_Items"]);

    expect(mapped).toMatchObject({
      id: "saved-quote",
      offerNo: "249/26-27",
      leadId: "lead-1",
      customer: "Customer Co",
      contactName: "Customer",
      company: "Customer Co",
      phone: "9876543210",
      subject: "Offer 249/26-27 - AC package",
      validTill: "2026-12-15",
      items: [{ productId: "product-1", model: "Cassette AC", qty: 2, price: 122000, discount: 4000 }],
    });
    expect(mapped.tax).toBe(0);
    expect(mapped.total).toBe(240000);
    expect(mapped.customer).not.toBe(mapped.subject);
    expect(mapped.gstBreakdown).toBeUndefined();
    expect(canCreateQuotationPdf(mapped, true)).toBe(true);
  });

  it("maps the saved GST breakdown without recalculating it", () => {
    const gstBreakdown = {
      subtotal: 100, discount: 5, gst: 17.1, total: 112.1, rate: 0.18,
      partA: { subtotal: 100, discount: 5, gst: 17.1, total: 112.1 },
      partB: { subtotal: 0, discount: 0, gst: 0, total: 0 },
      gstByRate: [{ rate: 0.18, taxableAmount: 95, amount: 17.1 }],
      extraCharges: [{ label: "Freight", amount: 10, taxRate: 0.05 }],
    };
    const mapped = mapQuote({
      id: "gst-quote",
      Subject: "Offer 252/26-27 - AC package",
      Grand_Total: 112.1,
      Description: JSON.stringify({ name: "Customer", gstBreakdown }),
      Quoted_Items: [{ Product_Name: { id: "p-1", name: "AC" }, Quantity: 1, List_Price: 100, Discount: 5 }],
    }, new Map(), undefined, ["Quoted_Items"]);

    expect(mapped.gstBreakdown).toEqual(gstBreakdown);
    expect(mapped.total).toBe(112.1);
    expect(mapped.items?.[0]?.price).toBe(100);
  });

  it("maps a Zoho product tax percentage for use as its default quote-line rate", () => {
    expect(mapProduct({
      id: "p-taxed",
      Product_Name: "Taxed product",
      Unit_Price: 100,
      Tax: [{ name: "GST 5%", value: "5.0" }],
    })).toMatchObject({
      gstRate: 0.05,
      zohoTaxes: [{ name: "GST 5%", percentage: 5, rate: 0.05 }],
    });
  });

  it("maps a saved customer snapshot even when its Lead_Ref record is unavailable", () => {
    const mapped = mapQuote({
      id: "snapshot-quote",
      Subject: "Offer 251/26-27 - AC package",
      Description: JSON.stringify({
        leadId: "deleted-lead",
        name: "Ravi Kumar",
        phone: "9876543210",
        company: "Ravi Textiles",
        area: "Secunderabad",
        address: "12 Market Road",
      }),
      Quoted_Items: [{ Product_Name: { id: "product-1", name: "Cassette AC" }, Quantity: 1, List_Price: 122000 }],
    }, new Map(), undefined, ["Quoted_Items"]);

    expect(mapped).toMatchObject({
      customer: "Ravi Textiles",
      contactName: "Ravi Kumar",
      company: "Ravi Textiles",
      phone: "9876543210",
      area: "Secunderabad",
      address: "12 Market Road",
      leadId: "deleted-lead",
    });
    expect(canCreateQuotationPdf(mapped, true)).toBe(true);
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
    const zoho = vi.fn(async (_method: string, path: string, options?: { query?: { fields?: string } }) => {
      void options;
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
    expect(zoho.mock.calls.find((call) => call[1] === "/Quotes/quote-read")?.[2]).toMatchObject({
      query: { fields: expect.stringContaining("Mobile") },
    });
  });

  it("resolves a saved quote's missing lead link from its customer phone", async () => {
    const phoneLead = { ...leadRecord, id: "lead-phone", Company: "Unrelated Customer" };
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return { fields: quoteFields.fields };
      if (path === "/settings/layouts") return { layouts: [] };
      if (path === "/Quotes/quote-phone") return {
        data: [{
          id: "quote-phone",
          Subject: "Offer 250/26-27 - AC package",
          Account_Name: { id: "account-2", name: "Different Account" },
          Mobile: "9876543210",
          Quoted_Items: [{
            Product_Name: { id: "product-1", name: "Cassette AC" },
            Quantity: 1,
            List_Price: 122000,
          }],
        }],
      };
      if (path === "/Leads/search") return { data: [phoneLead] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => {
      if (module === "Leads") return [];
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

    await expect(zohoRepository.getQuote("quote-phone")).resolves.toMatchObject({
      leadId: "lead-phone",
      customer: "Different Account",
      phone: "9876543210",
      items: [{ productId: "product-1", model: "Cassette AC" }],
    });
    expect(zoho.mock.calls.some((call) => call[1] === "/Leads/search")).toBe(true);
  });

  it("falls back to the stored quote snapshot when Lead_Ref cannot be loaded", async () => {
    class MockZohoError extends Error {
      constructor(message: string, readonly status?: number, readonly code?: string) {
        super(message);
      }
    }
    const snapshot = {
      leadId: "deleted-lead",
      name: "Ravi Kumar",
      phone: "9876543210",
      company: "Ravi Textiles",
      area: "Secunderabad",
      address: "12 Market Road",
    };
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return { fields: quoteFields.fields };
      if (path === "/settings/layouts") return { layouts: [] };
      if (path === "/Quotes/quote-snapshot") return {
        data: [{
          id: "quote-snapshot",
          Subject: "Offer 252/26-27 - AC package",
          Lead_Ref: { id: "deleted-lead", name: "Old Lead" },
          Description: JSON.stringify(snapshot),
          Quoted_Items: [{ Product_Name: { name: "Cassette AC" }, Quantity: 1, List_Price: 122000 }],
        }],
      };
      if (path === "/Leads/deleted-lead") throw new MockZohoError("No permission or record deleted", 404, "NOT_FOUND");
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => module === "Products" ? [] : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZOHO_CRM_API_VERSION: "v6",
      ZohoError: MockZohoError,
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: vi.fn(),
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.getQuote("quote-snapshot")).resolves.toMatchObject({
      customer: "Ravi Textiles",
      contactName: "Ravi Kumar",
      company: "Ravi Textiles",
      phone: "9876543210",
      area: "Secunderabad",
      address: "12 Market Road",
      leadId: "deleted-lead",
      items: [{ model: "Cassette AC", qty: 1, price: 122000 }],
    });
    expect(zoho.mock.calls.some((call) => call[1] === "/Leads/deleted-lead")).toBe(false);
    expect(list).not.toHaveBeenCalled();
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
        return [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Tax: [{ percentage: 18, name: "GST 18% - configured" }], Product_Active: true }];
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
      id: "quote-1", offerNo: "239/26-27", leadId: "lead-1", customer: "Customer Co", total: 283200,
      gstBreakdown: {
        subtotal: 244000, discount: 4000, gst: 43200, total: 283200, rate: 0.18,
        partAGstMode: "extra",
        partA: { subtotal: 244000, discount: 4000, gst: 43200, total: 283200 },
        partB: { subtotal: 0, discount: 0, gst: 0, total: 0 },
        gstByRate: [{ rate: 0.18, taxableAmount: 240000, amount: 43200 }],
        extraCharges: [],
        zoho: { subtotal: 244000, discount: 4000, tax: 43200, adjustment: 0 },
      },
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
        Line_Tax: [{ percentage: 18, name: "GST 18% - configured" }],
      }],
      Sub_Total: 244000,
      Discount: 4000,
      Tax: 43200,
      Adjustment: 0,
    }));
    expect(infoLog).toHaveBeenCalledWith("[zoho] creating quote", expect.objectContaining({
      leadId: "lead-1",
      leadIdMatchesRequest: true,
      leadRefField: "Lead_Ref",
      leadRefValueType: "object",
      fieldMetadata: expect.objectContaining({
        api_name: "Lead_Ref",
        data_type: "lookup",
        lookup_module_api_name: "Leads",
        system_mandatory: true,
      }),
      payloadKeys: expect.arrayContaining(["Lead_Ref", "Quoted_Items"]),
    }));
    const writtenRecord = write.mock.calls.find((call) => call[1] === "/Quotes")?.[2] as Record<string, unknown>;
    expect(writtenRecord).not.toHaveProperty("Grand_Total");
    const savedLine = (writtenRecord.Quoted_Items as Record<string, unknown>[])[0]!;
    expect(savedLine.Line_Tax).toEqual([{ percentage: 18, name: "GST 18% - configured" }]);
    expect(JSON.parse(String(writtenRecord.Description))).toMatchObject({
      leadId: "lead-1", name: "Customer", phone: "9876543210", company: "Customer Co",
      gstBreakdown: {
        subtotal: 244000, discount: 4000, gst: 43200, total: 283200, rate: 0.18, partAGstMode: "extra",
        partA: { subtotal: 244000, discount: 4000, gst: 43200, total: 283200 },
        partB: { subtotal: 0, discount: 0, gst: 0, total: 0 },
        gstByRate: [{ rate: 0.18, taxableAmount: 240000, amount: 43200 }],
        extraCharges: [],
        zoho: { subtotal: 244000, discount: 4000, tax: 43200, adjustment: 0 },
      },
    });
    expect(errorLog).toHaveBeenCalledWith("[zoho] primary change succeeded but history note failed", expect.objectContaining({
      action: "create quote",
      quoteId: "quote-1",
      leadId: "lead-1",
      message: "history note permission missing",
    }));
    errorLog.mockRestore();
    infoLog.mockRestore();
  });

  it("retries an HTTP-200 Line_Tax record rejection and preserves GST and extra charges", async () => {
    class MockZohoError extends Error {
      constructor(
        message: string,
        readonly status?: number,
        readonly code?: string,
        readonly field?: string,
        readonly invalidValue?: unknown,
        readonly operation?: string,
        readonly details?: Record<string, unknown>,
        readonly reference?: string,
      ) {
        super(message);
      }
    }
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
    const postPayloads: Record<string, unknown>[] = [];
    const write = vi.fn(async (_method: string, path: string, payload: Record<string, unknown>) => {
      if (path === "/Quotes") {
        postPayloads.push({ ...payload });
        const line = (payload.Quoted_Items as Record<string, unknown>[] | undefined)?.[0];
        if (line?.Line_Tax) throw new MockZohoError(
          "Zoho rejected the value for field/path $.data[0].data[0].Quoted_Items[0].Line_Tax[0].name",
          200,
          "INVALID_DATA",
          undefined,
          undefined,
          "POST /Quotes",
          { json_path: "$.data[0].data[0].Quoted_Items[0].Line_Tax[0].name" },
          "ZOHO-LINE-TAX-REF",
        );
        return "quote-tax-fallback";
      }
      return "side-effect";
    });
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return quoteFields;
      if (path === "/settings/layouts") return { layouts: [] };
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => module === "Products"
      ? [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Description: "Cassette indoor unit", Tax: [{ percentage: 18, name: "GST 18% - configured" }], Product_Active: true }]
      : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZOHO_CRM_API_VERSION: "v6",
      ZohoError: MockZohoError,
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
      extraCharges: [{ label: "Freight", amount: 100, taxRate: 0.12 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" }, "Manager")).resolves.toMatchObject({
      id: "quote-tax-fallback",
      total: 283312,
      gstBreakdown: {
        subtotal: 244000, discount: 4000, gst: 43212, total: 283312, rate: 0.18,
        zoho: { subtotal: 244000, discount: 4000, tax: 43212, adjustment: 100 },
        extraCharges: [{ label: "Freight", amount: 100, taxRate: 0.12 }],
      },
    });

    expect(postPayloads).toHaveLength(2);
    expect(postPayloads[0]).toMatchObject({ Sub_Total: 244000, Discount: 4000, Tax: 43212, Adjustment: 100 });
    expect(postPayloads[0]).not.toHaveProperty("Grand_Total");
    expect(postPayloads[1]).toMatchObject({ Sub_Total: 244000, Discount: 4000, Adjustment: 43312 });
    expect(postPayloads[1]).not.toHaveProperty("Tax");
    expect(postPayloads[1]).not.toHaveProperty("Grand_Total");
    expect(postPayloads[1]!.Quoted_Items).toEqual([expect.objectContaining({
      Product_Name: { id: "product-1" },
      Quantity: 2,
      List_Price: 122000,
      Discount: 4000,
      Total: 244000,
      Net_Total: 240000,
      Total_After_Discount: 240000,
      Description: "Cassette indoor unit",
    })]);
    expect((postPayloads[1]!.Quoted_Items as Record<string, unknown>[])[0]).not.toHaveProperty("Line_Tax");
    expect(errorLog).toHaveBeenCalledWith(
      "[zoho] quotation tax write rejected; retrying without unsupported tax fields",
      expect.objectContaining({
        reference: "ZOHO-LINE-TAX-REF",
        status: 200,
        gstAmount: 43212,
        message: expect.stringContaining("Line_Tax[0].name"),
      }),
    );
    expect(infoLog).toHaveBeenCalledWith("[zoho] quotation tax fallback saved", expect.objectContaining({
      reference: "ZOHO-LINE-TAX-REF",
      quoteId: "quote-tax-fallback",
      gstPreservedInAdjustment: 43212,
      adjustment: 43312,
    }));
    errorLog.mockRestore();
    infoLog.mockRestore();
  });

  it("allocates different offer numbers for back-to-back quote creates", async () => {
    const records: Record<string, unknown>[] = [];
    const write = vi.fn(async (_method: string, path: string, record: Record<string, unknown>) => {
      if (path === "/Quotes") {
        records.push({ ...record, id: `quote-${records.length + 1}`, Created_Time: new Date().toISOString() });
        return `quote-${records.length}`;
      }
      return "side-effect";
    });
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return quoteFields;
      if (path === "/settings/layouts") return { layouts: [] };
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => {
      if (module === "Products") return [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Product_Active: true }];
      if (module === "Quotes") return records as never[];
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
    const input = {
      offerNo: "247/26-27",
      leadId: "lead-1",
      items: [{ productId: "product-1", qty: 1, discount: 0 }],
    };
    const actor = { id: "manager-1", name: "Manager", role: "Manager" as const };

    const first = await zohoRepository.createQuote(input, actor, "Manager");
    const second = await zohoRepository.createQuote(input, actor, "Manager");

    expect(first.offerNo).not.toBe(second.offerNo);
    expect([first.offerNo, second.offerNo]).toEqual(["239/26-27", "240/26-27"]);
    expect(records.map((record) => record.Offer_No)).toEqual(["239/26-27", "240/26-27"]);
  });

  it("increments and retries once when Zoho reports an offer number collision", async () => {
    class MockZohoError extends Error {
      constructor(message: string, readonly status?: number, readonly code?: string) {
        super(message);
      }
    }
    const records: Record<string, unknown>[] = [];
    const attempts: string[] = [];
    const write = vi.fn(async (_method: string, path: string, record: Record<string, unknown>) => {
      if (path === "/Quotes") {
        attempts.push(String(record.Offer_No));
        if (attempts.length === 1) throw new MockZohoError("Duplicate offer number", 400, "DUPLICATE_DATA");
        records.push({ ...record, id: "quote-retried" });
        return "quote-retried";
      }
      return "side-effect";
    });
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return quoteFields;
      if (path === "/settings/layouts") return { layouts: [] };
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => {
      if (module === "Products") return [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Product_Active: true }];
      if (module === "Quotes") return records as never[];
      return [];
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZOHO_CRM_API_VERSION: "v6",
      ZohoError: MockZohoError,
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: list,
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.createQuote({
      offerNo: "239/26-27",
      leadId: "lead-1",
      items: [{ productId: "product-1", qty: 1, discount: 0 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" }, "Manager")).resolves.toMatchObject({
      offerNo: "240/26-27",
    });
    expect(attempts).toEqual(["239/26-27", "240/26-27"]);
  });

  it("writes the legacy Product_Details shape when that is the only line-item field in metadata", async () => {
    const write = vi.fn(async () => "quote-legacy");
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return {
        fields: quoteFields.fields.map((field) => field.api_name === "Quoted_Items"
          ? { api_name: "Product_Details", data_type: "subform", subform: "subform" in field ? field.subform : undefined }
          : field),
      };
      if (path === "/Leads/lead-1") return { data: [leadRecord] };
      if (path === "/users") return { users: userRecords };
      return {};
    });
    const list = vi.fn(async (module: string) => module === "Products"
      ? [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Tax: [{ percentage: 18, name: "GST 18% - configured" }], Product_Active: true }]
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
        Line_Tax: [{ percentage: 18, name: "GST 18% - configured" }],
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

  it("omits an unusable lookup and keeps the lead ID in the customer snapshot", async () => {
    const write = vi.fn(async (...args: unknown[]) => args[1] === "/Quotes" ? "should-not-save" : "side-effect");
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
    const writtenRecord = write.mock.calls.find((call) => call[1] === "/Quotes")?.[2] as Record<string, unknown> | undefined;
    expect(writtenRecord).toBeDefined();
    expect(JSON.parse(String(writtenRecord?.Description))).toMatchObject({ leadId: "lead-1" });
    expect(write).not.toHaveBeenCalledWith("POST", "/Quotes", expect.objectContaining({ Lead_Ref: expect.anything() }));
  });

  it("creates the quote without guessing when Lead_Ref is missing from metadata", async () => {
    const write = vi.fn(async (...args: unknown[]) => args[1] === "/Quotes" ? "quote-absent" : "side-effect");
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
    const writtenRecord = write.mock.calls.find((call) => call[1] === "/Quotes")?.[2] as Record<string, unknown> | undefined;
    expect(writtenRecord).toBeDefined();
    expect(JSON.parse(String(writtenRecord?.Description))).toMatchObject({ leadId: "lead-1" });
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
          { api_name: "Quote_Stage" },
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
        return [{ id: "product-1", Product_Name: "Cassette AC", Unit_Price: 122000, Usage_Unit: "Nos", Tax: [{ percentage: 18, name: "GST 18% - configured" }], Product_Active: true }];
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
      offerNo: "239/26-27",
      leadId: "lead-1",
      customer: "Customer Co",
    });

    expect(write).toHaveBeenCalledWith("POST", "/Quotes", expect.objectContaining({
      Subject: "Offer 239/26-27 - Cache round-trip offer",
      Offer_No: "239/26-27",
      Lead_Ref: { id: "lead-1" },
      Quoted_Items: [{
        Product_Name: { id: "product-1" },
        Quantity: 1,
        List_Price: 122000,
        Discount: 2000,
        Total: 122000,
        Total_After_Discount: 120000,
        Net_Total: 120000,
        Line_Tax: [{ percentage: 18, name: "GST 18% - configured" }],
      }],
    }));
  });

  it("uses the Zoho count endpoint and supports owner-scoped quotation totals", async () => {
    const zoho = vi.fn(async (_method: string, _path: string, options?: { query?: Record<string, string> }) => ({
      count: options?.query?.criteria ? 7 : 23,
    }));
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: vi.fn(),
      zohoWrite: vi.fn(),
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.countQuotes?.()).resolves.toBe(23);
    await expect(zohoRepository.countQuotes?.("manager-1")).resolves.toBe(7);
    expect(zoho).toHaveBeenCalledWith("GET", "/Quotes/actions/count", { query: undefined });
    expect(zoho).toHaveBeenCalledWith("GET", "/Quotes/actions/count", {
      query: { criteria: "(Owner.id:equals:manager-1)" },
    });
  });

  it("marks saved quotations Sent using the configured Quote_Stage picklist value", async () => {
    const write = vi.fn(async () => "quote-1");
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") return quoteFields;
      if (path === "/settings/layouts") return { layouts: [] };
      return {};
    });
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {},
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList: vi.fn(),
      zohoWrite: write,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await zohoRepository.markQuoteSent("quote-1");
    expect(write).toHaveBeenCalledWith("PUT", "/Quotes/quote-1", { Quote_Stage: "Sent" });
  });
});
