import { beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/cache", () => ({ invalidate }));

describe("Zoho records webhook", () => {
  beforeEach(() => {
    invalidate.mockClear();
    process.env.ZOHO_WEBHOOK_SECRET = "webhook-secret-test-value";
  });

  const request = (body: string, secret = "webhook-secret-test-value") =>
    new Request("https://portal.example/api/webhooks/zoho-records", {
      method: "POST",
      headers: { "content-type": "application/json", "x-zoho-webhook-secret": secret },
      body,
    });

  it("rejects absent and incorrect secrets without invalidating or logging them", async () => {
    const { POST } = await import("@/app/api/webhooks/zoho-records/route");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const missing = await POST(new Request("https://portal.example/api/webhooks/zoho-records", {
      method: "POST",
      body: JSON.stringify({ module: "Leads" }),
    }));
    const incorrect = await POST(request(JSON.stringify({ module: "Leads" }), "different-secret"));

    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(invalidate).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it.each([
    ["Leads", ["leads", "users", "visits"]],
    ["Quotes", ["quotes", "invoices"]],
    ["Invoices", ["invoices"]],
    ["Tasks", ["visits"]],
    ["Products", ["products"]],
  ])("invalidates the %s dependencies", async (moduleName, prefixes) => {
    const { POST } = await import("@/app/api/webhooks/zoho-records/route");
    const response = await POST(request(JSON.stringify({ module: moduleName })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(...prefixes);
  });

  it("returns 400 for malformed JSON and unknown module names", async () => {
    const { POST } = await import("@/app/api/webhooks/zoho-records/route");
    const malformed = await POST(request("{"));
    const unknown = await POST(request(JSON.stringify({ module: "Contacts" })));

    expect(malformed.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
