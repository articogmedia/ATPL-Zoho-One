import { canAdvanceLeadStatus, DEFAULT_NOT_RESPONSIVE_ATTEMPTS, GST_RATE, nextOfferNo, quotationGstBreakdown, summarizeLeadCalls, todayIST, type CallActivity, type Invoice, type Lead, type LeadTimelineItem, type LeadUpdate, type Product, type Quotation, type Visit } from "@/lib/domain";
import { ASSIGNED_STAGE, CALL_STATUS_BY_OUTCOME } from "@/lib/zoho/fields";

export function advanceMockLeadStatus(lead: Lead, target: "Site Visit Scheduled" | "Quotation Sent"): boolean {
  if (!canAdvanceLeadStatus(lead.status, target)) return false;
  lead.status = target;
  return true;
}
import type { CrmRepository, LogCallInput, NewProduct } from "./repository";
import { isAssignable, normalizePhone } from "@/lib/domain";
import { env } from "@/lib/env";
import { MOCK_HISTORY, MOCK_LEADS, MOCK_PRODUCTS, MOCK_QUOTES, MOCK_USERS, MOCK_VISITS } from "./mock-data";

const today = () => new Date().toISOString().slice(0, 10);

type State = { leads: Lead[]; history: Record<string, LeadUpdate[]>; calls: CallActivity[]; quotes: Quotation[]; invoices: Invoice[]; visits: Visit[]; products: Product[] };
// Survive dev hot-reloads so demo edits are not lost on every file save.
const g = globalThis as unknown as { __atplMock?: State };
const state = (g.__atplMock ??= {
  leads: structuredClone(MOCK_LEADS),
  history: structuredClone(MOCK_HISTORY),
  calls: [],
  quotes: structuredClone(MOCK_QUOTES),
  invoices: [],
  visits: structuredClone(MOCK_VISITS),
  products: structuredClone(MOCK_PRODUCTS),
});
state.products ??= structuredClone(MOCK_PRODUCTS);
state.invoices ??= [];
state.calls ??= [];

const note = (id: string, user: string, text: string) => {
  (state.history[id] ??= []).unshift({ date: today(), user, note: text });
};

