import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireActionUser: vi.fn(),
  listProducts: vi.fn(),
  createProduct: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  requireActionUser: mocks.requireActionUser,
}));
vi.mock("@/lib/crm", () => ({ crm: () => ({ listProducts: mocks.listProducts, createProduct: mocks.createProduct }) }));
vi.mock("@/lib/cache", () => ({
  getCachedValue: vi.fn(),
  invalidate: mocks.invalidate,
  setCachedValue: vi.fn(),
  withIdempotency: vi.fn(),
}));

const manager = { id: "manager-1", name: "Manager", role: "Manager" };
const input = { name: "Wall Unit", code: "WALL-01", unit: "Nos", price: 25000, gstRate: 0.12 };
const created = { id: "p-new", model: "Wall Unit", code: "WALL-01", unit: "Nos", price: 25000, gstRate: 0.12 };

describe("createProductAction", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.requireActionUser.mockReset().mockResolvedValue(manager);
    mocks.listProducts.mockReset().mockResolvedValue([]);
    mocks.createProduct.mockReset().mockResolvedValue(created);
    mocks.invalidate.mockReset().mockResolvedValue(undefined);
  });

  it("allows only managers to create products", async () => {
    mocks.requireActionUser.mockResolvedValue({ ...manager, role: "Sales Executive" });
    const { createProductAction } = await import("@/app/actions/crm");

    const result = await createProductAction(input);

    expect(result).toMatchObject({ ok: false, error: "Only managers can add products." });
    expect(mocks.createProduct).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("validates all required product fields before CRM operations", async () => {
    const { createProductAction } = await import("@/app/actions/crm");

    const result = await createProductAction({ ...input, code: "", price: -1, gstRate: 1.01 });

    expect(result).toMatchObject({ ok: false, error: "Enter a product code." });
    expect(mocks.listProducts).not.toHaveBeenCalled();
    expect(mocks.createProduct).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...created, model: " wall unit " }, input, "name"],
    [{ ...created, model: "Another product", code: " wall-01 " }, input, "code"],
  ])("rejects duplicate product %s", async (existing, product, field) => {
    mocks.listProducts.mockResolvedValue([existing]);
    const { createProductAction } = await import("@/app/actions/crm");

    const result = await createProductAction(product);

    expect(result).toMatchObject({ ok: false, error: `A product with this ${field} already exists.` });
    expect(mocks.createProduct).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });

  it("creates the validated product and invalidates the cache before and after the write", async () => {
    const { createProductAction } = await import("@/app/actions/crm");

    const result = await createProductAction(input);

    expect(result).toEqual({ ok: true, data: created });
    expect(mocks.createProduct).toHaveBeenCalledWith(input);
    expect(mocks.invalidate).toHaveBeenCalledTimes(2);
    expect(mocks.invalidate).toHaveBeenNthCalledWith(1, "products");
    expect(mocks.invalidate).toHaveBeenNthCalledWith(2, "products");
  });
});
