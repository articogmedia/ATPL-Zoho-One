import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Lead, Quotation, User } from "@/lib/domain";

const mocks = vi.hoisted(() => {
  const idempotentResults = new Map<string, Promise<unknown>>();
  return {
    zoho: vi.fn(),
    zohoList: vi.fn(),
    zohoWrite: vi.fn(),
    markStale: vi.fn(),
    idempotentResults,
    cached: vi.fn(<T,>(_key: string, _ttl: number, load: () => Promise<T>) => load()),
    withIdempotency: vi.fn(<T,>(key: string, operation: () => Promise<T>) => {
      const current = idempotentResults.get(key);
      if (current) return current as Promise<T>;
      const result = operation();
      idempotentResults.set(key, result);
      void result.catch(() => idempotentResults.delete(key));
      return result;
    }),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("react", () => ({ cache: (load: (...args: never[]) => unknown) => load }));
vi.mock("next/server", () => ({ after: (task: () => unknown) => task() }));
vi.mock("@/lib/cache", () => ({
  cached: mocks.cached,
  getCachedValue: vi.fn(),
  invalidate: vi.fn(),
  markStale: mocks.markStale,
  setCachedValue: vi.fn(),
  withIdempotency: mocks.withIdempotency,
}));
vi.mock("@/lib/env", () => ({
  env: () => ({ CACHE_SHORT_TTL_MS: 30_000, ZOHO_MAX_LEADS: 100 }),
}));
vi.mock("@/lib/zoho/client", () => ({
  ZohoError: class ZohoError extends Error {
    constructor(
      message: string,
      readonly status?: number,
      readonly code?: string,
      readonly field?: string,
    ) {
      super(message);
    }
  },
  hosts: () => ({ api: "https://www.zohoapis.in" }),
  zoho: mocks.zoho,
  zohoList: mocks.zohoList,
  zohoWrite: mocks.zohoWrite,
  ZOHO_CRM_API_VERSION: "v6",
}));

const lead: Lead = {
  id: "lead-1",
  name: "Customer",
  company: "Customer Ltd",
  phone: "9999999999",
  email: "customer@example.com",
  area: "",
  source: "Direct Call",
  status: "Won",
  assignedTo: "Pavan",
  ownerId: "exec-1",
  remarks: "",
  createdOn: "2026-04-01",
  address: "",
  touchedBy: [],
};
const quote: Quotation = {
  id: "quote-1",
  offerNo: "301/26-27",
  leadId: lead.id,
  customer: lead.company,
  executive: "Pavan",
  ownerId: "exec-1",
  total: 118,
  date: "2026-04-01",
  items: [{ productId: "product-1", model: "Unit", unit: "Nos", qty: 1, price: 100, taxRate: 0.18 }],
};
const actor: User = { id: "exec-1", name: "Pavan", role: "Sales Executive" };

beforeEach(() => {
  vi.resetModules();
  mocks.zoho.mockReset().mockResolvedValue({ data: [] });
  mocks.zohoList.mockReset().mockResolvedValue([]);
  mocks.zohoWrite.mockReset().mockImplementation(async (_method: string, path: string) =>
    path === "/Accounts" ? "account-created" : "lead-1");
  mocks.markStale.mockReset().mockResolvedValue(undefined);
  mocks.cached.mockClear();
  mocks.withIdempotency.mockClear();
  mocks.idempotentResults.clear();
});

describe("Zoho Account resolution for invoice conversion", () => {
  it("reuses an exact Account_Name match and saves its ID to the lead", async () => {
    mocks.zoho.mockResolvedValueOnce({
      data: [{ id: "account-existing", Account_Name: "Customer Ltd", Phone: "9999999999" }],
    });
    const { ensureAccountForLead } = await import("@/lib/zoho/repository");

    await expect(ensureAccountForLead(lead)).resolves.toBe("account-existing");

    expect(mocks.zoho).toHaveBeenCalledWith("GET", "/Accounts/search", {
      query: { criteria: "(Account_Name:equals:Customer Ltd)", fields: "Account_Name,Phone", per_page: 200 },
    });
    expect(mocks.zohoWrite).toHaveBeenCalledWith("PUT", "/Leads/lead-1", {
      ATPL_Account_ID: "account-existing",
    });
    expect(mocks.zohoWrite).not.toHaveBeenCalledWith("POST", "/Accounts", expect.anything());
    expect(mocks.markStale).toHaveBeenCalledWith("leads");
  });

  it("checks Phone when the name search has no exact match", async () => {
    mocks.zoho
      .mockResolvedValueOnce({ data: [{ id: "wrong-name", Account_Name: "Customer Ltd Branch" }] })
      .mockResolvedValueOnce({ data: [{ id: "account-by-phone", Account_Name: "Other", Phone: "+91 9999999999" }] });
    const { ensureAccountForLead } = await import("@/lib/zoho/repository");

    await expect(ensureAccountForLead(lead)).resolves.toBe("account-by-phone");
    expect(mocks.zoho).toHaveBeenCalledTimes(2);
    expect(mocks.zoho.mock.calls[1]?.[2].query.criteria).toContain("Phone:equals:");
    expect(mocks.zohoWrite).not.toHaveBeenCalledWith("POST", "/Accounts", expect.anything());
  });

  it("creates an Account, links it to the lead, and invalidates lead data", async () => {
    const { ensureAccountForLead } = await import("@/lib/zoho/repository");

    await expect(ensureAccountForLead(lead)).resolves.toBe("account-created");

    expect(mocks.zohoWrite).toHaveBeenNthCalledWith(1, "POST", "/Accounts", {
      Account_Name: "Customer Ltd",
      Phone: "9999999999",
      Email: "customer@example.com",
    });
    expect(mocks.zohoWrite).toHaveBeenNthCalledWith(2, "PUT", "/Leads/lead-1", {
      ATPL_Account_ID: "account-created",
    });
    expect(mocks.markStale).toHaveBeenCalledWith("leads");
  });

  it("coalesces concurrent account creation for the same lead", async () => {
    mocks.zoho.mockImplementation(async () => ({ data: [] }));
    const { ensureAccountForLead } = await import("@/lib/zoho/repository");

    await expect(Promise.all([
      ensureAccountForLead(lead),
      ensureAccountForLead(lead),
    ])).resolves.toEqual(["account-created", "account-created"]);
    expect(mocks.zohoWrite).toHaveBeenCalledWith("POST", "/Accounts", expect.anything());
    expect(mocks.zohoWrite.mock.calls.filter((call) => call[1] === "/Accounts")).toHaveLength(1);
  });

  it("keeps the missing-name error when no quote or lead Account exists", async () => {
    const { zohoRepository } = await import("@/lib/zoho/repository");
    const unnamedLead = { ...lead, name: "", company: "" };

    await expect(zohoRepository.createInvoice(quote, unnamedLead, actor, ""))
      .rejects.toMatchObject({ code: "INVOICE_ACCOUNT_REQUIRED" });
    expect(mocks.zoho).not.toHaveBeenCalled();
    expect(mocks.zohoWrite).not.toHaveBeenCalled();
  });
});

describe("Zoho invoice line-item field mapping", () => {
  async function createInvoiceWithField(lineItemsField: "Invoiced_Items" | "Product_Details") {
    const subfields = [
      "Product_Name", "Quantity", "List_Price", "Discount", "Total", "Net_Total", "Line_Tax",
    ].map((api_name) => ({ api_name }));
    mocks.zoho.mockImplementation(async (_method: string, path: string, options?: { query?: { module?: string } }) =>
      path === "/settings/fields" && options?.query?.module === "Invoices"
        ? { fields: [{ api_name: lineItemsField, subform_fields: subfields }] }
        : { data: [] });
    mocks.zohoList.mockImplementation(async (module: string) => module === "Products"
      ? [{
        id: "product-1",
        Product_Name: "Unit",
        Unit_Price: 100,
        Product_Active: true,
        Usage_Unit: "Nos",
        Tax: [{ name: "GST 18", percentage: 18 }],
      }]
      : []);

    const { zohoRepository } = await import("@/lib/zoho/repository");
    const invoiceQuote = { ...quote, accountId: "account-1" };
    await zohoRepository.createInvoice(invoiceQuote, lead, actor, "");

    const call = mocks.zohoWrite.mock.calls.find((args) => args[1] === "/Invoices");
    return call?.[2] as Record<string, unknown>;
  }

  it("uses Invoiced_Items with the metadata-supported Zoho subform shape", async () => {
    const payload = await createInvoiceWithField("Invoiced_Items");
    const item = (payload.Invoiced_Items as Record<string, unknown>[])[0];

    expect(payload).toHaveProperty("Invoiced_Items");
    expect(payload).not.toHaveProperty("Product_Details");
    expect(item).toMatchObject({
      Product_Name: { id: "product-1" },
      Quantity: 1,
      List_Price: 100,
      Discount: 0,
      Total: 100,
      Net_Total: 100,
      Line_Tax: [{ name: "GST 18", percentage: 18 }],
    });
    expect(item).not.toHaveProperty("Unit_Price");
  });

  it("keeps the legacy Product_Details line-item shape when metadata requires it", async () => {
    const payload = await createInvoiceWithField("Product_Details");
    const item = (payload.Product_Details as Record<string, unknown>[])[0];

    expect(payload).toHaveProperty("Product_Details");
    expect(payload).not.toHaveProperty("Invoiced_Items");
    expect(item).toMatchObject({
      product: { id: "product-1" },
      quantity: 1,
      list_price: 100,
      Discount: 0,
      total: 100,
      total_after_discount: 100,
      net_total: 100,
    });
  });
});
