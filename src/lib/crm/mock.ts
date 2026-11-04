import { canAdvanceLeadStatus, quoteTotals, type CallActivity, type Lead, type LeadTimelineItem, type LeadUpdate, type Quotation, type Visit } from "@/lib/domain";
import { ASSIGNED_STAGE, CALL_STATUS_BY_OUTCOME } from "@/lib/zoho/fields";

export function advanceMockLeadStatus(lead: Lead, target: "Site Visit Scheduled" | "Quotation Sent"): boolean {
  if (!canAdvanceLeadStatus(lead.status, target)) return false;
  lead.status = target;
  return true;
}
import type { CrmRepository, LogCallInput } from "./repository";
import { isAssignable } from "@/lib/domain";
import { env } from "@/lib/env";
import { MOCK_HISTORY, MOCK_LEADS, MOCK_PRODUCTS, MOCK_QUOTES, MOCK_USERS, MOCK_VISITS } from "./mock-data";

const today = () => new Date().toISOString().slice(0, 10);

type State = { leads: Lead[]; history: Record<string, LeadUpdate[]>; quotes: Quotation[]; visits: Visit[] };
// Survive dev hot-reloads so demo edits are not lost on every file save.
const g = globalThis as unknown as { __atplMock?: State };
const state = (g.__atplMock ??= {
  leads: structuredClone(MOCK_LEADS),
  history: structuredClone(MOCK_HISTORY),
  quotes: structuredClone(MOCK_QUOTES),
  visits: structuredClone(MOCK_VISITS),
});

const note = (id: string, user: string, text: string) => {
  (state.history[id] ??= []).unshift({ date: today(), user, note: text });
};

