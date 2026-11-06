import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), searchLeads: vi.fn(), listLeads: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/guard", () => ({ currentUser: mocks.currentUser }));
vi.mock("@/lib/crm", () => ({ crm: () => ({ searchLeads: mocks.searchLeads, listLeads: mocks.listLeads }) }));

const lead = (id: string, ownerId: string) => ({
  id, name: id, company: "", phone: "9876543210", area: "", source: "Direct Call" as const,
  status: "Assigned to Sales" as const, assignedTo: ownerId, assignedToId: ownerId, ownerId,
  remarks: "", createdOn: "2026-11-06", address: "", touchedBy: [],
});

beforeEach(() => {
  mocks.currentUser.mockReset();
  mocks.searchLeads.mockReset();
  mocks.listLeads.mockReset();
});

describe("customer search endpoint", () => {
  it("does not call CRM until the query has at least two characters", async () => {
    mocks.currentUser.mockResolvedValue({ id: "manager", name: "Manager", role: "Manager" });
    const { GET } = await import("@/app/api/leads/search/route");

    const response = await GET(new NextRequest("http://localhost/api/leads/search?q=a"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ leads: [], hasMore: false });
    expect(mocks.searchLeads).not.toHaveBeenCalled();
  });

  it("returns only leads visible to the signed-in sales executive", async () => {
    mocks.currentUser.mockResolvedValue({ id: "exec-1", name: "Sai Kiran", role: "Sales Executive" });
    mocks.searchLeads.mockResolvedValue({ leads: [lead("mine", "exec-1"), lead("other", "exec-2")], hasMore: false });
    const { GET } = await import("@/app/api/leads/search/route");

    const response = await GET(new NextRequest("http://localhost/api/leads/search?q=ac"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ leads: [{ id: "mine" }] });
    expect(mocks.searchLeads).toHaveBeenCalledWith("ac", 1);
  });

  it("serves the next 100 visible customers from the cached list", async () => {
    mocks.currentUser.mockResolvedValue({ id: "manager", name: "Manager", role: "Manager" });
    mocks.listLeads.mockResolvedValue(Array.from({ length: 205 }, (_, index) => lead(`lead-${index + 1}`, "exec-1")));
    const { GET } = await import("@/app/api/leads/search/route");

    const response = await GET(new NextRequest("http://localhost/api/leads/search?page=2"));

    expect(response.status).toBe(200);
    const body = await response.json() as { leads: { id: string }[]; hasMore: boolean };
    expect(body.leads).toHaveLength(100);
    expect(body.leads[0]?.id).toBe("lead-101");
    expect(body.leads.at(-1)?.id).toBe("lead-200");
    expect(body.hasMore).toBe(true);
    expect(mocks.listLeads).toHaveBeenCalledTimes(1);
    expect(mocks.searchLeads).not.toHaveBeenCalled();
  });
});
