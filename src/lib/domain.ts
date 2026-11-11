/**
 * Pure business rules and types. No I/O, no framework imports, so it can be used
 * on the server, in client components and in unit tests.
 */
import { COMPANY } from "./company";

export type Role = "Calling Team" | "Sales Executive" | "Manager";
export type User = { id: string; name: string; role: Role; email?: string };

export type LeadStatus =
  | "Fresh Lead" | "Attempted to Contact" | "Callback in Future" | "Contacted"
  | "Junk Lead" | "Lost Lead" | "Not Contacted" | "Pre-Qualified"
  | "Not Qualified" | "Not Responsive" | "Assigned to Sales"
  | "Site Visit Scheduled" | "Quotation Sent" | "Won";
export const LEAD_STATUSES: LeadStatus[] = [
  "Fresh Lead", "Attempted to Contact", "Callback in Future", "Contacted",
  "Junk Lead", "Lost Lead", "Not Contacted", "Pre-Qualified", "Not Qualified",
  "Not Responsive", "Assigned to Sales", "Site Visit Scheduled", "Quotation Sent", "Won",
];
export type LeadSource = "Meta Ads" | "Google Ads" | "Direct Call" | "Walk-in" | "Referral" | "Website" | "Other";
export const LEAD_SOURCES: LeadSource[] = ["Meta Ads", "Google Ads", "Direct Call", "Walk-in", "Referral", "Website", "Other"];

export type LeadUpdate = { date: string; user: string; note: string };
export type CallOutcome = "Connected" | "No Answer" | "Busy" | "Wrong Number" | "Call Back Later";
export type CallActivity = { id: string; leadId: string; ownerId: string; date: string; outcome?: CallOutcome };
export type LeadCallSummary = { attempts: number; lastOutcome?: CallOutcome };

export function isUncalledLeadOlderThan(lead: Lead, callStats: LeadCallSummary | undefined, now: number): boolean {
  if (lead.status !== "Fresh Lead" || callStats?.attempts || callStats?.lastOutcome) return false;
  const createdAt = lead.createdAt
    ? Date.parse(lead.createdAt)
    : Date.parse(`${lead.createdOn}T00:00:00+05:30`);
  return Number.isFinite(createdAt) && now - createdAt >= 30 * 60 * 1000;
}

export const DEFAULT_NOT_RESPONSIVE_ATTEMPTS = 3;
export const LOST_REASONS = [
  "Price too high", "Chose competitor", "Project postponed", "Budget unavailable",
  "Product not suitable", "No response", "Other",
] as const;
export type LostReason = typeof LOST_REASONS[number];
export type LeadTimelineItem = {
  date: string; user: string; kind: "Call" | "Note" | "Task" | "Event" | "Quote" | "Visit"; title: string; detail: string;
};

export type Lead = {
  id: string;
  name: string;
  company: string;
  phone: string;
  email?: string;
  accountId?: string;
  area: string;
  source: LeadSource;
  status: LeadStatus;
  lostReason?: LostReason;
  assignedTo: string | null;
  assignedToId?: string;
  ownerId?: string;
  remarks: string;
  createdOn: string;
  createdAt?: string;
  /** Street address (used on site-visit cards). */
  address: string;
  /** Names of users who created / last modified the record (drives the "My Leads" tab). */
  touchedBy: string[];
  followUp?: string;
  followUpTime?: string;
};

export type LeadAssigneeOption = { id: string; name: string; label: string; isCurrent: boolean };

export function leadAssigneeOptions(
  members: readonly Pick<User, "id" | "name">[],
  currentOwnerId?: string | null,
): LeadAssigneeOption[] {
  return members.map((member) => {
    const isCurrent = !!currentOwnerId && String(member.id) === String(currentOwnerId);
    return {
      id: String(member.id),
      name: member.name,
      label: `${member.name}${isCurrent ? " (current)" : ""}`,
      isCurrent,
    };
  });
}

