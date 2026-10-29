import { quoteTotals, type Lead, type LeadUpdate, type Quotation, type Visit } from "@/lib/domain";
import type { CrmRepository } from "./repository";
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
  async createLead(input, actor, assignTo) {
    const lead: Lead = {
      ...input, id: `L${101 + state.leads.length}`, status: "Fresh Lead", assignedTo: assignTo,
      createdOn: today(), address: "", touchedBy: [actor.name],
    };
    state.leads.unshift(lead);
    note(lead.id, actor.name, `Lead created from ${input.source}`);
    return lead;
  },
  async updateLead(id, p, actor) {
    const l = state.leads.find((x) => x.id === id);
    if (!l) throw new Error("Lead not found");
    const parts: string[] = [];
    if (p.status && p.status !== l.status) { parts.push(`Result: ${p.status}`); l.status = p.status; }
    if (p.assignedTo !== undefined && p.assignedTo !== l.assignedTo) {
      parts.push(p.assignedTo ? `Assigned to ${p.assignedTo}` : "Unassigned");
      l.assignedTo = p.assignedTo;
    }
    if (p.remarks?.trim()) { parts.push(`"${p.remarks.trim()}"`); l.remarks = p.remarks.trim(); }
    if (!l.touchedBy.includes(actor.name)) l.touchedBy.push(actor.name);
    if (parts.length) note(id, actor.name, parts.join(" · "));
  },
  async getLeadHistory(id) { return state.history[id] ?? []; },

  async listProducts() { return MOCK_PRODUCTS; },
  async listQuotes() { return [...state.quotes].sort((a, b) => b.date.localeCompare(a.date)); },
  async createQuote(input, actor, executive) {
    const lead = state.leads.find((l) => l.id === input.leadId);
    if (!lead) throw new Error("Lead not found");
    const items = input.items.map((i) => {
      const p = MOCK_PRODUCTS.find((x) => x.id === i.productId);
      if (!p) throw new Error("Unknown product");
      return { model: p.model, unit: p.unit, qty: i.qty, price: p.price };
    });
    const q: Quotation = {
      id: `Q${2001 + state.quotes.length}`, offerNo: input.offerNo, leadId: lead.id,
      customer: lead.company || lead.name, executive, date: today(), total: quoteTotals(items).total,
    };
    state.quotes.unshift(q);
    note(lead.id, actor.name, `Quotation ${q.offerNo} created`);
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
