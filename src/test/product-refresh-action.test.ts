import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireActionUser: vi.fn(),
  listProducts: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  requireActionUser: mocks.requireActionUser,
}));
vi.mock("@/lib/crm", () => ({ crm: () => ({ listProducts: mocks.listProducts }) }));
vi.mock("@/lib/cache", () => ({
  getCachedValue: vi.fn(),
  invalidate: mocks.invalidate,
  setCachedValue: vi.fn(),
  withIdempotency: vi.fn(),
}));

describe("refreshProductsAction", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.requireActionUser.mockReset();
    mocks.listProducts.mockReset().mockResolvedValue([{ id: "p1", model: "Product" }]);
    mocks.invalidate.mockReset().mockResolvedValue(undefined);
  });

  it("rejects non-managers", async () => {
    mocks.requireActionUser.mockResolvedValue({ id: "caller-1", name: "Caller", role: "Calling Team" });
    const { refreshProductsAction } = await import("@/app/actions/crm");

    const result = await refreshProductsAction();

    expect(result).toMatchObject({ ok: false });
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.listProducts).not.toHaveBeenCalled();
  });

  it("invalidates the product cache before returning the refreshed list", async () => {
    mocks.requireActionUser.mockResolvedValue({ id: "manager-1", name: "Manager", role: "Manager" });
    const { refreshProductsAction } = await import("@/app/actions/crm");

    const result = await refreshProductsAction();

    expect(result).toMatchObject({ ok: true, data: [{ id: "p1", model: "Product" }] });
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith("products");
    expect(mocks.listProducts).toHaveBeenCalledOnce();
  });
});
