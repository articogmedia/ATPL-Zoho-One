import { describe, expect, it } from "vitest";
import { canAccess, formatINR, isAssignable, visibleFor, ACCESS } from "@/lib/domain";
import { MOCK_LEADS as SAMPLE_LEADS, MOCK_USERS as USERS, MOCK_QUOTES as SAMPLE_QUOTES, MOCK_VISITS as SAMPLE_VISITS } from "@/lib/crm/mock-data";

const u = (id: string) => USERS.find((x) => x.id === id)!;

describe("access rules", () => {
  it("formats Indian numbers", () => expect(formatINR(467500)).toBe("Rs. 4,67,500"));
  it("calling team sees only leads", () => {
    expect(canAccess("Calling Team", "leads")).toBe(true);
    expect(canAccess("Calling Team", "quotations")).toBe(false);
    expect(canAccess("Calling Team", "visits")).toBe(false);
  });
  it("only managers see performance", () => {
    expect(canAccess("Sales Executive", "performance")).toBe(true);
    expect(canAccess("Manager", "performance")).toBe(true);
  });
  it("every role lands on home", () => {
    for (const role of ["Calling Team", "Sales Executive", "Manager"] as const) {
      expect(canAccess(role, "home")).toBe(true);
    }
  });
  it("calling team sees only the leads card", () => {
    const cards = ["home", ...ACCESS["Calling Team"]];
    expect(cards).toEqual(["home", "leads"]);
  });
  it("managers get the performance card on home", () => {
    expect(canAccess("Manager", "home")).toBe(true);
    expect(canAccess("Manager", "performance")).toBe(true);
    expect(canAccess("Sales Executive", "performance")).toBe(true);
  });
  it("executives see only their own leads", () => {
    expect(visibleFor(u("anil"), SAMPLE_LEADS).every((l) => l.assignedTo === "Anil")).toBe(true);
    expect(visibleFor(u("pavan"), SAMPLE_LEADS)).toHaveLength(SAMPLE_LEADS.length);
  });
  it("assigns to executives and managers but not the queue owner", () => {
    expect(isAssignable(u("anil"), "queue-owner")).toBe(true);
    expect(isAssignable(u("pavan"), "queue-owner")).toBe(true);
    expect(isAssignable({ id: "queue-owner", name: "Queue", role: "Manager" }, "queue-owner")).toBe(false);
  });
});

import { leadsForTab, canAssignLeads } from "@/lib/domain";
describe("manage leads", () => {
  it("fresh tab shows only unassigned Fresh Leads", () => {
    const r = leadsForTab(u("divya"), SAMPLE_LEADS, "fresh");
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((l) => l.status === "Fresh Lead" && !l.assignedTo)).toBe(true);
  });
  it("fresh tab excludes leads with an assigned owner id even without a display name", () => {
    const leads = [{ ...SAMPLE_LEADS[0], status: "Fresh Lead" as const, assignedTo: null, assignedToId: "owner-1" }] as typeof SAMPLE_LEADS;
    expect(leadsForTab(u("divya"), leads, "fresh")).toHaveLength(0);
  });
  it("assigned lead leaves Fresh but stays in All", () => {
    const leads = SAMPLE_LEADS.map((l) => (l.id === "L105" ? { ...l, assignedTo: "Ravi" } : l));
    expect(leadsForTab(u("divya"), leads, "fresh").some((l) => l.id === "L105")).toBe(false);
    expect(leadsForTab(u("divya"), leads, "mine", "Arjun").map((l) => l.id)).toEqual(["L105"]);
  });
  it("filters Assigned to Sales by role and owner", () => {
    const assigned = [
      { ...SAMPLE_LEADS[0]!, status: "Assigned to Sales" as const, assignedTo: "Ravi", assignedToId: "ravi-id" },
      { ...SAMPLE_LEADS[1]!, status: "Assigned to Sales" as const, assignedTo: "Anil", assignedToId: "anil-id" },
    ];
    expect(leadsForTab(u("pavan"), assigned, "assigned")).toHaveLength(2);
    expect(leadsForTab({ id: "ravi-id", name: "Ravi", role: "Sales Executive" }, assigned, "assigned").map((lead) => lead.assignedTo)).toEqual(["Ravi"]);
    expect(leadsForTab({ id: "ravi-id", name: "Ravi", role: "Sales Executive" }, assigned, "all")).toHaveLength(0);
    expect(leadsForTab({ id: "caller-id", name: "Caller", role: "Calling Team" }, assigned, "fresh")).toHaveLength(0);
  });
  it("applies owner, stage and date filters used by All Leads", () => {
    const lead = { ...SAMPLE_LEADS[0]!, assignedTo: "Ravi", status: "Contacted" as const, createdOn: "2026-10-20" };
    expect(leadsForTab(u("pavan"), [lead], "all", "", "All", {
      owner: "Ravi", stage: "Contacted", from: "2026-10-01", to: "2026-10-31",
    })).toHaveLength(1);
    expect(leadsForTab(u("pavan"), [lead], "all", "", "All", { owner: "Anil" })).toHaveLength(0);
  });
  it("only managers and calling team can assign", () => {
    expect(canAssignLeads("Manager")).toBe(true);
    expect(canAssignLeads("Calling Team")).toBe(false);
    expect(canAssignLeads("Sales Executive")).toBe(false);
  });
  it("executives see only their own leads in All", () => {
    expect(leadsForTab(u("ravi"), SAMPLE_LEADS, "all").every((l) => l.assignedTo === "Ravi")).toBe(true);
  });
  it("filters by source", () => {
    expect(leadsForTab(u("pavan"), SAMPLE_LEADS, "all", "", "Direct Call").every((l) => l.source === "Direct Call")).toBe(true);
  });
});

