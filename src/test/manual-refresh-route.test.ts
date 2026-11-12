import { beforeEach, describe, expect, it, vi } from "vitest";

const currentUser = vi.hoisted(() => vi.fn());
const invalidate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/auth/guard", () => ({ currentUser }));
vi.mock("@/lib/cache", () => ({ invalidate }));

describe("authenticated manual cache refresh", () => {
  beforeEach(() => {
    currentUser.mockReset();
    invalidate.mockClear();
  });

  const request = (section: string) => new Request("https://portal.example/api/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ section }),
  });

  it("requires a logged-in user", async () => {
    currentUser.mockResolvedValue(null);
    const { POST } = await import("@/app/api/refresh/route");
    const response = await POST(request("leads"));

    expect(response.status).toBe(401);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("invalidates only the selected page dependencies", async () => {
    currentUser.mockResolvedValue({ id: "manager-1", name: "Manager", role: "Manager" });
    const { POST } = await import("@/app/api/refresh/route");

    expect((await POST(request("leads"))).status).toBe(200);
    expect(invalidate).toHaveBeenLastCalledWith("leads", "users", "visits");
    expect((await POST(request("invoices"))).status).toBe(200);
    expect(invalidate).toHaveBeenLastCalledWith("invoices", "quotes", "leads");
  });

  it("enforces section access and rejects invalid sections", async () => {
    currentUser.mockResolvedValue({ id: "caller-1", name: "Caller", role: "Calling Team" });
    const { POST } = await import("@/app/api/refresh/route");
    const forbidden = await POST(request("invoices"));
    const invalid = await POST(request("contacts"));

    expect(forbidden.status).toBe(403);
    expect(invalid.status).toBe(400);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
