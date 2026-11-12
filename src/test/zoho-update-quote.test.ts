import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  zoho: vi.fn(),
  zohoList: vi.fn(),
  zohoWrite: vi.fn(),
}));

const quoteFields = [
  { api_name: "Subject", data_type: "text" },
  { api_name: "Status", data_type: "picklist", pick_list_values: [{ actual_value: "Draft" }, { actual_value: "Sent" }] },
  { api_name: "Offer_No", data_type: "text" },
  { api_name: "Description", data_type: "textarea" },
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
];

vi.mock("react", () => ({ cache: (fn: (...args: never[]) => unknown) => fn }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/cache", () => ({
  cached: vi.fn((_key: string, _ttl: number, loader: () => unknown) => loader()),
  getCachedValue: vi.fn(),
  invalidate: vi.fn(),
  markStale: vi.fn(),
  setCachedValue: vi.fn(),
}));
vi.mock("@/lib/env", () => ({ env: () => ({ DATA_SOURCE: "zoho", ZOHO_MAX_LEADS: 5000 }) }));
vi.mock("@/lib/zoho/client", () => ({
  ZohoError: class ZohoError extends Error {},
  ZOHO_CRM_API_VERSION: "v6",
  hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
  zoho: mocks.zoho,
  zohoList: mocks.zohoList,
  zohoWrite: mocks.zohoWrite,
}));