import { perfStats, rangeDates, type Lead, type PerfExecutive, type Quotation, type User, type Visit } from "@/lib/domain";
const EXECS = ["Anil", "Ravi"];
describe("performance dashboard", () => {
  it("computes calendar boundaries", () => {
    expect(rangeDates("month", "2026-10-29")).toEqual({ from: "2026-10-01", to: "2026-10-29" });
    expect(rangeDates("lastMonth", "2026-10-29")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(rangeDates("week", "2026-10-29")).toEqual({ from: "2026-10-26", to: "2026-10-29" });
  });
  const month = () => perfStats(SAMPLE_LEADS, SAMPLE_QUOTES, SAMPLE_VISITS, "month", "2026-10-29", EXECS);
  it("counts this month's leads and conversion", () => {
    const s = month();
    expect(s.totalLeads).toBe(11);
    expect(s.won).toBe(1);
    expect(s.conversion).toBe(9);
  });
  it("breaks leads down by source", () => {
    const s = month();
    expect(s.bySource.map((b) => b.count)).toEqual([5, 4, 2]);
  });
  it("counts site visits scheduled vs completed", () => {
    const s = month();
    expect(s.scheduled).toBe(4);
    expect(s.completed).toBe(2);
  });
  it("builds one row per executive with own numbers only", () => {
    const s = month();
    const ravi = s.rows.find((r) => r.name === "Ravi")!;
    expect(ravi.leads).toBe(4);
    expect(ravi.visits).toBe(1);
    expect(ravi.quotes).toBe(1);
    expect(ravi.won).toBe(1);
    expect(ravi.conversion).toBe(25);
    const anil = s.rows.find((r) => r.name === "Anil")!;
    expect(anil.leads).toBe(2);
    expect(anil.won).toBe(0);
  });
  it("last month uses September data", () => {
    const s = perfStats(SAMPLE_LEADS, SAMPLE_QUOTES, SAMPLE_VISITS, "lastMonth", "2026-10-29", EXECS);
    expect(s.totalLeads).toBe(2);
    expect(s.conversion).toBe(50);
    expect(s.scheduled).toBe(1);
    expect(s.completed).toBe(1);
  });
  it("keeps the full roster, puts unknown owners in Other, and totals match cards", () => {
    const roster: PerfExecutive[] = [
      { id: "1394515000000464001", name: "Reshma (Manager)", role: "Manager" },
      { id: "1394515000001147001", name: "Pavan", role: "Sales Executive" },
      { id: "1394515000001126001", name: "Sai Kiran", role: "Sales Executive" },
    ];
    const lead = (id: string, ownerId?: string, status: Lead["status"] = "Fresh Lead") =>
      ({ ...SAMPLE_LEADS[0], id, createdOn: "2026-10-10", ownerId, assignedTo: ownerId ? "Pavan" : null, status }) as Lead;
    const quote = { ...SAMPLE_QUOTES[0], id: "q-perf", date: "2026-10-10", ownerId: "1394515000001147001" } as Quotation;
    const visit = { ...SAMPLE_VISITS[0], id: "v-perf", date: "2026-10-10", isVisit: true, status: "Completed", executiveId: "1394515000001147001" } as Visit;
    const s = perfStats([lead("pavan-lead", " 1394515000001147001 ", "Won"), lead("unknown-lead", "unknown-id")], [quote], [visit], "month", "2026-10-29", roster);
    expect(s.rows.map((row) => row.name)).toEqual(["Reshma (Manager)", "Pavan", "Sai Kiran", "Other / Unassigned", "Total"]);
    expect(s.rows.find((row) => row.name === "Reshma (Manager)")?.leads).toBe(0);
    expect(s.totalLeads).toBe(s.totalRow.leads);
    expect(s.totalRow.leads).toBe(2);
  });
  it("scopes performance totals and rows to a Sales user", () => {
    const roster: PerfExecutive[] = [
      { id: "1394515000001147001", name: "Pavan", role: "Sales Executive" },
      { id: "1394515000001126001", name: "Sai Kiran", role: "Sales Executive" },
    ];
    const sales: User = { id: " 1394515000001147001 ", name: "Pavan", role: "Sales Executive" };
    const leads = [
      { ...SAMPLE_LEADS[0], createdOn: "2026-10-10", ownerId: "1394515000001147001" },
      { ...SAMPLE_LEADS[1], createdOn: "2026-10-10", ownerId: "1394515000001126001" },
    ] as Lead[];
    const s = perfStats(leads, [], [], "month", "2026-10-29", roster, sales);
    expect(s.rows.map((row) => row.name)).toEqual(["Pavan"]);
    expect(s.totalLeads).toBe(1);
    expect(s.rows.map((row) => row.name)).not.toContain("Sai Kiran");
  });
  it("scopes every Sales metric, including source, visits and quotations", () => {
    const sales = { id: "pavan-id", name: "Pavan", role: "Sales Executive" as const };
    const other = { id: "sai-id", name: "Sai Kiran", role: "Sales Executive" as const };
    const leads = [
      { ...SAMPLE_LEADS[0], ownerId: "pavan-id", source: "Meta Ads", createdOn: "2026-10-10" },
      { ...SAMPLE_LEADS[1], ownerId: "sai-id", source: "Google Ads", createdOn: "2026-10-10" },
    ] as Lead[];
    const quotes = [
      { ...SAMPLE_QUOTES[0], ownerId: "pavan-id", date: "2026-10-10" },
      { ...SAMPLE_QUOTES[1], ownerId: "sai-id", date: "2026-10-10" },
    ] as Quotation[];
    const visits = [
      { ...SAMPLE_VISITS[0], executiveId: "pavan-id", date: "2026-10-10", isVisit: true, status: "Completed" },
      { ...SAMPLE_VISITS[1], executiveId: "sai-id", date: "2026-10-10", isVisit: true, status: "Completed" },
    ] as Visit[];
    const stats = perfStats(leads, quotes, visits, "month", "2026-10-29", [sales, other], sales);
    expect(stats.totalLeads).toBe(1);
    expect(stats.bySource.map((item) => item.count)).toEqual([1, 0, 0]);
    expect(stats.quotesSent).toBe(1);
    expect(stats.scheduled).toBe(1);
    expect(stats.completed).toBe(1);
  });
  it("scopes Sales call counts to the logged-in owner", () => {
    const sales = { id: "1394515000001147001", name: "Pavan", role: "Sales Executive" as const };
    const stats = perfStats([], [], [], "month", "2026-10-29", [sales], sales, [
      { id: "c1", leadId: "l1", ownerId: "1394515000001147001", date: "2026-10-10" },
      { id: "c2", leadId: "l2", ownerId: "other", date: "2026-10-10" },
    ]);
    expect(stats.calls).toBe(1);
  });
});
