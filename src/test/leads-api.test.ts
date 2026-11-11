import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { leadsForTab, type Lead, type LeadTab, type User } from "@/lib/domain";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  listLeads: vi.fn(),
  listLeadsPage: vi.fn(),
  listCalls: vi.fn(),
  usePagedRepository: false,
}));

vi.mock("@/lib/auth/guard", () => ({ currentUser: mocks.currentUser }));
vi.mock("@/lib/crm", () => ({
  crm: () => ({
    listLeads: mocks.listLeads,
    listCalls: mocks.listCalls,
    ...(mocks.usePagedRepository ? { listLeadsPage: mocks.listLeadsPage } : {}),
  }),
}));

const tabs: LeadTab[] = ["fresh", "assigned", "callback", "mine", "all"];
const users: User[] = [
  { id: "manager-1", name: "Manager", role: "Manager" },
  { id: "caller-1", name: "Caller", role: "Calling Team" },
  { id: "exec-1", name: "Ana", role: "Sales Executive" },
];

const leads: Lead[] = [
  {
    id: "F1", name: "Fresh", company: "Company F", phone: "9000000001", area: "North",
    source: "Meta Ads", status: "Fresh Lead", assignedTo: null, ownerId: "manager-1",
    remarks: "", createdOn: "2026-11-04", address: "", touchedBy: ["Caller"],
  },
  {
    id: "A1", name: "Assigned manager", company: "Company A", phone: "9000000002", area: "North",
    source: "Google Ads", status: "Assigned to Sales", assignedTo: "Manager", assignedToId: "manager-1",
    ownerId: "manager-1", remarks: "", createdOn: "2026-11-03", address: "", touchedBy: ["Caller"],
  },
  {
    id: "A2", name: "Assigned executive", company: "Company B", phone: "9000000003", area: "South",
    source: "Direct Call", status: "Assigned to Sales", assignedTo: "Ana", assignedToId: "exec-1",
    ownerId: "exec-1", remarks: "", createdOn: "2026-11-02", address: "", touchedBy: ["Caller"],
  },
  {
    id: "C1", name: "Callback", company: "Company C", phone: "9000000004", area: "South",
    source: "Meta Ads", status: "Callback in Future", assignedTo: "Ana", assignedToId: "exec-1",
    ownerId: "exec-1", remarks: "", createdOn: "2026-11-01", address: "", touchedBy: ["Caller"],
  },
  {
    id: "W1", name: "Won manager", company: "Company W", phone: "9000000005", area: "East",
    source: "Google Ads", status: "Won", assignedTo: "Manager", ownerId: "manager-1",
    remarks: "", createdOn: "2026-10-31", address: "", touchedBy: [],
  },
  {
    id: "W2", name: "Won executive", company: "Company X", phone: "9000000006", area: "East",
    source: "Direct Call", status: "Won", assignedTo: "Ana", assignedToId: "exec-1",
    ownerId: "exec-1", remarks: "", createdOn: "2026-10-30", address: "", touchedBy: [],
  },
];

describe("GET /api/leads", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";
    mocks.currentUser.mockReset();
    mocks.listLeads.mockReset().mockResolvedValue(leads);
    mocks.listCalls.mockReset().mockResolvedValue([]);
    mocks.listLeadsPage.mockReset();
    mocks.usePagedRepository = false;
  });

  it.each(users.flatMap((user) => tabs.map((tab) => [user, tab] as const)))(
    "returns %s leads for the %s tab using shared visibility and tab rules",
    async (user, tab) => {
      mocks.currentUser.mockResolvedValue(user);
      const { GET } = await import("@/app/api/leads/route");
      const response = await GET(new NextRequest(`http://localhost/api/leads?tab=${tab}&page=1`));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.leads.map((lead: Lead) => lead.id)).toEqual(leadsForTab(user, leads, tab).map((lead) => lead.id));
      expect(body.total).toBe(leadsForTab(user, leads, tab).length);
      expect(body.tabCounts).toEqual(Object.fromEntries(tabs.map((id) => [id, leadsForTab(user, leads, id).length])));
      expect(mocks.listLeads).toHaveBeenCalledOnce();
    },
  );

  it("keeps tab counts based on all matching leads, not the requested page", async () => {
    const manyLeads = Array.from({ length: 51 }, (_, index) => ({ ...leads[0], id: `F${index + 1}` }));
    mocks.currentUser.mockResolvedValue(users[0]);
    mocks.listLeads.mockResolvedValue(manyLeads);
    const { GET } = await import("@/app/api/leads/route");

    const response = await GET(new NextRequest("http://localhost/api/leads?tab=fresh&page=2"));
    const body = await response.json();

    expect(body.leads).toHaveLength(1);
    expect(body.total).toBe(51);
    expect(body.tabCounts.fresh).toBe(51);
    expect(body.tabCounts.all).toBe(51);
  });

  it("returns no Fresh Leads to an executive through a direct API request", async () => {
    mocks.currentUser.mockResolvedValue(users[2]);
    mocks.usePagedRepository = true;
    mocks.listLeadsPage.mockResolvedValue({ leads, total: 6, hasMore: true });
    const { GET } = await import("@/app/api/leads/route");

    const response = await GET(new NextRequest("http://localhost/api/leads?tab=fresh&page=1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.leads).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
    expect(body.tabCounts.fresh).toBe(0);
    expect(body.tabCounts.all).toBe(0);
  });

  it("uses the requested page instead of loading the complete lead list", async () => {
    mocks.currentUser.mockResolvedValue(users[0]);
    mocks.usePagedRepository = true;
    mocks.listLeadsPage.mockResolvedValue({ leads: leads.slice(0, 2), total: leads.length, hasMore: true });
    const { GET } = await import("@/app/api/leads/route");

    const response = await GET(new NextRequest("http://localhost/api/leads?tab=all&page=1"));

    expect(response.status).toBe(200);
    expect(mocks.listLeadsPage).toHaveBeenCalledWith(1, 50, undefined);
    expect(mocks.listLeads).not.toHaveBeenCalled();
  });
});