export const mockRepository: CrmRepository = {
  async listUsers() { return MOCK_USERS; },
  async findUserByEmail(email) { return MOCK_USERS.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null; },

  async listLeads() { return [...state.leads].sort((a, b) => b.createdOn.localeCompare(a.createdOn)); },
  async listLeadsPage(page, pageSize = 50, ownerId) {
    const leads = [...state.leads]
      .filter((lead) => !ownerId || String(lead.ownerId ?? lead.assignedToId ?? "") === ownerId)
      .sort((a, b) => b.createdOn.localeCompare(a.createdOn));
    const start = (Math.max(1, Math.floor(page)) - 1) * pageSize;
    return { leads: leads.slice(start, start + pageSize), total: leads.length, hasMore: leads.length > start + pageSize };
  },
  async listLeadSources() { return ["Meta Ads", "Google Ads", "Direct Call", "Walk-in", "Referral", "Website", "Other"]; },
  async searchLeads(query, page = 1) {
    const normalized = query.trim().toLowerCase();
    const matches = state.leads.filter((lead) =>
      [lead.name, lead.company, lead.phone, lead.area].some((value) => value.toLowerCase().includes(normalized)),
    ).sort((a, b) => b.createdOn.localeCompare(a.createdOn));
    const start = (Math.max(1, Math.floor(page)) - 1) * 200;
    return { leads: matches.slice(start, start + 200), hasMore: matches.length > start + 200 };
  },
  async getLead(id) { return state.leads.find((l) => l.id === id) ?? null; },
  async findLeadByPhone(phone) {
    const lead = state.leads.find((lead) => normalizePhone(lead.phone) === normalizePhone(phone));
    return lead ? { lead, matchedField: "Mobile" as const } : null;
  },
  async listAssignableUsers() { return MOCK_USERS.filter((u) => isAssignable(u, env().ZOHO_QUEUE_OWNER_ID)); },
  async createLead(input, actor, assignTo, forceCreate) {
    if (!forceCreate && state.leads.some((lead) => normalizePhone(lead.phone) === normalizePhone(input.phone))) {
      throw new Error("Duplicate lead");
    }
    const selfAssigned = actor.role === "Sales Executive";
    const assignee = assignTo ? MOCK_USERS.find((user) => String(user.id) === String(assignTo)) : undefined;
    if (assignTo && !assignee) throw new Error("The selected owner is not an active assignable team member.");
    const lead: Lead = {
      ...input, id: `L${101 + state.leads.length}`, status: selfAssigned || assignee ? "Assigned to Sales" : "Fresh Lead",
      assignedTo: (selfAssigned ? actor.name : assignee?.name) ?? null,
      assignedToId: selfAssigned ? actor.id : assignee?.id,
      ownerId: selfAssigned ? actor.id : assignee?.id,
      source: selfAssigned ? "Direct Call" : input.source,
      createdOn: today(), createdAt: new Date().toISOString(), address: "", touchedBy: [actor.name],
    };
    state.leads.unshift(lead);
    note(lead.id, actor.name, `Lead created from ${input.source}`);
    return lead;
  },
  async assignLead(id, assigneeId, actor) {
    const lead = state.leads.find((item) => item.id === id);
    if (!lead) throw new Error("Lead not found");
    const assignee = MOCK_USERS.find((user) => String(user.id) === String(assigneeId));
    if (!assignee) throw new Error("The selected owner is not an active assignable team member.");
    lead.assignedTo = assignee.name;
    lead.assignedToId = assignee.id;
    lead.ownerId = String(assignee.id);
    if (lead.status === "Fresh Lead") lead.status = ASSIGNED_STAGE;
    if (!lead.touchedBy.includes(actor.name)) lead.touchedBy.push(actor.name);
    note(id, actor.name, `Assigned to ${assignee.name} by ${actor.name}`);
    return { owner: assignee.name, ownerId: String(assignee.id), status: lead.status, taskCreated: true, warningCheckId: "" };
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
    if (p.lostReason !== undefined && p.lostReason !== l.lostReason) {
      l.lostReason = p.lostReason;
      if (p.lostReason) parts.push(`Lost reason: ${p.lostReason}`);
    }
    if (p.assignedTo !== undefined && p.assignedTo !== l.assignedTo) {
      parts.push(p.assignedTo ? `Assigned to ${p.assignedTo}` : "Unassigned");
      l.assignedTo = p.assignedTo;
      const assignee = p.assignedTo ? MOCK_USERS.find((user) => user.name === p.assignedTo) : undefined;
      l.assignedToId = assignee?.id;
      l.ownerId = assignee?.id;
    }
    if (p.remarks !== undefined && p.remarks.trim() !== l.remarks) {
      parts.push(p.remarks.trim() ? `"${p.remarks.trim()}"` : "Remarks cleared");
      l.remarks = p.remarks.trim();
    }
    if (p.followUp && p.followUp !== l.followUp) {
      l.followUp = p.followUp;
      parts.push(`Follow-up: ${p.followUp}`);
    }
    if (!l.touchedBy.includes(actor.name)) l.touchedBy.push(actor.name);
    if (parts.length) note(id, actor.name, parts.join(" · "));
  },
  async deleteLead(id) {
    const index = state.leads.findIndex((l) => l.id === id);
    if (index < 0) throw new Error("Lead not found");
    state.leads.splice(index, 1);
  },
  async getLeadHistory(id) { return state.history[id] ?? []; },
  async addLeadNote(id, title, content) {
    note(id, "Portal", `${title}: ${content}`);
  },
  async getLeadTimeline(id): Promise<LeadTimelineItem[]> {
    const timeline: LeadTimelineItem[] = [
      ...(state.history[id] ?? []).map((item) => ({
        date: item.date, user: item.user, kind: "Note" as const, title: "Note", detail: item.note,
      })),
      ...state.calls.filter((call) => call.leadId === id).map((call) => ({
        date: call.date.slice(0, 10),
        user: MOCK_USERS.find((member) => member.id === call.ownerId)?.name ?? "",
        kind: "Call" as const,
        title: call.outcome ?? "Call",
        detail: "",
      })),
      ...state.quotes.filter((quote) => quote.leadId === id).map((quote) => ({
        date: quote.date,
        user: quote.executive,
        kind: "Quote" as const,
        title: `Quotation ${quote.offerNo}`,
        detail: `${quote.status ?? "Draft"} · Rs. ${quote.total.toFixed(2)}`,
      })),
      ...state.visits.filter((visit) => visit.leadId === id && visit.isVisit).map((visit) => ({
        date: visit.date,
        user: visit.executive,
        kind: "Visit" as const,
        title: `${visit.type} · ${visit.status}`,
        detail: [visit.address, visit.nextAction].filter(Boolean).join(" · "),
      })),
    ];
    return timeline.sort((left, right) => right.date.localeCompare(left.date));
  },
  async logCall(input: LogCallInput, actor) {
    const lead = state.leads.find((item) => item.id === input.leadId);
    if (!lead) throw new Error("Lead not found");
    state.calls.push({ id: `mock-call-${state.calls.length + 1}`, leadId: lead.id, ownerId: actor.id, date: new Date().toISOString(), outcome: input.outcome });
    const threshold = input.notResponsiveAttempts ?? DEFAULT_NOT_RESPONSIVE_ATTEMPTS;
    const summary = summarizeLeadCalls(state.calls, lead.id, threshold);
    lead.status = input.outcome === "Wrong Number"
      ? lead.status
      : input.outcome === "No Answer" || input.outcome === "Busy"
        ? summary.attempts >= threshold ? "Not Responsive" : "Attempted to Contact"
        : CALL_STATUS_BY_OUTCOME[input.outcome];
    lead.followUp = input.followUp;
    lead.followUpTime = input.followUpTime;
    note(lead.id, actor.name, `Call: ${input.outcome}${input.remarks ? ` · ${input.remarks}` : ""}`);
    if (!lead.touchedBy.includes(actor.name)) lead.touchedBy.push(actor.name);
    return { attempts: summary.attempts, lastOutcome: summary.lastOutcome, status: lead.status };
  },
  async listCalls(): Promise<CallActivity[]> { return [...state.calls]; },

  async listProducts() { return state.products; },
  async createProduct(input: NewProduct) {
    const product: Product = {
      id: `mock-product-${state.products.length + 1}`,
      model: input.name,
      code: input.code,
      price: input.price,
      unit: input.unit,
      gstRate: input.gstRate,
    };
    state.products.push(product);
    return product;
  },
  async listQuotes() { return [...state.quotes].sort((a, b) => b.date.localeCompare(a.date)); },
  async listInvoiceCandidates() {
    const leadsById = new Map(state.leads.map((lead) => [lead.id, lead]));
    const quotes = state.quotes.filter((quote) => {
      const status = (quote.status ?? "").trim().toLowerCase();
      return status === "accepted" || status === "won" || leadsById.get(quote.leadId)?.status === "Won";
    });
    const leadIds = new Set(quotes.map((quote) => quote.leadId).filter(Boolean));
    return {
      quotes: [...quotes].sort((a, b) => b.date.localeCompare(a.date)),
      leads: state.leads.filter((lead) => leadIds.has(lead.id)),
    };
  },
  async suggestOfferNo() { return nextOfferNo(state.quotes.map((quote) => quote.offerNo), today()); },
  async listQuotesPage(page) {
    const quotes = [...state.quotes].sort((a, b) => b.date.localeCompare(a.date));
    const start = (Math.max(1, Math.floor(page)) - 1) * 200;
    return { quotes: quotes.slice(start, start + 200), hasMore: quotes.length > start + 200, count: quotes.length };
  },
  async countQuotes(ownerId) {
    const quotes = ownerId ? state.quotes.filter((quote) => quote.ownerId === ownerId) : state.quotes;
    return quotes.length;
  },
  async getQuote(id) {
    const quote = state.quotes.find((item) => item.id === id);
    if (!quote) return null;
    const lead = state.leads.find((item) => item.id === quote.leadId);
    return {
      ...quote,
      contactName: quote.contactName || lead?.name,
      company: quote.company || lead?.company,
      phone: quote.phone || lead?.phone,
      email: quote.email || lead?.email,
      area: quote.area || lead?.area,
      address: quote.address || lead?.address,
    };
  },
  async markQuoteSent(id) {
    const quote = state.quotes.find((item) => item.id === id);
    if (!quote) throw new Error("Quotation not found");
    quote.status = "Sent";
  },
  async createQuote(input, actor, executive) {
    const lead = state.leads.find((l) => l.id === input.leadId);
    if (!lead) throw new Error("Lead not found");
    const offerNo = nextOfferNo(state.quotes.map((quote) => quote.offerNo), today());
    const items = input.items.map((i) => {
      const p = state.products.find((x) => x.id === i.productId);
      if (!p) throw new Error("Unknown product");
      return {
        productId: p.id, model: p.model, description: p.description, unit: p.unit,
        qty: i.qty, price: p.price, discount: Math.min(p.price * i.qty, Math.max(0, i.discount)),
        taxRate: i.taxRate ?? p.gstRate ?? GST_RATE,
      };
    });
    const gstBreakdown = quotationGstBreakdown(items, input.extraCharges ?? []);
    const q: Quotation = {
      id: `Q${2001 + state.quotes.length}`, offerNo, leadId: lead.id,
      customer: lead.company || lead.name, contactName: lead.name,
      company: lead.company, phone: lead.phone, area: lead.area, address: lead.address,
      email: lead.email,
      executive, date: today(), total: gstBreakdown.total, status: "Draft", subject: input.subject, revision: 0, items,
      gstBreakdown,
    };
    state.quotes.unshift(q);
    note(lead.id, actor.name, `Quotation ${q.offerNo} created`);
    return q;
  },
  async updateQuote(id, input, actor) {
    const quote = state.quotes.find((item) => item.id === id);
    if (!quote) throw new Error("Quotation not found.");
    if (quote.leadId !== input.leadId) throw new Error("The customer cannot be changed while editing a quotation.");
    const lead = state.leads.find((item) => item.id === input.leadId);
    if (!lead) throw new Error("Lead not found.");
    const items = input.items.map((item) => {
      const product = state.products.find((candidate) => candidate.id === item.productId);
      if (!product) throw new Error("Unknown product.");
      return {
        productId: product.id,
        model: product.model,
        description: product.description,
        unit: product.unit,
        qty: item.qty,
        price: product.price,
        discount: Math.min(product.price * item.qty, Math.max(0, item.discount)),
        taxRate: item.taxRate ?? product.gstRate ?? GST_RATE,
      };
    });
    const extraCharges = input.extraCharges ?? [];
    const gstBreakdown = quotationGstBreakdown(items, extraCharges);
    const revision = (quote.revision ?? 0) + 1;
    Object.assign(quote, {
      revision,
      subject: input.subject?.trim() || quote.subject,
      total: gstBreakdown.total,
      items,
      gstBreakdown,
    });
    note(lead.id, actor.name, `Quotation ${quote.offerNo} revised R${revision}`);
    return { ...quote };
  },
  async listInvoices() {
    return [...state.invoices].sort((a, b) => b.date.localeCompare(a.date));
  },
  async getInvoice(id) {
    return state.invoices.find((invoice) => invoice.id === id) ?? null;
  },
  async createInvoice(quote, lead, actor, gstin) {
    const existing = state.invoices.find((invoice) => invoice.quoteId === quote.id);
    if (existing) return existing;
    const { nextInvoiceNumber } = await import("@/lib/invoice-number");
    const { invoiceSnapshot } = await import("@/lib/invoice-rules");
    const invoice: Invoice = {
      ...invoiceSnapshot(quote, lead, await nextInvoiceNumber(), actor, gstin, todayIST()),
      id: `INV${2001 + state.invoices.length}`,
    };
    state.invoices.unshift(invoice);
    note(lead.id, actor.name, `Invoice ${invoice.invoiceNo} created from quotation ${quote.offerNo}`);
    return invoice;
  },

  async listVisits() {
    return state.visits.map((visit) => ({
      ...visit,
      phone: state.leads.find((lead) => lead.id === visit.leadId)?.phone ?? "",
    }));
  },
  getVisitsWarning() { return null; },
  async getVisit(id) { return state.visits.find((v) => v.id === id) ?? null; },
  async createVisit(input, actor) {
    const lead = state.leads.find((l) => l.id === input.leadId);
    if (!lead) throw new Error("Lead not found");
    const visit = {
      id: `V${state.visits.length + 1}`, leadId: lead.id, customer: lead.company || lead.name,
      phone: lead.phone,
      email: lead.email,
      address: lead.address, area: lead.area, executive: input.executive, type: input.type,
      isVisit: input.isVisit, date: input.date, time: input.time, status: "Assigned",
      nextAction: input.nextAction, followUp: "", notes: "", done: false,
    } as Visit;
    state.visits.push(visit);
    note(lead.id, actor.name, `${input.isVisit ? "Site visit" : "Work"} scheduled: ${input.type} on ${input.date}`);
    if (input.isVisit) advanceMockLeadStatus(lead, "Site Visit Scheduled");
    return visit;
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
