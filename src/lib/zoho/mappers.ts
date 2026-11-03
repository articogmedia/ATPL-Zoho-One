import type { Lead, LeadSource, LeadStatus, LeadUpdate, Product, Quotation, Role, User, Visit, VisitStatus } from "@/lib/domain";
import { FIELD, READ_LEAD_STATUS, ROLE_BY_ZOHO_NAME, ROLE_KEYWORDS } from "./fields";

/** Pure Zoho <-> portal mapping. No I/O, so it is fully unit-tested. */

type Ref = { id: string; name?: string } | null | undefined;
const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");

export type ZUser = { id: string; full_name: string; email?: string; role?: { name?: string }; profile?: { name?: string } };
export type ZLead = {
  id: string; Last_Name?: string; First_Name?: string; Company?: string; Mobile?: string; Phone?: string;
  City?: string; Street?: string; Lead_Source?: string; Lead_Status?: string; Owner?: Ref; Description?: string;
  Created_Time?: string; Created_By?: Ref; Modified_By?: Ref;
};
export type ZProduct = { id: string; Product_Name: string; Unit_Price?: number; Usage_Unit?: string };
export type ZQuote = { id: string; Owner?: Ref; Created_Time?: string; Grand_Total?: number; [k: string]: unknown };
export type ZTask = { id: string; Subject?: string; Status?: string; Due_Date?: string; Owner?: Ref; Who_Id?: Ref; Description?: string; [k: string]: unknown };
export type ZCall = { id: string; Subject?: string; Call_Start_Time?: string; Call_Type?: string; Owner?: Ref; What_Id?: Ref; [k: string]: unknown };
export type ZNote = { Note_Content?: string; Created_Time?: string; Created_By?: Ref };

export function parseRoleOverrides(raw?: string): Map<string, Role> {
  const overrides = new Map<string, Role>();
  for (const entry of raw?.split(",") ?? []) {
    const separator = entry.lastIndexOf(":");
    if (separator <= 0) continue;
    const email = entry.slice(0, separator).trim().toLowerCase();
    const roleName = entry.slice(separator + 1).trim().toLowerCase();
    if (!email || !roleName) continue;
    const role = (["Manager", "Sales Executive", "Calling Team"] as const).find(
      (candidate) => candidate.toLowerCase() === roleName,
    );
    if (role) overrides.set(email, role);
  }
  return overrides;
}

export function mapRole(u: ZUser, overrides?: ReadonlyMap<string, Role>): Role | null {
  const email = u.email?.trim().toLowerCase();
  const override = email ? overrides?.get(email) : undefined;
  if (override) return override;
  const names = [u.role?.name, u.profile?.name].filter((name): name is string => !!name).map((name) => name.trim().toLowerCase());
  for (const name of names) {
    const r = ROLE_BY_ZOHO_NAME[name];
    if (r) return r;
  }
  for (const name of names) {
    for (const role of ["Manager", "Sales Executive", "Calling Team"] as const) {
      if (ROLE_KEYWORDS[role].some((keyword) => name.includes(keyword))) return role;
    }
  }
  return null;
}

export function mapUser(u: ZUser, overrides?: ReadonlyMap<string, Role>): User | null {
  const role = mapRole(u, overrides);
  return role ? { id: u.id, name: u.full_name, role, email: u.email } : null;
}

/** Zoho lead sources are free-form (Facebook, Google AdWords, ...). Fold them into ATPL's three. */
export function normalizeSource(raw?: string): LeadSource {
  const s = (raw ?? "").toLowerCase();
  if (/meta|facebook|instagram|\bfb\b|\big\b/.test(s)) return "Meta Ads";
  if (/google|adwords|youtube/.test(s)) return "Google Ads";
  return "Direct Call";
}

export function normalizeStatus(raw?: string): LeadStatus {
  return READ_LEAD_STATUS[(raw ?? "").trim().toLowerCase()] ?? "Fresh Lead";
}

export function mapLead(z: ZLead, executives: ReadonlySet<string>): Lead {
  const ownerName = z.Owner?.name ?? "";
  return {
    id: z.id,
    name: [z.First_Name, z.Last_Name].filter(Boolean).join(" ").trim() || "(no name)",
    company: z.Company && z.Company !== "-" ? z.Company : "",
    phone: z.Mobile || z.Phone || "",
    area: z.City ?? "",
    address: z.Street ?? "",
    source: normalizeSource(z.Lead_Source),
    status: normalizeStatus(z.Lead_Status),
    // Ownership is the assignment: an executive owner means "assigned", anyone else means the fresh queue.
    assignedTo: executives.has(ownerName) ? ownerName : null,
    assignedToId: executives.has(ownerName) ? z.Owner?.id : undefined,
    ownerId: z.Owner?.id,
    remarks: z.Description ?? "",
    createdOn: day(z.Created_Time),
    touchedBy: [z.Created_By?.name, z.Modified_By?.name].filter((n): n is string => !!n),
  };
}

export function mapProduct(z: ZProduct): Product {
  return { id: z.id, model: z.Product_Name, price: z.Unit_Price ?? 0, unit: z.Usage_Unit || "Nos" };
}

export function mapQuote(z: ZQuote, leadsById: ReadonlyMap<string, Lead>): Quotation {
  const ref = z[FIELD.quote.lead] as Ref;
  const lead = ref ? leadsById.get(ref.id) : undefined;
  return {
    id: z.id,
    offerNo: String(z[FIELD.quote.offerNo] ?? ""),
    leadId: ref?.id ?? "",
    customer: lead ? lead.company || lead.name : ref?.name ?? "",
    executive: z.Owner?.name ?? "",
    ownerId: z.Owner?.id,
    total: z.Grand_Total ?? 0,
    date: day(z.Created_Time),
    status: String(z.Status ?? "Draft"),
  };
}

export function mapTaskStatus(raw?: string): VisitStatus {
  const s = (raw ?? "").toLowerCase();
  return s === "completed" ? "Completed" : s === "in progress" ? "In Progress" : "Assigned";
}

export function mapTask(z: ZTask, leadsById: ReadonlyMap<string, Lead>): Visit {
  const lead = z.Who_Id ? leadsById.get(z.Who_Id.id) : undefined;
  const status = mapTaskStatus(z.Status);
  return {
    id: z.id,
    leadId: z.Who_Id?.id ?? "",
    customer: lead ? lead.company || lead.name : z.Who_Id?.name ?? "",
    address: lead?.address ?? "",
    area: lead?.area ?? "",
    executive: z.Owner?.name ?? "",
    executiveId: z.Owner?.id,
    type: String(z[FIELD.task.type] || z.Subject || "Work"),
    isVisit: z[FIELD.task.isSiteVisit] === true,
    date: z.Due_Date ?? "",
    time: String(z[FIELD.task.visitTime] ?? ""),
    status,
    nextAction: String(z[FIELD.task.nextAction] ?? ""),
    followUp: String(z[FIELD.task.followUp] ?? ""),
    notes: z.Description ?? "",
    done: status === "Completed",
  };
}

export function mapNote(n: ZNote): LeadUpdate {
  return { date: day(n.Created_Time), user: n.Created_By?.name ?? "", note: n.Note_Content ?? "" };
}
