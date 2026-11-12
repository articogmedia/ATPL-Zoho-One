import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  zohoWrite: vi.fn(),
  zohoList: vi.fn(),
}));

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
  ZohoError: class ZohoError extends Error {
    constructor(message: string, public status: number, public code: string) {
      super(message);
    }
  },
  ZOHO_CRM_API_VERSION: "v6",
  hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
  zoho: vi.fn(),
  zohoList: mocks.zohoList,
  zohoWrite: mocks.zohoWrite,
}));

describe("Zoho product creation", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.zohoWrite.mockReset().mockResolvedValue("zoho-product-1");
    mocks.zohoList.mockReset().mockResolvedValue([{
      id: "zoho-product-existing",
      Product_Name: "Existing unit",
      Unit_Price: 1000,
      Tax: [{ percentage: 12, name: "GST 12% - configured" }],
    }]);
  });

  it("writes the product fields and GST rate to Zoho Products", async () => {
    const { zohoRepository } = await import("@/lib/zoho/repository");
    const input = { name: "Wall Unit", code: "WALL-01", unit: "Nos", price: 25000, gstRate: 0.12 };

    await expect(zohoRepository.createProduct(input)).resolves.toEqual({
      id: "zoho-product-1",
      model: "Wall Unit",
      code: "WALL-01",
      unit: "Nos",
      price: 25000,
      gstRate: 0.12,
      zohoTaxes: [{ percentage: 12, name: "GST 12% - configured", rate: 0.12 }],
    });
    expect(mocks.zohoWrite).toHaveBeenCalledWith("POST", "/Products", {
      Product_Name: "Wall Unit",
      Product_Code: "WALL-01",
      Usage_Unit: "Nos",
      Unit_Price: 25000,
      Tax: [{ percentage: 12, name: "GST 12% - configured" }],
    });
  });

  it("does not invent a tax name when no matching Zoho configuration exists", async () => {
    mocks.zohoList.mockResolvedValue([{
      id: "zoho-product-existing",
      Product_Name: "Existing unit",
      Unit_Price: 1000,
      Tax: [{ percentage: 18, name: "GST 18% - configured" }],
    }]);
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.createProduct({
      name: "Wall Unit",
      code: "WALL-01",
      unit: "Nos",
      price: 25000,
      gstRate: 0.12,
    })).rejects.toMatchObject({ code: "MISSING_PRODUCT_TAX_MAPPING" });
    expect(mocks.zohoWrite).not.toHaveBeenCalled();
  });

  it("does not choose arbitrarily between multiple Zoho tax names at the same rate", async () => {
    mocks.zohoList.mockResolvedValue([
      { id: "product-1", Product_Name: "Unit A", Tax: [{ percentage: 12, name: "GST 12%" }] },
      { id: "product-2", Product_Name: "Unit B", Tax: [{ percentage: 12, name: "IGST 12%" }] },
    ]);
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.createProduct({
      name: "Wall Unit",
      code: "WALL-01",
      unit: "Nos",
      price: 25000,
      gstRate: 0.12,
    })).rejects.toMatchObject({ code: "MISSING_PRODUCT_TAX_MAPPING" });
    expect(mocks.zohoWrite).not.toHaveBeenCalled();
  });
});
