import type { Lead, LeadSource, LeadStatus, LeadUpdate, Product, Quotation, Role, User, Visit, VisitStatus } from "@/lib/domain";
import { FIELD, READ_LEAD_STATUS, ROLE_BY_ZOHO_NAME } from "./fields";

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
export type ZNote = { Note_Content?: string; Created_Time?: string; Created_By?: Ref };

export function mapRole(u: ZUser): Role | null {
  for (const name of [u.role?.name, u.profile?.name]) {
    const r = name ? ROLE_BY_ZOHO_NAME[name.trim().toLowerCase()] : undefined;
    if (r) return r;
  }
  return null;
}

export function mapUser(u: ZUser): User | null {
  const role = mapRole(u);
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
    total: z.Grand_Total ?? 0,
    date: day(z.Created_Time),
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
