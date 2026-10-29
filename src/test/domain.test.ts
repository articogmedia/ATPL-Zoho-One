import { describe, expect, it } from "vitest";
import { canAccess, formatINR, visibleFor, ACCESS } from "@/lib/domain";
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
    expect(canAccess("Sales Executive", "performance")).toBe(false);
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
    expect(canAccess("Sales Executive", "performance")).toBe(false);
  });
  it("executives see only their own leads", () => {
    expect(visibleFor(u("anil"), SAMPLE_LEADS).every((l) => l.assignedTo === "Anil")).toBe(true);
    expect(visibleFor(u("pavan"), SAMPLE_LEADS)).toHaveLength(SAMPLE_LEADS.length);
  });
});

import { leadsForTab, canAssignLeads } from "@/lib/domain";
describe("manage leads", () => {
  it("fresh tab shows only unassigned Fresh Leads", () => {
    const r = leadsForTab(u("divya"), SAMPLE_LEADS, "fresh");
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((l) => l.status === "Fresh Lead" && !l.assignedTo)).toBe(true);
  });
  it("assigned lead leaves Fresh but stays in All", () => {
    const leads = SAMPLE_LEADS.map((l) => (l.id === "L105" ? { ...l, assignedTo: "Ravi" } : l));
    expect(leadsForTab(u("divya"), leads, "fresh").some((l) => l.id === "L105")).toBe(false);
    expect(leadsForTab(u("divya"), leads, "all", "Arjun").map((l) => l.id)).toEqual(["L105"]);
  });
  it("only managers and calling team can assign", () => {
    expect(canAssignLeads("Manager")).toBe(true);
    expect(canAssignLeads("Calling Team")).toBe(true);
    expect(canAssignLeads("Sales Executive")).toBe(false);
  });
  it("executives see only their own leads in All", () => {
    expect(leadsForTab(u("ravi"), SAMPLE_LEADS, "all").every((l) => l.assignedTo === "Ravi")).toBe(true);
  });
  it("filters by source", () => {
    expect(leadsForTab(u("pavan"), SAMPLE_LEADS, "all", "", "Direct Call").every((l) => l.source === "Direct Call")).toBe(true);
  });
});

import { perfStats, rangeDates } from "@/lib/domain";
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
});
