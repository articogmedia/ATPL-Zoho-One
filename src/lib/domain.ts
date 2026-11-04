/**
 * Pure business rules and types. No I/O, no framework imports, so it can be used
 * on the server, in client components and in unit tests.
 */
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
export type LeadSource = "Meta Ads" | "Google Ads" | "Direct Call";
export const LEAD_SOURCES: LeadSource[] = ["Meta Ads", "Google Ads", "Direct Call"];

export type LeadUpdate = { date: string; user: string; note: string };
export type CallOutcome = "Connected" | "No Answer" | "Busy" | "Wrong Number" | "Call Back Later";
export type CallActivity = { id: string; leadId: string; ownerId: string; date: string };
export type LeadTimelineItem = {
  date: string; user: string; kind: "Call" | "Note" | "Task"; title: string; detail: string;
};

export type Lead = {
  id: string;
  name: string;
  company: string;
  phone: string;
  area: string;
  source: LeadSource;
  status: LeadStatus;
  assignedTo: string | null;
  assignedToId?: string;
  ownerId?: string;
  remarks: string;
  createdOn: string;
  /** Street address (used on site-visit cards). */
  address: string;
  /** Names of users who created / last modified the record (drives the "My Leads" tab). */
  touchedBy: string[];
  followUp?: string;
  followUpTime?: string;
};

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

export type QuoteItem = { model: string; unit: string; qty: number; price: number; discount?: number };
export type Quotation = {
  id: string;
  offerNo: string;
  leadId: string;
  customer: string;
  executive: string;
  total: number;
  date: string;
  status?: string;
  ownerId?: string;
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

/** Items for a My Work tab. Executives only ever get their own; managers filter by executive ("all" = everyone). */
export function workForTab(user: User, visits: Visit[], tab: WorkTab, today: string, executive = "all"): Visit[] {
  const pool = user.role === "Sales Executive"
    ? visits.filter((v) => normalizeOwnerId(v.executiveId) === normalizeOwnerId(user.id) || (!v.executiveId && v.executive === user.name))
    : visits.filter((v) => executive === "all" || v.executive === executive);
  return pool.filter((v) =>
    tab === "assigned" ? v.status === "Assigned"
    : tab === "progress" ? v.status === "In Progress"
    : tab === "upcoming" ? v.isVisit && v.status !== "Completed" && v.date >= today
    : v.status === "Completed",
  ).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

export type Product = { id: string; model: string; description?: string; price: number; unit: string };

/** GST is shown as Rs 0 until ATPL confirms GST invoicing scope (see plan section 12). */
export const GST_RATE = 0;

export function formatINR(n: number): string {
  return "Rs. " + Math.round(n).toLocaleString("en-IN");
}

export function quoteTotals(items: QuoteItem[]) {
  const subtotal = items.reduce((s, i) => s + i.qty * i.price, 0);
  const discount = items.reduce((s, i) => s + Math.min(i.qty * i.price, i.discount ?? 0), 0);
  const taxable = subtotal - discount;
  const gst = Math.round(taxable * GST_RATE);
  return { subtotal, discount, gst, total: taxable + gst };
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
export type PerfRow = { name: string; leads: number; visits: number; quotes: number; won: number; conversion: number };

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
) {
  const { from, to } = rangeDates(range, today);
  const inR = (date: string) => date >= from && date <= to;
  const ls = leads.filter((l) => inR(l.createdOn));
  const qs = quotes.filter((q) => inR(q.date));
  const vs = visits.filter((v) => v.isVisit && inR(v.date));
  const cs = calls.filter((call) => inR(call.date));
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
  const scopedCalls = viewer?.role === "Sales Executive"
    ? cs.filter((call) => normalizeOwnerId(call.ownerId) === viewerId)
    : cs;
  const bySource = LEAD_SOURCES.map((source) => ({ source, count: scopedLeads.filter((l) => l.source === source).length }));
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
      name: executive.name, leads: 0, visits: 0, quotes: 0, won: 0, conversion: 0,
    });
  }
  const other: PerfRow = { name: "Other / Unassigned", leads: 0, visits: 0, quotes: 0, won: 0, conversion: 0 };
  const rowFor = (id: string | undefined, name: string | undefined) => {
    const executive = id ? byId.get(normalizeOwnerId(id)) : byName.get((name ?? "").trim());
    if (!executive) return other;
    const key = executive.id ? normalizeOwnerId(executive.id) : executive.name;
    const existing = totals.get(key) ?? { name: executive.name, leads: 0, visits: 0, quotes: 0, won: 0, conversion: 0 };
    totals.set(key, existing);
    return existing;
  };
  for (const lead of scopedLeads) {
    const row = rowFor(lead.ownerId ?? lead.assignedToId, lead.assignedTo ?? undefined);
    row.leads++;
    if (lead.status === "Won") row.won++;
  }
  for (const visit of scopedVisits) {
    if (visit.status === "Completed") rowFor(visit.executiveId, visit.executive).visits++;
  }
  for (const quote of scopedQuotes) rowFor(quote.ownerId, quote.executive).quotes++;
  for (const row of totals.values()) row.conversion = row.leads ? Math.round((row.won / row.leads) * 100) : 0;
  if (other.leads || other.visits || other.quotes) {
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

export type Section = "home" | "leads" | "quotations" | "visits" | "performance";
export const ACCESS: Record<Role, Section[]> = {
  "Calling Team": ["leads"],
  "Sales Executive": ["leads", "quotations", "visits", "performance"],
  Manager: ["leads", "quotations", "visits", "performance"],
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

export type LeadTab = "fresh" | "assigned" | "callback" | "mine" | "all";
export type LeadBucket = "fresh" | "assigned" | "callback" | "other";

export function leadBucket(lead: Lead): LeadBucket {
  const hasAssignee = !!lead.assignedTo?.trim() || !!lead.assignedToId?.trim();
  if (lead.status === "Fresh Lead" && !hasAssignee) return "fresh";
  if (lead.status === "Fresh Lead" && hasAssignee) return "assigned";
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

/** Leads for a tab, after role visibility, search and source filter. */
export function leadsForTab(
  user: User, leads: Lead[], tab: LeadTab, search = "", source: LeadSource | "All" = "All", filters: LeadFilters = {},
): Lead[] {
  if (tab === "fresh" && user.role === "Sales Executive") return [];
  if (tab === "all" && user.role !== "Manager") return [];
  const q = search.trim().toLowerCase();
  return visibleFor(user, leads).filter((l) => {
    if (tab !== "all" && tab !== "mine" && leadBucket(l) !== tab) return false;
    if (tab === "mine" && !(
      l.ownerId === user.id ||
      l.assignedToId === user.id ||
      l.assignedTo === user.name ||
      (user.role === "Calling Team" && l.touchedBy.includes(user.name))
    )) return false;
    if (source !== "All" && l.source !== source) return false;
    if (filters.owner && filters.owner !== "All" && (l.assignedTo ?? "Unassigned") !== filters.owner) return false;
    if (filters.stage && filters.stage !== "All" && l.status !== filters.stage) return false;
    if (filters.from && l.createdOn < filters.from) return false;
    if (filters.to && l.createdOn > filters.to) return false;
    if (q && ![l.name, l.company, l.phone.replace(/\s/g, ""), l.phone, l.id].some((f) => f.toLowerCase().includes(q))) return false;
    return true;
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
