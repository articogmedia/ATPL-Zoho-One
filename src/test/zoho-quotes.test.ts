import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (load: () => unknown) => load,
}));

beforeEach(async () => {
  process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";
  process.env.DATA_SOURCE = "mock";
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
    { api_name: "Subject" },
    { api_name: "Product_Details" },
    { api_name: "Offer_No" },
    { api_name: "Lead_Ref" },
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
});
