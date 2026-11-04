import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const currentUser = vi.fn();
vi.mock("@/lib/auth/guard", () => ({ currentUser }));
vi.mock("@/lib/crm", () => ({ crm: vi.fn(() => ({ getLead: vi.fn(), listProducts: vi.fn(() => []) })) }));

describe("quotation PDF route", () => {
  beforeEach(() => currentUser.mockReset());

  it("rejects unauthenticated requests", async () => {
    currentUser.mockResolvedValue(null);
    const { POST } = await import("@/app/api/quotations/pdf/route");
    const request = new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({ leadId: "L1", offerNo: "239/26-27", subject: "Offer", items: [{ productId: "P1", qty: 1 }] }),
    });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("rejects client-supplied prices", async () => {
    currentUser.mockResolvedValue({ id: "U1", name: "User", role: "Manager" });
    const { POST } = await import("@/app/api/quotations/pdf/route");
    const request = new NextRequest("http://localhost/api/quotations/pdf", {
      method: "POST",
      body: JSON.stringify({
        leadId: "L1", offerNo: "239/26-27", subject: "Offer",
        items: [{ productId: "P1", qty: 1, price: 1 }],
      }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});