export function applyVisitOverrides(
  rows: Visit[],
  overrides: Map<string, Partial<Visit>>,
): Visit[] {
  return rows.map((visit) => {
    const override = overrides.get(visit.id);
    if (!override) return visit;
    const confirmed = Object.entries(override).every(([key, value]) =>
      value === undefined || Object.is(visit[key as keyof Visit], value),
    );
    if (confirmed) {
      overrides.delete(visit.id);
      return visit;
    }
    return { ...visit, ...override };
  });
}

export function applyLeadOverrides(
  rows: Lead[],
  overrides: Map<string, Partial<Lead> | null>,
): Lead[] {
  return rows.flatMap((lead) => {
    if (!overrides.has(lead.id)) return [lead];
    const override = overrides.get(lead.id);
    if (override === null) return [];
    if (!override) return [lead];
    const confirmed = Object.entries(override).every(([key, value]) =>
      value === undefined || Object.is(lead[key as keyof Lead], value),
    );
    if (confirmed) {
      overrides.delete(lead.id);
      return [lead];
    }
    return [{ ...lead, ...override }];
  });
}

export function quotationCustomers(leads: Lead[], query: string): Lead[] {
  const search = query.trim().toLowerCase();
  return leads.filter((lead) =>
    !search || [lead.name, lead.company, lead.phone, lead.area].some((value) => value.toLowerCase().includes(search)),
  );
}

export function canAdvanceLeadStatus(current: LeadStatus, target: "Site Visit Scheduled" | "Quotation Sent"): boolean {
  if (["Won", "Lost Lead", "Junk Lead", "Not Qualified"].includes(current)) return false;
  const rank: Partial<Record<LeadStatus, number>> = {
    "Fresh Lead": 0, "Attempted to Contact": 1, "Not Contacted": 1, Contacted: 2,
    "Pre-Qualified": 3, "Assigned to Sales": 4, "Site Visit Scheduled": 5, "Quotation Sent": 6, Won: 99,
  };
  return (rank[current] ?? 0) <= (rank[target] ?? 99);
}

export const leadLabel = (l: Lead) => (l.company ? `${l.name} (${l.company})` : l.name);
export const normalizePhone = (value: string): string => value.replace(/\D/g, "").slice(-10);

export type QuoteItem = { productId?: string; model: string; description?: string; unit: string; qty: number; price: number; discount?: number; taxRate?: number };
export type QuoteExtraCharge = { label: string; amount: number; taxRate?: number };
export type Quotation = {
  id: string;
  offerNo: string;
  revision?: number;
  leadId: string;
  customer: string;
  contactName?: string;
  company?: string;
  phone?: string;
  email?: string;
  area?: string;
  address?: string;
  subject?: string;
  validTill?: string;
  executive: string;
  total: number;
  date: string;
  status?: string;
  ownerId?: string;
  tax?: number;
  items?: QuoteItem[];
  gstBreakdown?: QuoteGstBreakdown;
  pdfSnapshotToken?: string;
  accountId?: string;
};
export type Invoice = {
  id: string;
  invoiceNo: string;
  quoteId: string;
  leadId: string;
  ownerId?: string;
  executive: string;
  customer: string;
  contactName: string;
  company: string;
  email?: string;
  phone: string;
  gstin?: string;
  date: string;
  status: string;
  total: number;
  items: QuoteItem[];
  gstBreakdown: QuoteGstBreakdown;
  pdfUrl?: string;
};
export type QuoteGstTotals = { subtotal: number; discount: number; gst: number; total: number };
export type QuoteGstRateTotal = { rate: number; taxableAmount: number; amount: number };
export type QuoteGstBreakdown = QuoteGstTotals & {
  rate: number;
  partAGstMode?: "included" | "extra";
  partA: QuoteGstTotals;
  partB: QuoteGstTotals;
  gstByRate?: QuoteGstRateTotal[];
  extraCharges?: QuoteExtraCharge[];
  zoho?: { subtotal: number; discount: number; tax: number; adjustment: number };
};

