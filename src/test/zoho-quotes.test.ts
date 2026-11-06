import { beforeEach, describe, expect, it, vi } from "vitest";

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
    { api_name: "Product_Details", data_type: "subform" },
    { api_name: "Offer_No" },
    { api_name: "Lead_Ref", data_type: "lookup", lookup: { module: { api_name: "Leads" } }, system_mandatory: true },
  ],
};

describe("Zoho quotation creation", () => {
  it("writes the CRM Product_Details shape and keeps note failures from masking a saved quote", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
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
      ZohoError: class extends Error {},
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
      Product_Details: [{
        product: { id: "product-1" },
        quantity: 2,
        list_price: 122000,
        Discount: 4000,
        total: 244000,
        total_after_discount: 240000,
        net_total: 240000,
      }],
      Sub_Total: 244000,
      Discount: 4000,
      Grand_Total: 240000,
    }));
    expect(write).not.toHaveBeenCalledWith("POST", "/Quotes", expect.objectContaining({
      Quoted_Items: expect.anything(),
    }));
    expect(errorLog).toHaveBeenCalledWith("[zoho] quote was saved but its lead-history note failed", expect.objectContaining({
      quoteId: "quote-1",
      leadId: "lead-1",
      message: "history note permission missing",
    }));
    errorLog.mockRestore();
  });

  it("writes Lead_Ref as text when Quotes metadata declares a text field", async () => {
    const write = vi.fn(async () => "quote-2");
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/settings/fields") {
        return { fields: quoteFields.fields.map((field) => field.api_name === "Lead_Ref"
          ? { api_name: "Lead_Ref", data_type: "text", system_mandatory: true }
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
        constructor(message: string, readonly status?: number, readonly code?: string, readonly field?: string) {
          super(message);
        }
      },
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
      Product_Details: [{
        product: { id: "product-1" },
        quantity: 1,
        list_price: 122000,
        Discount: 2000,
        total: 122000,
        total_after_discount: 120000,
        net_total: 120000,
      }],
    }));
  });
});
