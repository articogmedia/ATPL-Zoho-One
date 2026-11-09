import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock("@/lib/cache", () => ({ invalidate: mocks.invalidate }));

describe("POST /api/webhooks/zoho-products", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.invalidate.mockReset().mockResolvedValue(undefined);
    process.env.ZOHO_WEBHOOK_SECRET = "test-webhook-secret";
  });

  it("rejects a missing or incorrect shared secret", async () => {
    const { POST } = await import("@/app/api/webhooks/zoho-products/route");
    const missing = await POST(new NextRequest("http://localhost/api/webhooks/zoho-products", { method: "POST" }));
    const incorrect = await POST(new NextRequest("http://localhost/api/webhooks/zoho-products", {
      method: "POST",
      headers: { "x-zoho-webhook-secret": "wrong-secret" },
    }));

    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("invalidates the product cache for a valid shared secret", async () => {
    const { POST } = await import("@/app/api/webhooks/zoho-products/route");
    const response = await POST(new NextRequest("http://localhost/api/webhooks/zoho-products", {
      method: "POST",
      headers: { "x-zoho-webhook-secret": "test-webhook-secret" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith("products");
  });
});