export type VisitStatus = "Assigned" | "In Progress" | "Completed";
export type NewVisit = {
  leadId: string;
  executive: string;
  type: string;
  isVisit: boolean;
  date: string;
  time: string;
  address?: string;
  nextAction: string;
  followUp?: string;
};

export type Visit = {
  id: string;
  module?: string;
  leadId: string;
  customer: string;
  phone?: string;
  address: string;
  area: string;
  executive: string;
  executiveId?: string;
  type: string;
  isVisit: boolean;
  date: string;
  time: string;
  status: VisitStatus;
  nextAction: string;
  followUp: string;
  notes: string;
  done: boolean;
};
export type WorkTab = "assigned" | "progress" | "upcoming" | "completed";

export function workTabsFor(user: User, visits: Visit[], today: string, executive = "all"): Record<WorkTab, Visit[]> {
  return {
    assigned: workForTab(user, visits, "assigned", today, executive),
    progress: workForTab(user, visits, "progress", today, executive),
    upcoming: workForTab(user, visits, "upcoming", today, executive),
    completed: workForTab(user, visits, "completed", today, executive),
  };
}

/** Items for a My Work tab. Executives only ever get their own; managers filter by executive ("all" = everyone). */
export function workForTab(user: User, visits: Visit[], tab: WorkTab, today: string, executive = "all"): Visit[] {
  const pool = user.role === "Sales Executive"
    ? visits.filter((v) => normalizeOwnerId(v.executiveId) === normalizeOwnerId(user.id) || (!v.executiveId && v.executive === user.name))
    : visits.filter((v) => executive === "all" || v.executive === executive);
  return pool.filter((v) =>
    tab === "assigned" ? v.status === "Assigned" && !(v.isVisit && v.date >= today)
    : tab === "progress" ? v.status === "In Progress" && !(v.isVisit && v.date >= today)
    : tab === "upcoming" ? v.isVisit && v.status !== "Completed" && v.date >= today
    : v.status === "Completed",
  ).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

export type Product = { id: string; model: string; code?: string; description?: string; price: number; unit: string; gstRate?: number };

export function uniqueProducts(products: readonly Product[]): Product[] {
  const seen = new Set<string>();
  return products.filter((product) => {
    const key = `${product.model.trim().toLowerCase()}|${product.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.model.localeCompare(b.model, undefined, { sensitivity: "base" }));
}

export function validateQuoteLine(qty: number, discount: number, price: number): string | null {
  if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) return "Quantity must be a positive whole number.";
  if (!Number.isFinite(discount) || discount < 0) return "Discount cannot be negative.";
  const lineAmount = qty * price;
  if (discount > lineAmount) return "Discount cannot exceed the line amount.";
  return null;
}

export const GST_RATE = COMPANY.gstRate;

const roundCurrency = (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100;

export function formatINR(n: number): string {
  return "Rs. " + n.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function quoteTotals(items: readonly QuoteItem[], extraCharges: readonly QuoteExtraCharge[] = []): QuoteGstTotals {
  const gross = roundCurrency(items.reduce((sum, item) => sum + item.qty * item.price, 0));
  const discount = roundCurrency(items.reduce((sum, item) =>
    sum + Math.min(item.qty * item.price, item.discount ?? 0), 0,
  ));
  const subtotal = gross;
  const gst = roundCurrency([
    ...items.map((item) => roundCurrency(Math.max(0, item.qty * item.price - (item.discount ?? 0)) * (item.taxRate ?? GST_RATE))),
    ...extraCharges.map((charge) => roundCurrency(charge.amount * (charge.taxRate ?? 0))),
  ].reduce((sum, amount) => sum + amount, 0));
  const charges = roundCurrency(extraCharges.reduce((sum, charge) => sum + charge.amount, 0));
  // Keep the GST/charge inclusion policy in this single composition step.
  return { subtotal, discount, gst, total: roundCurrency(subtotal - discount + gst + charges) };
}

export function quotationGstBreakdown(items: readonly QuoteItem[], extraCharges: readonly QuoteExtraCharge[] = []): QuoteGstBreakdown & {
  zoho: NonNullable<QuoteGstBreakdown["zoho"]>;
} {
  const equipment = items.filter((item) => !/^B\s*-\s*/i.test(item.model.trim()));
  const ancillary = items.filter((item) => /^B\s*-\s*/i.test(item.model.trim()));
  const partA = quoteTotals(equipment);
  const partB = quoteTotals(ancillary);
  const subtotal = roundCurrency(partA.subtotal + partB.subtotal);
  const discount = roundCurrency(partA.discount + partB.discount);
  const rateAmounts = new Map<number, { taxableAmount: number; amount: number }>();
  const addTax = (rate: number, taxableAmount: number) => {
    const current = rateAmounts.get(rate) ?? { taxableAmount: 0, amount: 0 };
    current.taxableAmount = roundCurrency(current.taxableAmount + taxableAmount);
    current.amount = roundCurrency(current.amount + roundCurrency(taxableAmount * rate));
    rateAmounts.set(rate, current);
  };
  for (const item of items) {
    addTax(item.taxRate ?? GST_RATE, Math.max(0, item.qty * item.price - (item.discount ?? 0)));
  }
  for (const charge of extraCharges) {
    if (charge.taxRate !== undefined) addTax(charge.taxRate, charge.amount);
  }
  const gstByRate = [...rateAmounts.entries()]
    .sort(([rateA], [rateB]) => rateA - rateB)
    .map(([rate, totals]) => ({ rate, ...totals }));
  const gst = roundCurrency(gstByRate.reduce((sum, group) => sum + group.amount, 0));
  const charges = roundCurrency(extraCharges.reduce((sum, charge) => sum + charge.amount, 0));
  const total = quoteTotals(items, extraCharges).total;
  return {
    subtotal,
    discount,
    gst,
    total,
    rate: GST_RATE,
    partAGstMode: COMPANY.partAGstMode,
    partA,
    partB,
    gstByRate,
    extraCharges: extraCharges.map((charge) => ({ ...charge })),
    zoho: { subtotal, discount, tax: gst, adjustment: charges },
  };
}

// ---------- Performance dashboard ----------

export type PerfRange = "week" | "month" | "lastMonth";
const pad = (n: number) => String(n).padStart(2, "0");
export const todayISO = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Calendar boundaries for a range, given today as YYYY-MM-DD. Weeks start on Monday. */
export function rangeDates(range: PerfRange, today: string): { from: string; to: string } {
  const d = new Date(`${today}T00:00:00`);
  if (range === "week") {
    const start = new Date(d);
    start.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return { from: todayISO(start), to: today };
  }
  if (range === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const last = new Date(d.getFullYear(), d.getMonth(), 0);
  return { from: todayISO(first), to: todayISO(last) };
}

export type PerfExecutive = { id: string; name: string; role: Role };
export type PerfRow = { name: string; leads: number; visits: number; quotes: number; won: number; conversion: number; open: number; inProgress: number; calls: number };

export const normalizeOwnerId = (id: unknown) => String(id ?? "").trim();

/** Everything the dashboard shows, for one date range. */
export function perfStats(
  leads: Lead[],
  quotes: Quotation[],
  visits: Visit[],
  range: PerfRange,
  today: string,
  executives: (PerfExecutive | string)[],
  viewer?: User,
  calls: CallActivity[] = [],
  customRange?: { from: string; to: string },
) {
  const { from, to } = customRange ?? rangeDates(range, today);
  const inR = (date: string) => date >= from && date <= to;
  const ls = leads.filter((l) => inR(l.createdOn));
  const qs = quotes.filter((q) => inR(q.date));
  const vs = visits.filter((v) => v.isVisit && inR(v.date));
  const ws = visits.filter((v) => inR(v.date));
  const cs = calls.filter((call) => inR(call.date.slice(0, 10)));
  const viewerId = normalizeOwnerId(viewer?.id);
  const viewerName = viewer?.name.trim();
  const scopedLeads = viewer?.role === "Sales Executive"
    ? ls.filter((lead) => normalizeOwnerId(lead.ownerId ?? lead.assignedToId) === viewerId ||
      (!lead.ownerId && !lead.assignedToId && lead.assignedTo === viewerName))
    : ls;
  const scopedQuotes = viewer?.role === "Sales Executive"
    ? qs.filter((quote) => normalizeOwnerId(quote.ownerId) === viewerId ||
      (!quote.ownerId && quote.executive === viewerName))
    : qs;
  const scopedVisits = viewer?.role === "Sales Executive"
    ? vs.filter((visit) => normalizeOwnerId(visit.executiveId) === viewerId ||
      (!visit.executiveId && visit.executive === viewerName))
    : vs;
  const scopedWork = viewer?.role === "Sales Executive"
    ? ws.filter((visit) => normalizeOwnerId(visit.executiveId) === viewerId ||
      (!visit.executiveId && visit.executive === viewerName))
    : ws;
  const scopedCalls = viewer?.role === "Sales Executive"
    ? cs.filter((call) => normalizeOwnerId(call.ownerId) === viewerId)
    : cs;
  const bySource = LEAD_SOURCES.map((source) => {
    const sourceLeads = scopedLeads.filter((lead) => lead.source === source);
    const won = sourceLeads.filter((lead) => lead.status === "Won").length;
    return { source, count: sourceLeads.length, won, conversion: sourceLeads.length ? Math.round((won / sourceLeads.length) * 100) : 0 };
  });
  const roster = executives.map((executive) =>
    typeof executive === "string" ? { id: "", name: executive, role: "Sales Executive" as const } : executive,
  );
  const visibleRoster = viewer?.role === "Sales Executive"
    ? roster.filter((executive) => normalizeOwnerId(executive.id) === normalizeOwnerId(viewer.id))
    : roster;
  const byId = new Map(visibleRoster.filter((executive) => executive.id).map((executive) => [normalizeOwnerId(executive.id), executive]));
  const byName = new Map(visibleRoster.map((executive) => [executive.name.trim(), executive]));
  const totals = new Map<string, PerfRow>();
  for (const executive of visibleRoster) {
    totals.set(executive.id ? normalizeOwnerId(executive.id) : executive.name, {
      name: executive.name, leads: 0, visits: 0, quotes: 0, won: 0, conversion: 0, open: 0, inProgress: 0, calls: 0,
    });
  }
  const other: PerfRow = { name: "Other / Unassigned", leads: 0, visits: 0, quotes: 0, won: 0, conversion: 0, open: 0, inProgress: 0, calls: 0 };
  const rowFor = (id: string | undefined, name: string | undefined) => {
    const executive = id ? byId.get(normalizeOwnerId(id)) : byName.get((name ?? "").trim());
    if (!executive) return other;
    const key = executive.id ? normalizeOwnerId(executive.id) : executive.name;
    const existing = totals.get(key) ?? { name: executive.name, leads: 0, visits: 0, quotes: 0, won: 0, conversion: 0, open: 0, inProgress: 0, calls: 0 };
    totals.set(key, existing);
    return existing;
  };
  for (const lead of scopedLeads) {
    const row = rowFor(lead.ownerId ?? lead.assignedToId, lead.assignedTo ?? undefined);
    row.leads++;
    if (lead.status === "Won") row.won++;
    else if (lead.status !== "Lost Lead" && lead.status !== "Junk Lead" && lead.status !== "Not Qualified") row.open++;
  }
  for (const visit of scopedVisits) {
    if (visit.status === "Completed") rowFor(visit.executiveId, visit.executive).visits++;
  }
  for (const visit of scopedWork) if (visit.status === "In Progress") rowFor(visit.executiveId, visit.executive).inProgress++;
  for (const quote of scopedQuotes) rowFor(quote.ownerId, quote.executive).quotes++;
  for (const call of scopedCalls) {
    const executive = visibleRoster.find((member) => normalizeOwnerId(member.id) === normalizeOwnerId(call.ownerId));
    rowFor(executive?.id, executive?.name).calls++;
  }
  for (const row of totals.values()) row.conversion = row.leads ? Math.round((row.won / row.leads) * 100) : 0;
  if (other.leads || other.visits || other.quotes || other.calls || other.inProgress) {
    other.conversion = other.leads ? Math.round((other.won / other.leads) * 100) : 0;
    totals.set("other", other);
  }
  const rows = [...totals.values()];
  const totalRow: PerfRow = {
    name: "Total",
    leads: scopedLeads.length,
    visits: scopedVisits.filter((v) => v.status === "Completed").length,
    quotes: scopedQuotes.length,
    won: scopedLeads.filter((lead) => lead.status === "Won").length,
    conversion: scopedLeads.length ? Math.round((scopedLeads.filter((lead) => lead.status === "Won").length / scopedLeads.length) * 100) : 0,
    open: [...scopedLeads].filter((lead) => lead.status !== "Won" && lead.status !== "Lost Lead" && lead.status !== "Junk Lead" && lead.status !== "Not Qualified").length,
    inProgress: scopedWork.filter((visit) => visit.status === "In Progress").length,
    calls: scopedCalls.length,
  };
  return {
    from, to,
    totalLeads: scopedLeads.length,
    won: scopedLeads.filter((lead) => lead.status === "Won").length,
    conversion: scopedLeads.length ? Math.round((scopedLeads.filter((lead) => lead.status === "Won").length / scopedLeads.length) * 100) : 0,
    bySource,
    scheduled: scopedVisits.length,
    completed: scopedVisits.filter((v) => v.status === "Completed").length,
    calls: scopedCalls.length,
    quotesSent: scopedQuotes.length,
    rows: viewer?.role === "Manager" || !viewer ? [...rows, totalRow] : rows,
    totalRow,
  };
}

export function summarizeLeadCalls(
  calls: readonly CallActivity[],
  leadId: string,
  maxAttempts = DEFAULT_NOT_RESPONSIVE_ATTEMPTS,
): LeadCallSummary {
  const forLead = calls.filter((call) => call.leadId === leadId && call.outcome)
    .sort((left, right) => right.date.localeCompare(left.date) ||
      (left.id === "pending" ? -1 : right.id === "pending" ? 1 : right.id.localeCompare(left.id, undefined, { numeric: true })));
  let attempts = 0;
  for (const call of forLead) {
    if (call.outcome === "No Answer" || call.outcome === "Busy") attempts++;
    else if (call.outcome === "Connected" || call.outcome === "Call Back Later") break;
  }
  return {
    attempts: Math.min(attempts, maxAttempts),
    ...(forLead[0]?.outcome ? { lastOutcome: forLead[0].outcome } : {}),
  };
}

export type Section = "home" | "leads" | "quotations" | "invoices" | "visits" | "performance";
export const ACCESS: Record<Role, Section[]> = {
  "Calling Team": ["leads"],
  "Sales Executive": ["leads", "quotations", "invoices", "visits"],
  Manager: ["leads", "quotations", "invoices", "visits", "performance"],
};

export function canAccess(role: Role, s: Section) {
  if (s === "home") return true;
  return ACCESS[role].includes(s);
}

/** Records a user may see: managers & calling team see all leads; executives only their own. */
export function visibleFor<T extends { assignedTo?: string | null; assignedToId?: string; ownerId?: string; executive?: string; executiveId?: string }>(user: User, rows: T[]): T[] {
  if (user.role !== "Sales Executive") return rows;
  return rows.filter((r) => normalizeOwnerId(r.ownerId) === normalizeOwnerId(user.id) || normalizeOwnerId(r.assignedToId) === normalizeOwnerId(user.id) || normalizeOwnerId(r.executiveId) === normalizeOwnerId(user.id) ||
    (!r.ownerId && !r.assignedToId && !r.executiveId && (r.assignedTo ?? r.executive) === user.name));
}

export function canUpdateWorkItem(user: User, visit: Visit): boolean {
  return user.role !== "Sales Executive" || visibleFor(user, [visit]).length > 0;
}

export type LeadTab = "fresh" | "assigned" | "callback" | "mine" | "all";
export type LeadBucket = "fresh" | "assigned" | "callback" | "other";
export type LeadTabCounts = Record<LeadTab, number>;

export function summarizeLeads(user: User, leads: Lead[], date = todayIST()) {
  const visible = visibleFor(user, leads);
  const tabs: LeadTab[] = ["fresh", "assigned", "callback", "mine", "all"];
  return {
    total: visible.length,
    tabCounts: Object.fromEntries(tabs.map((tab) => [tab, leadsForTab(user, visible, tab).length])) as LeadTabCounts,
    todaysFollowUps: leadsForTab(user, visible, "callback").filter((lead) => lead.followUp === date).length,
    hasAnyLeads: visible.length > 0,
  };
}

export function leadBucket(lead: Lead): LeadBucket {
  const hasAssignee = !!lead.assignedTo?.trim() || !!lead.assignedToId?.trim();
  const callingStatuses = new Set<LeadStatus>([
    "Fresh Lead", "Not Contacted", "Attempted to Contact", "Not Responsive", "Contacted",
  ]);
  if (callingStatuses.has(lead.status) && !hasAssignee) return "fresh";
  if (callingStatuses.has(lead.status) && hasAssignee) return "assigned";
  if (lead.status === "Assigned to Sales") return "assigned";
  if (lead.status === "Callback in Future") return "callback";
  return "other";
}

export type LeadFilters = {
  owner?: string;
  stage?: LeadStatus | "All";
  from?: string;
  to?: string;
};

function matchesLeadFilters(lead: Lead, search: string, source: LeadSource | "All", filters: LeadFilters): boolean {
  const q = search.trim().toLowerCase();
  if (source !== "All" && lead.source !== source) return false;
  if (filters.owner && filters.owner !== "All" && (lead.assignedTo ?? "Unassigned") !== filters.owner) return false;
  if (filters.stage && filters.stage !== "All" && lead.status !== filters.stage) return false;
  if (filters.from && lead.createdOn < filters.from) return false;
  if (filters.to && lead.createdOn > filters.to) return false;
  if (!q) return true;
  const textMatch = [lead.name, lead.company, lead.area, lead.id]
    .some((field) => field.toLowerCase().includes(q));
  const digits = search.replace(/\D/g, "");
  const phoneNeedle = digits.length > 10 ? digits.slice(-10) : digits;
  return textMatch || (!!phoneNeedle && normalizePhone(lead.phone).includes(phoneNeedle));
}

export function reassignLeadOptimistically(
  user: User,
  lead: Lead,
  assignee: Pick<User, "id" | "name">,
  tabCounts: Record<LeadTab, number>,
  search = "",
  source: LeadSource | "All" = "All",
  filters: LeadFilters = {},
): { lead: Lead; tabCounts: Record<LeadTab, number> } {
  const reassigned: Lead = {
    ...lead,
    assignedTo: assignee.name,
    assignedToId: String(assignee.id),
    ownerId: String(assignee.id),
    status: lead.status === "Fresh Lead" ? "Assigned to Sales" : lead.status,
  };
  const nextCounts = { ...tabCounts };
  for (const tab of ["fresh", "assigned", "callback", "mine", "all"] as const) {
    nextCounts[tab] = Math.max(0, nextCounts[tab] + leadTabMembership(user, reassigned, tab, search, source, filters) -
      leadTabMembership(user, lead, tab, search, source, filters));
  }
  return { lead: reassigned, tabCounts: nextCounts };
}

export function adjustLeadTabCounts(
  user: User,
  before: Lead | null,
  after: Lead | null,
  tabCounts: Record<LeadTab, number>,
  search = "",
  source: LeadSource | "All" = "All",
  filters: LeadFilters = {},
): Record<LeadTab, number> {
  const nextCounts = { ...tabCounts };
  for (const tab of ["fresh", "assigned", "callback", "mine", "all"] as const) {
    nextCounts[tab] = Math.max(0, nextCounts[tab] +
      leadTabMembership(user, after, tab, search, source, filters) -
      leadTabMembership(user, before, tab, search, source, filters));
  }
  return nextCounts;
}

function leadTabMembership(
  user: User, lead: Lead | null, tab: LeadTab, search: string, source: LeadSource | "All", filters: LeadFilters,
): number {
  return lead && leadsForTab(user, [lead], tab, search, source, filters).length ? 1 : 0;
}

/** Leads for a tab, after role visibility, search and source filter. */
export function leadsForTab(
  user: User, leads: Lead[], tab: LeadTab, search = "", source: LeadSource | "All" = "All", filters: LeadFilters = {},
): Lead[] {
  if (user.role === "Calling Team" && tab !== "fresh" && tab !== "callback") return [];
  if (tab === "fresh" && user.role === "Sales Executive") return [];
  if (tab === "all" && user.role !== "Manager") return [];
  return visibleFor(user, leads).filter((l) => {
    if (tab !== "all" && tab !== "mine" && leadBucket(l) !== tab) return false;
    if (tab === "mine" && !(
      l.ownerId === user.id ||
      l.assignedToId === user.id ||
      l.assignedTo === user.name ||
      (user.role === "Calling Team" && l.touchedBy.includes(user.name))
    )) return false;
    return matchesLeadFilters(l, search, source, filters);
  }).sort((a, b) => b.createdOn.localeCompare(a.createdOn));
}

export const canAssignLeads = (role: Role) => role === "Manager" || role === "Calling Team";
export function isAssignable(u: User, queueOwnerId?: string): boolean {
  return (u.role === "Sales Executive" || u.role === "Manager") &&
    normalizeOwnerId(u.id) !== normalizeOwnerId(queueOwnerId);
}

// ---------- Time and numbering helpers ----------

/** Today's date in India. Servers usually run in UTC, so never use the machine's local date for business logic. */
export const todayIST = (now = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

export const hourIST = (now = new Date()): number =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(now)) % 24;

/** Indian financial year suffix for a YYYY-MM-DD date, e.g. 2026-10-29 -> "26-27". */
export function financialYear(date: string): string {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}

/** Next offer number in the "NNN/YY-YY" format, continuing from the highest existing number this financial year. */
export function nextOfferNo(existing: string[], date: string, firstNumber?: number): string {
  const fy = financialYear(date);
  const nums = existing
    .map((o) => /^(\d+)\/(\d{2}-\d{2})$/.exec(o.trim()))
    .filter((m): m is RegExpExecArray => !!m && m[2] === fy)
    .map((m) => Number(m[1]));
  const configuredFirstNumber = Number(process.env.ATPL_FIRST_OFFER_NO);
  const startingNumber = firstNumber ?? (Number.isInteger(configuredFirstNumber) && configuredFirstNumber > 0 ? configuredFirstNumber : 239);
  return `${nums.length ? Math.max(...nums) + 1 : startingNumber}/${fy}`;
}

export const isExecutive = (u: User) => u.role === "Sales Executive";
