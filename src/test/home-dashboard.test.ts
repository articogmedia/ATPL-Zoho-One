import { describe, expect, it } from "vitest";
import type { Lead, Quotation, User, Visit } from "@/lib/domain";
import { managerMonthSummary, todaySummary } from "@/lib/home-dashboard";

const pavan: User = { id: "pavan-id", name: "Pavan", role: "Sales Executive" };
const lead = (overrides: Partial<Lead>): Lead => ({
  id: "lead-1",
  name: "Customer",
  company: "",
  phone: "9000000000",
  area: "Hyderabad",
  source: "Website",
  status: "Assigned to Sales",
  assignedTo: "Pavan",
  assignedToId: pavan.id,
  remarks: "",
  createdOn: "2026-11-11",
  address: "",
  touchedBy: [],
  ...overrides,
});
const visit = (overrides: Partial<Visit>): Visit => ({
  id: "visit-1",
  leadId: "lead-1",
  customer: "Customer",
  address: "",
  area: "Hyderabad",
  executive: "Pavan",
  executiveId: pavan.id,
  type: "Site visit",
  isVisit: true,
  date: "2026-11-11",
  time: "10:00",
  status: "Assigned",
  nextAction: "",
  followUp: "",
  notes: "",
  done: false,
  ...overrides,
});
const quote = (overrides: Partial<Quotation>): Quotation => ({
  id: "quote-1",
  offerNo: "1/26-27",
  leadId: "lead-1",
  customer: "Customer",
  executive: "Pavan",
  total: 100,
  date: "2026-11-11",
  status: "Sent",
  ...overrides,
});

describe("home dashboard summaries", () => {
  it("scopes executive follow-ups, today's visits, and newly assigned leads to the current user", () => {
    const otherLead = lead({ id: "other", assignedTo: "Sai Kiran", assignedToId: "sai-id", followUp: "2026-11-11" });
    const result = todaySummary(pavan, [
      lead({ followUp: "2026-11-10" }),
      lead({ id: "future", followUp: "2026-11-12" }),
      lead({ id: "won", status: "Won", followUp: "2026-11-10" }),
      otherLead,
    ], [
      visit({}),
      visit({ id: "other-visit", executive: "Sai Kiran", executiveId: "sai-id" }),
      visit({ id: "done-visit", done: true }),
      visit({ id: "task", isVisit: false }),
    ], "2026-11-11");

    expect(result).toEqual({ kind: "executive", followUpsDue: 1, visitsToday: 1, newAssignedLeads: 2 });
  });

  it("uses Fresh Lead status for the Calling Team's uncalled count", () => {
    const calling: User = { id: "calling", name: "Calling Team", role: "Calling Team" };
    const leads = [
      lead({ id: "uncalled", status: "Fresh Lead", assignedTo: null, assignedToId: undefined, ownerId: undefined }),
      lead({ id: "called", status: "Attempted to Contact", assignedTo: null, assignedToId: undefined, ownerId: undefined }),
      lead({ id: "not-fresh", status: "Attempted to Contact", assignedTo: null, assignedToId: undefined, ownerId: undefined }),
    ];
    expect(todaySummary(calling, leads, [], "2026-11-11")).toEqual({
      kind: "calling",
      freshUncalledLeads: 1,
    });
  });

  it("summarizes monthly leads, conversion, and sent quotes while excluding drafts and other months", () => {
    const leads = [
      lead({ id: "won", status: "Won" }),
      lead({ id: "open", status: "Assigned to Sales" }),
      lead({ id: "older", createdOn: "2026-10-31", status: "Won" }),
    ];
    const quotes = [
      quote({ id: "sent" }),
      quote({ id: "draft", status: "Draft" }),
      quote({ id: "older", date: "2026-10-31" }),
    ];

    expect(managerMonthSummary(leads, quotes, "2026-11-11")).toEqual({
      leads: 2,
      conversion: 50,
      quotesSent: 1,
    });
  });
});