export const mockRepository: CrmRepository = {
  async listUsers() { return MOCK_USERS; },
  async findUserByEmail(email) { return MOCK_USERS.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null; },

  async listLeads() { return [...state.leads].sort((a, b) => b.createdOn.localeCompare(a.createdOn)); },
  async getLead(id) { return state.leads.find((l) => l.id === id) ?? null; },
  async listAssignableUsers() { return MOCK_USERS.filter((u) => isAssignable(u, env().ZOHO_QUEUE_OWNER_ID)); },
  async createLead(input, actor, assignTo) {
    const selfAssigned = actor.role === "Sales Executive";
    const lead: Lead = {
      ...input, id: `L${101 + state.leads.length}`, status: selfAssigned ? "Assigned to Sales" : "Fresh Lead",
      assignedTo: selfAssigned ? actor.name : assignTo, assignedToId: selfAssigned ? actor.id : undefined,
      source: selfAssigned ? "Direct Call" : input.source,
      createdOn: today(), address: "", touchedBy: [actor.name],
    };
    state.leads.unshift(lead);
    note(lead.id, actor.name, `Lead created from ${input.source}`);
    return lead;
  },
  async assignLead(id, assignee, actor) {
    const lead = state.leads.find((item) => item.id === id);
    if (!lead) throw new Error("Lead not found");
    lead.assignedTo = assignee;
    if (lead.status === "Fresh Lead") lead.status = ASSIGNED_STAGE;
    if (!lead.touchedBy.includes(actor.name)) lead.touchedBy.push(actor.name);
    note(id, actor.name, `Assigned to ${assignee} by ${actor.name}`);
    return { owner: assignee, status: lead.status, taskCreated: true };
  },
  async fixAssignedLeads(actor) {
    if (actor.role !== "Manager") throw new Error("Only managers can fix assigned leads.");
    const stale = state.leads.filter((lead) => lead.status === "Fresh Lead" && !!lead.assignedTo);
    stale.forEach((lead) => { lead.status = ASSIGNED_STAGE; });
    return stale.length;
  },
  async listFixableAssignedLeads(actor) {
    if (actor.role !== "Manager") throw new Error("Only managers can inspect assigned leads.");
    return state.leads
      .filter((lead) => lead.status === "Fresh Lead" && !!lead.assignedTo)
      .map((lead) => ({ id: lead.id, name: lead.name, ownerName: lead.assignedTo ?? "" }));
  },
  async updateLead(id, p, actor) {
    const l = state.leads.find((x) => x.id === id);
    if (!l) throw new Error("Lead not found");
    const parts: string[] = [];
    if (p.name?.trim() && p.name.trim() !== l.name) { l.name = p.name.trim(); parts.push("Name updated"); }
    if (p.company !== undefined && p.company.trim() !== l.company) { l.company = p.company.trim(); parts.push("Company updated"); }
    if (p.phone?.trim() && p.phone.trim() !== l.phone) { l.phone = p.phone.trim(); parts.push("Phone updated"); }
    if (p.source && p.source !== l.source) { l.source = p.source; parts.push(`Source: ${p.source}`); }
    if (p.status && p.status !== l.status) { parts.push(`Result: ${p.status}`); l.status = p.status; }
    if (p.assignedTo !== undefined && p.assignedTo !== l.assignedTo) {
      parts.push(p.assignedTo ? `Assigned to ${p.assignedTo}` : "Unassigned");
      l.assignedTo = p.assignedTo;
    }
    if (p.remarks?.trim()) { parts.push(`"${p.remarks.trim()}"`); l.remarks = p.remarks.trim(); }
    if (!l.touchedBy.includes(actor.name)) l.touchedBy.push(actor.name);
    if (parts.length) note(id, actor.name, parts.join(" · "));
  },
  async deleteLead(id) {
    const index = state.leads.findIndex((l) => l.id === id);
    if (index < 0) throw new Error("Lead not found");
    state.leads.splice(index, 1);
  },
  async getLeadHistory(id) { return state.history[id] ?? []; },
  async getLeadTimeline(id): Promise<LeadTimelineItem[]> {
    return (state.history[id] ?? []).map((item) => ({
      date: item.date, user: item.user, kind: "Note" as const, title: "Note", detail: item.note,
    }));
  },
  async logCall(input: LogCallInput, actor) {
    const lead = state.leads.find((item) => item.id === input.leadId);
    if (!lead) throw new Error("Lead not found");
    lead.status = CALL_STATUS_BY_OUTCOME[input.outcome];
    lead.followUp = input.followUp;
    lead.followUpTime = input.followUpTime;
    note(lead.id, actor.name, `Call: ${input.outcome}${input.remarks ? ` · ${input.remarks}` : ""}`);
    if (!lead.touchedBy.includes(actor.name)) lead.touchedBy.push(actor.name);
  },
  async listCalls(): Promise<CallActivity[]> { return []; },

  async listProducts() { return MOCK_PRODUCTS; },
  async listQuotes() { return [...state.quotes].sort((a, b) => b.date.localeCompare(a.date)); },
  async createQuote(input, actor, executive) {
    const lead = state.leads.find((l) => l.id === input.leadId);
    if (!lead) throw new Error("Lead not found");
    const items = input.items.map((i) => {
      const p = MOCK_PRODUCTS.find((x) => x.id === i.productId);
      if (!p) throw new Error("Unknown product");
      return { model: p.model, unit: p.unit, qty: i.qty, price: p.price, discount: Math.min(p.price * i.qty, Math.max(0, i.discount)) };
    });
    const q: Quotation = {
      id: `Q${2001 + state.quotes.length}`, offerNo: input.offerNo, leadId: lead.id,
      customer: lead.company || lead.name, executive, date: today(), total: quoteTotals(items).total, status: "Draft",
    };
    state.quotes.unshift(q);
    note(lead.id, actor.name, `Quotation ${q.offerNo} created`);
    advanceMockLeadStatus(lead, "Quotation Sent");
    return q;
  },

  async listVisits() { return state.visits; },
  async getVisit(id) { return state.visits.find((v) => v.id === id) ?? null; },
  async createVisit(input, actor) {
    const lead = state.leads.find((l) => l.id === input.leadId);
    if (!lead) throw new Error("Lead not found");
    state.visits.push({
      id: `V${state.visits.length + 1}`, leadId: lead.id, customer: lead.company || lead.name,
      address: lead.address, area: lead.area, executive: input.executive, type: input.type,
      isVisit: input.isVisit, date: input.date, time: input.time, status: "Assigned",
      nextAction: input.nextAction, followUp: "", notes: "", done: false,
    });
    note(lead.id, actor.name, `${input.isVisit ? "Site visit" : "Work"} scheduled: ${input.type} on ${input.date}`);
    if (input.isVisit) advanceMockLeadStatus(lead, "Site Visit Scheduled");
  },
  async updateVisit(id, p) {
    const v = state.visits.find((x) => x.id === id);
    if (!v) throw new Error("Visit not found");
    if (p.status) v.status = p.status;
    if (p.notes) v.notes = p.notes;
    if (p.date) v.date = p.date;
    if (p.time) v.time = p.time;
    v.done = v.status === "Completed";
  },
};