describe("Zoho quotation revision", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.zoho.mockReset().mockImplementation(async (_method: string, path: string) => {
      if (path === "/settings/fields") return { fields: quoteFields };
      if (path === "/settings/layouts") return { layouts: [] };
      if (path === "/Quotes/quote-1") return { data: [{
        id: "quote-1",
        Subject: "Offer 236/26-27 - AC package",
        Offer_No: "236/26-27",
        Status: "Draft",
        Owner: { id: "manager-1", name: "Manager" },
        Description: JSON.stringify({
          leadId: "lead-1",
          name: "Customer",
          phone: "9876543210",
          company: "Customer Co",
          area: "Hyderabad",
          address: "Customer address",
        }),
        Quoted_Items: [{
          Product_Name: { id: "product-1", name: "Cassette AC" },
          Quantity: 1,
          List_Price: 1000,
          Discount: 0,
          Line_Tax: [{ percentage: 18, name: "GST 18%" }],
        }],
      }] };
      if (path === "/Leads/lead-1") return { data: [{
        id: "lead-1",
        Last_Name: "Customer",
        Company: "Customer Co",
        Mobile: "9876543210",
        City: "Hyderabad",
        Street: "Customer address",
        Lead_Status: "Quotation Sent",
        Lead_Source: "Direct Call",
        Owner: { id: "manager-1", name: "Manager" },
      }] };
      return {};
    });
    mocks.zohoList.mockImplementation(async (module: string) => module === "Products" ? [{
      id: "product-1",
      Product_Name: "Cassette AC",
      Product_Code: "AC-1",
      Unit_Price: 1000,
      Usage_Unit: "Nos",
      Tax: [{ percentage: 18, name: "GST 18%" }, { percentage: 5, name: "GST 5% - configured" }],
      Product_Active: true,
    }] : []);
    mocks.zohoWrite.mockReset().mockResolvedValue("quote-1");
  });

  it("updates the existing quote, preserves its offer number, and stores the next revision", async () => {
    const { zohoRepository } = await import("@/lib/zoho/repository");

    const result = await zohoRepository.updateQuote("quote-1", {
      leadId: "lead-1",
      subject: "Revised AC package",
      items: [{ productId: "product-1", qty: 2, discount: 100, taxRate: 0.05 }],
      extraCharges: [{ label: "Freight", amount: 50, taxRate: 0.12 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" });

    expect(result).toMatchObject({
      id: "quote-1",
      offerNo: "236/26-27",
      revision: 1,
      status: "Draft",
      total: 2051,
    });
    expect(mocks.zohoWrite).toHaveBeenCalledOnce();
    expect(mocks.zohoWrite).toHaveBeenCalledWith("PUT", "/Quotes/quote-1", expect.objectContaining({
      Subject: "Offer 236/26-27/R1 - Revised AC package",
      Offer_No: "236/26-27",
      Sub_Total: 2000,
      Discount: 100,
      Tax: 101,
      Adjustment: 50,
      Quoted_Items: [expect.objectContaining({
        Product_Name: { id: "product-1" },
        Line_Tax: [{ percentage: 5, name: "GST 5% - configured" }],
      })],
    }));
    const payload = mocks.zohoWrite.mock.calls[0]?.[2] as Record<string, unknown>;
    const snapshot = JSON.parse(String(payload.Description)) as { revision?: number; gstBreakdown?: { extraCharges?: unknown[] } };
    expect(snapshot.revision).toBe(1);
    expect(snapshot.gstBreakdown?.extraCharges).toEqual([{ label: "Freight", amount: 50, taxRate: 0.12 }]);
  });

  it.each([400, 422])("does not retry unrelated Zoho field errors with HTTP %i", async (status) => {
    const { ZohoError } = await import("@/lib/zoho/client");
    const originalError = new ZohoError(
      "The Taxonomy option is invalid.",
      status,
      "INVALID_DATA",
      "Taxonomy",
      undefined,
      "PUT /Quotes/quote-1",
      { api_name: "Taxonomy", json_path: "$.data[0].Taxonomy" },
    );
    mocks.zohoWrite.mockRejectedValue(originalError);
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.updateQuote("quote-1", {
      leadId: "lead-1",
      items: [{ productId: "product-1", qty: 1, discount: 0 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" })).rejects.toBe(originalError);
    expect(mocks.zohoWrite).toHaveBeenCalledOnce();
  });

  it("retries an HTTP-200 Line_Tax rejection without losing revision details or GST totals", async () => {
    class MockZohoError extends Error {
      constructor(
        message: string,
        readonly status?: number,
        readonly code?: string,
        readonly field?: string,
        readonly operation?: string,
        readonly details?: Record<string, unknown>,
        readonly reference?: string,
      ) {
        super(message);
      }
    }
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
    const records: Record<string, unknown>[] = [];
    mocks.zohoWrite.mockImplementation(async (_method: string, _path: string, record: Record<string, unknown>) => {
      records.push(record);
      if (records.length === 1) {
        throw new MockZohoError(
          "Zoho rejected the value for field/path $.data[0].data[0].Quoted_Items[0].Line_Tax[0].name",
          200,
          "INVALID_DATA",
          undefined,
          "PUT /Quotes/quote-1",
          { json_path: "$.data[0].data[0].Quoted_Items[0].Line_Tax[0].name" },
          "ZOHO-UPDATE-TAX-REF",
        );
      }
      return "quote-1";
    });
    mocks.zohoList.mockImplementation(async (module: string) => module === "Products" ? [{
      id: "product-1",
      Product_Name: "Cassette AC",
      Product_Code: "AC-1",
      Unit_Price: 1000,
      Usage_Unit: "Nos",
      Description: "Cassette indoor unit",
      Tax: [{ percentage: 18, name: "GST 18%" }, { percentage: 5, name: "GST 5% - configured" }],
      Product_Active: true,
    }] : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: MockZohoError,
      ZOHO_CRM_API_VERSION: "v6",
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho: mocks.zoho,
      zohoList: mocks.zohoList,
      zohoWrite: mocks.zohoWrite,
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.updateQuote("quote-1", {
      leadId: "lead-1",
      subject: "Revised AC package",
      items: [{ productId: "product-1", qty: 2, discount: 100, taxRate: 0.05 }],
      extraCharges: [{ label: "Freight", amount: 50, taxRate: 0.12 }],
    }, { id: "manager-1", name: "Manager", role: "Manager" })).resolves.toMatchObject({
      id: "quote-1",
      revision: 1,
      total: 2051,
      gstBreakdown: {
        subtotal: 2000, discount: 100, gst: 101, total: 2051,
        extraCharges: [{ label: "Freight", amount: 50, taxRate: 0.12 }],
      },
    });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      Tax: 101,
      Adjustment: 50,
      Quoted_Items: [expect.objectContaining({
        Product_Name: { id: "product-1" }, Quantity: 2, List_Price: 1000, Discount: 100,
        Description: "Cassette indoor unit", Line_Tax: [{ percentage: 5, name: "GST 5% - configured" }],
      })],
    });
    expect(records[1]).toMatchObject({
      Sub_Total: 2000,
      Discount: 100,
      Adjustment: 151,
      Quoted_Items: [expect.objectContaining({
        Product_Name: { id: "product-1" }, Quantity: 2, List_Price: 1000, Discount: 100,
        Description: "Cassette indoor unit",
      })],
    });
    expect(records[1]).not.toHaveProperty("Tax");
    expect((records[1]!.Quoted_Items as Record<string, unknown>[])[0]).not.toHaveProperty("Line_Tax");
    expect(errorLog).toHaveBeenCalledWith(
      "[zoho] quotation tax write rejected; retrying without unsupported tax fields",
      expect.objectContaining({ reference: "ZOHO-UPDATE-TAX-REF", status: 200, gstAmount: 101 }),
    );
    expect(infoLog).toHaveBeenCalledWith(
      "[zoho] quotation tax fallback saved",
      expect.objectContaining({
        reference: "ZOHO-UPDATE-TAX-REF",
        quoteId: "quote-1",
        gstPreservedInAdjustment: 101,
        adjustment: 151,
      }),
    );
    errorLog.mockRestore();
    infoLog.mockRestore();
  });
});
