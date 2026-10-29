/**
 * Pure business rules and types. No I/O, no framework imports, so it can be used
 * on the server, in client components and in unit tests.
 */
export type Role = "Calling Team" | "Sales Executive" | "Manager";
export type User = { id: string; name: string; role: Role; email?: string };

export type LeadStatus =
  | "Fresh Lead" | "Attempted to Contact" | "Callback in Future" | "Contacted"
  | "Site Visit Scheduled" | "Quotation Sent" | "Won" | "Lost";
export const LEAD_STATUSES: LeadStatus[] = [
  "Fresh Lead", "Attempted to Contact", "Callback in Future", "Contacted",
  "Site Visit Scheduled", "Quotation Sent", "Won", "Lost",
];
export type LeadSource = "Meta Ads" | "Google Ads" | "Direct Call";
export const LEAD_SOURCES: LeadSource[] = ["Meta Ads", "Google Ads", "Direct Call"];

export type LeadUpdate = { date: string; user: string; note: string };

export type Lead = {
  id: string;
  name: string;
  company: string;
  phone: string;
  area: string;
  source: LeadSource;
  status: LeadStatus;
  assignedTo: string | null;
  remarks: string;
  createdOn: string;
  /** Street address (used on site-visit cards). */
  address: string;
  /** Names of users who created / last modified the record (drives the "My Leads" tab). */
  touchedBy: string[];
};

export const leadLabel = (l: Lead) => (l.company ? `${l.name} (${l.company})` : l.name);

export type QuoteItem = { model: string; unit: string; qty: number; price: number };
export type Quotation = {
  id: string;
  offerNo: string;
  leadId: string;
  customer: string;
  executive: string;
  total: number;
  date: string;
};

export type VisitStatus = "Assigned" | "In Progress" | "Completed";
export type NewVisit = {
  leadId: string;
  executive: string;
  type: string;
  isVisit: boolean;
  date: string;
  time: string;
  nextAction: string;
};

export type Visit = {
  id: string;
  leadId: string;
  customer: string;
  address: string;
  area: string;
  executive: string;
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
    ? visits.filter((v) => v.executive === user.name)
    : visits.filter((v) => executive === "all" || v.executive === executive);
  return pool.filter((v) =>
    tab === "assigned" ? v.status === "Assigned"
    : tab === "progress" ? v.status === "In Progress"
    : tab === "upcoming" ? v.isVisit && v.status !== "Completed" && v.date >= today
    : v.status === "Completed",
  ).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

export type Product = { id: string; model: string; price: number; unit: string };

/** GST is shown as Rs 0 until ATPL confirms GST invoicing scope (see plan section 12). */
export const GST_RATE = 0;

export function formatINR(n: number): string {
  return "Rs. " + Math.round(n).toLocaleString("en-IN");
}

export function quoteTotals(items: QuoteItem[]) {
  const subtotal = items.reduce((s, i) => s + i.qty * i.price, 0);
  const gst = Math.round(subtotal * GST_RATE);
  return { subtotal, gst, total: subtotal + gst };
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

export type PerfRow = { name: string; leads: number; visits: number; quotes: number; won: number; conversion: number };

/** Everything the dashboard shows, for one date range. */
export function perfStats(leads: Lead[], quotes: Quotation[], visits: Visit[], range: PerfRange, today: string, executives: string[]) {
  const { from, to } = rangeDates(range, today);
  const inR = (date: string) => date >= from && date <= to;
  const ls = leads.filter((l) => inR(l.createdOn));
  const qs = quotes.filter((q) => inR(q.date));
  const vs = visits.filter((v) => v.isVisit && inR(v.date));
  const bySource = LEAD_SOURCES.map((source) => ({ source, count: ls.filter((l) => l.source === source).length }));
  const won = ls.filter((l) => l.status === "Won").length;
  const rows: PerfRow[] = executives.map((name) => {
    const mine = ls.filter((l) => l.assignedTo === name);
    const wonN = mine.filter((l) => l.status === "Won").length;
    return {
      name,
      leads: mine.length,
      visits: vs.filter((v) => v.executive === name && v.status === "Completed").length,
      quotes: qs.filter((q) => q.executive === name).length,
      won: wonN,
      conversion: mine.length ? Math.round((wonN / mine.length) * 100) : 0,
    };
  });
  return {
    from, to,
    totalLeads: ls.length,
    won,
    conversion: ls.length ? Math.round((won / ls.length) * 100) : 0,
    bySource,
    scheduled: vs.length,
    completed: vs.filter((v) => v.status === "Completed").length,
    quotesSent: qs.length,
    rows,
  };
}

export type Section = "home" | "leads" | "quotations" | "visits" | "performance";
export const ACCESS: Record<Role, Section[]> = {
  "Calling Team": ["leads"],
  "Sales Executive": ["leads", "quotations", "visits"],
  Manager: ["leads", "quotations", "visits", "performance"],
};

export function canAccess(role: Role, s: Section) {
  if (s === "home") return true;
  return ACCESS[role].includes(s);
}

/** Records a user may see: managers & calling team see all leads; executives only their own. */
export function visibleFor<T extends { assignedTo?: string | null; executive?: string }>(user: User, rows: T[]): T[] {
  if (user.role !== "Sales Executive") return rows;
  return rows.filter((r) => (r.assignedTo ?? r.executive) === user.name);
}

export type LeadTab = "fresh" | "callback" | "mine" | "all";

/** Leads for a tab, after role visibility, search and source filter. */
export function leadsForTab(user: User, leads: Lead[], tab: LeadTab, search = "", source: LeadSource | "All" = "All"): Lead[] {
  const q = search.trim().toLowerCase();
  return visibleFor(user, leads).filter((l) => {
    if (tab === "fresh" && !(l.status === "Fresh Lead" && !l.assignedTo)) return false;
    if (tab === "callback" && l.status !== "Callback in Future") return false;
    if (tab === "mine" && !(l.assignedTo === user.name || l.touchedBy.includes(user.name))) return false;
    if (source !== "All" && l.source !== source) return false;
    if (q && ![l.name, l.company, l.phone.replace(/\s/g, ""), l.phone, l.id].some((f) => f.toLowerCase().includes(q))) return false;
    return true;
  });
}

export const canAssignLeads = (role: Role) => role === "Manager" || role === "Calling Team";

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
export function nextOfferNo(existing: string[], date: string, firstNumber = 1): string {
  const fy = financialYear(date);
  const nums = existing
    .map((o) => /^(\d+)\/(\d{2}-\d{2})$/.exec(o.trim()))
    .filter((m): m is RegExpExecArray => !!m && m[2] === fy)
    .map((m) => Number(m[1]));
  return `${nums.length ? Math.max(...nums) + 1 : firstNumber}/${fy}`;
}

export const isExecutive = (u: User) => u.role === "Sales Executive";
