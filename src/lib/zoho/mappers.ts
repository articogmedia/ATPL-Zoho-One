import type { Lead, LeadSource, LeadStatus, LeadUpdate, Product, Quotation, Role, User, Visit, VisitStatus } from "@/lib/domain";
import { FIELD, READ_LEAD_STATUS, ROLE_BY_ZOHO_NAME, ROLE_KEYWORDS } from "./fields";

/** Pure Zoho <-> portal mapping. No I/O, so it is fully unit-tested. */

type Ref = { id: string; name?: string } | null | undefined;
const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");
const ownerId = (id?: string | number) => (id === undefined || id === null ? undefined : String(id).trim());
const warnedStatuses = new Set<string>();
const warnedSources = new Set<string>();

export type ZUser = {
  id: string | number; full_name: string; first_name?: string; last_name?: string;
  email?: string; role?: { name?: string }; profile?: { name?: string };
};
export type ZLead = {
  id: string | number; Last_Name?: string; First_Name?: string; Company?: string; Mobile?: string; Phone?: string;
  City?: string; Street?: string; Lead_Source?: string; Lead_Status?: string; Owner?: Ref; Description?: string;
  Created_Time?: string; Created_By?: Ref; Modified_By?: Ref;
};
export type ZProduct = { id: string; Product_Name: string; Product_Code?: string; Description?: string; Unit_Price?: number; Usage_Unit?: string };
export type ZQuotedItem = {
  product?: Ref | string;
  quantity?: number | string;
  list_price?: number | string;
  Unit_Price?: number | string;
  total?: number | string;
  Total?: number | string;
  total_after_discount?: number | string;
  Total_After_Discount?: number | string;
  net_total?: number | string;
  Net_Total?: number | string;
  Product_Name?: Ref | string;
  Quantity?: number | string;
  List_Price?: number | string;
  Discount?: number | string;
  Description?: string;
  Unit?: string;
  Usage_Unit?: string;
};
export type ZQuote = { id: string; Subject?: string; Owner?: Ref; Created_Time?: string; Grand_Total?: number; Product_Details?: ZQuotedItem[]; Quoted_Items?: ZQuotedItem[]; [k: string]: unknown };
export type QuoteLineItemsField = "Quoted_Items" | "Product_Details";

export function quoteLineItemsField(fieldNames: Iterable<string>): QuoteLineItemsField {
  const names = new Set(fieldNames);
  return names.has("Quoted_Items") ? "Quoted_Items" : "Product_Details";
}
export type ZTask = { id: string; Subject?: string; Status?: string; Due_Date?: string; Owner?: Ref; Who_Id?: Ref; What_Id?: Ref; Description?: string; Mobile?: string; Phone?: string; [k: string]: unknown };
export type ZCall = { id: string; Subject?: string; Call_Start_Time?: string; Call_Type?: string; Owner?: Ref; What_Id?: Ref; [k: string]: unknown };
export type ZEvent = { Event_Title?: string; Start_DateTime?: string; Created_Time?: string; Owner?: Ref; Description?: string };
export type ZNote = { Note_Title?: string; Note_Content?: string; Created_Time?: string; Owner?: Ref; Created_By?: Ref };

export function cleanZohoDisplayName(value?: string | null): string {
  return (value ?? "").trim().split(/\s+/).filter((part, index, parts) =>
    index === 0 || part.toLowerCase() !== parts[index - 1]?.toLowerCase(),
  ).join(" ");
}

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
  const firstName = u.first_name?.trim().replace(/\s+/g, " ");
  const lastName = u.last_name?.trim().replace(/\s+/g, " ");
  const composed = firstName && lastName
    ? `${lastName.toLowerCase().startsWith(firstName.toLowerCase()) ? "" : `${firstName} `}${lastName}`
    : firstName || lastName;
  const name = cleanZohoDisplayName(u.full_name?.trim().replace(/\s+/g, " ") || composed);
  return role ? { id: ownerId(u.id)!, name, role, email: u.email } : null;
}

/** Zoho lead sources are free-form (Facebook, Google AdWords, ...). Fold them into ATPL's three. */
export function normalizeSource(raw?: string): LeadSource {
  const value = (raw ?? "").trim();
  const s = value.toLowerCase();
  if (/meta|facebook|instagram|\bfb\b|\big\b|advertisement|social/.test(s)) return "Meta Ads";
  if (/google|adwords|youtube|web research/.test(s)) return "Google Ads";
  if (/walk[- ]?in|store visit|in person/.test(s)) return "Walk-in";
  if (/referral/.test(s)) return "Referral";
  if (/website|web site|online/.test(s)) return "Website";
  if (/other/.test(s)) return "Other";
  if (/phone|telephone|direct call|direct|sales executive|inbound|cold call|^call$/.test(s)) return "Direct Call";
  if (value && !warnedSources.has(s)) {
    warnedSources.add(s);
    console.warn("[zoho] Unknown lead source; using Direct Call", { source: value });
  }
  return "Direct Call";
}

export function normalizeStatus(raw?: string): LeadStatus {
  const value = (raw ?? "").trim();
  const normalized = value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const aliases: Record<string, LeadStatus> = {
    "fresh lead": "Fresh Lead", fresh: "Fresh Lead",
    "not contacted": "Not Contacted", attempted: "Attempted to Contact", "attempted to contact": "Attempted to Contact",
    "no answer": "Not Responsive", "not responsive": "Not Responsive", busy: "Attempted to Contact",
    contacted: "Contacted", "callback in future": "Callback in Future", "call back later": "Callback in Future",
    "assigned to sales": "Assigned to Sales", "site visit scheduled": "Site Visit Scheduled",
    "quotation sent": "Quotation Sent", won: "Won", "lost lead": "Lost Lead", junk: "Junk Lead",
    "junk lead": "Junk Lead", "pre qualified": "Pre-Qualified", "not qualified": "Not Qualified",
  };
  const mapped = aliases[normalized] ?? READ_LEAD_STATUS[normalized];
  if (mapped) return mapped;
  if (value && !warnedStatuses.has(normalized)) {
    warnedStatuses.add(normalized);
    console.warn("[zoho] Unknown lead status; using Not Contacted", { status: value });
  }
  return "Not Contacted";
}

export function mapLead(z: ZLead, assignable: ReadonlySet<string>, salesExecutives?: ReadonlySet<string>): Lead {
  const ownerName = cleanZohoDisplayName(z.Owner?.name);
  const zohoOwnerId = ownerId(z.Owner?.id);
  const status = normalizeStatus(z.Lead_Status);
  const isSalesOwnedFreshLead = status === "Fresh Lead" && !!zohoOwnerId && !!salesExecutives && salesExecutives.has(zohoOwnerId);
  const isAssignableOwner = !!zohoOwnerId && assignable.has(zohoOwnerId) &&
    (!salesExecutives || status !== "Fresh Lead" || isSalesOwnedFreshLead);
  return {
    id: String(z.id).trim(),
    name: [z.First_Name, z.Last_Name].filter(Boolean).join(" ").trim() || "(no name)",
    company: z.Company && z.Company !== "-" ? z.Company : "",
    phone: z.Mobile || z.Phone || "",
    area: z.City ?? "",
    address: z.Street ?? "",
    source: normalizeSource(z.Lead_Source),
    status,
    // Ownership is the assignment: an executive owner means "assigned", anyone else means the fresh queue.
    assignedTo: isAssignableOwner ? ownerName : null,
    assignedToId: isAssignableOwner ? zohoOwnerId : undefined,
    ownerId: zohoOwnerId,
    remarks: z.Description ?? "",
    createdOn: day(z.Created_Time),
    touchedBy: [z.Created_By?.name, z.Modified_By?.name].filter((n): n is string => !!n),
  };
}

export function mapProduct(z: ZProduct): Product {
  return { id: z.id, model: z.Product_Name, code: z.Product_Code?.trim() || undefined, description: z.Description?.trim() || undefined, price: z.Unit_Price ?? 0, unit: z.Usage_Unit || "Nos" };
}

export function mapQuote(
  z: ZQuote,
  leadsById: ReadonlyMap<string, Lead>,
  productsById?: ReadonlyMap<string, Product>,
  quoteFieldNames?: Iterable<string>,
): Quotation {
  const lineItemsField = quoteLineItemsField(
    quoteFieldNames ?? ["Quoted_Items", "Product_Details"].filter((field) => field in z),
  );
  const rawLeadRef = z[FIELD.quote.lead];
  const ref = rawLeadRef && typeof rawLeadRef === "object" ? rawLeadRef as Ref : undefined;
  const textLeadId = typeof rawLeadRef === "string" ? rawLeadRef.trim() : "";
  const leadId = ref?.id ?? textLeadId;
  const lead = leadId ? leadsById.get(leadId) : undefined;
  const account = z.Account_Name && typeof z.Account_Name === "object" ? z.Account_Name as Ref : undefined;
  const contact = z.Contact_Name && typeof z.Contact_Name === "object" ? z.Contact_Name as Ref : undefined;
  const subjectMatch = /^Offer\s+(.+?)\s+-\s+(.+)$/.exec(String(z.Subject ?? "").trim());
  const offerNo = String(z[FIELD.quote.offerNo] ?? "").trim() || subjectMatch?.[1] || "";
  const customer = (lead ? lead.company || lead.name : "") || account?.name || contact?.name || ref?.name || subjectMatch?.[2] || "";
  return {
    id: String(z.id).trim(),
    offerNo,
    leadId,
    customer,
    executive: cleanZohoDisplayName(z.Owner?.name),
    ownerId: ownerId(z.Owner?.id),
    total: z.Grand_Total ?? 0,
    date: day(z.Created_Time),
    status: String(z.Status ?? "Draft"),
    items: z[lineItemsField]?.map((item) => {
      const product = item.product ?? item.Product_Name;
      const reference = typeof product === "string" ? undefined : product;
      const catalogProduct = reference?.id ? productsById?.get(reference.id) : undefined;
      const number = (value: number | string | undefined) => Number(value ?? 0);
      return {
        productId: reference?.id,
        model: reference?.name ?? (typeof product === "string" ? product : catalogProduct?.model ?? ""),
        description: item.Description ?? catalogProduct?.description ?? "",
        unit: item.Usage_Unit ?? item.Unit ?? catalogProduct?.unit ?? "Nos",
        price: number(item.list_price ?? item.List_Price ?? item.Unit_Price),
        qty: number(item.quantity ?? item.Quantity),
        discount: number(item.Discount),
      };
    }),
  };
}

export function mapTaskStatus(raw?: string): VisitStatus {
  const s = (raw ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (["completed", "complete", "done", "closed"].includes(s)) return "Completed";
  if (["in progress", "started", "work in progress"].includes(s)) return "In Progress";
  if (["not started", "open", "scheduled", "assigned"].includes(s)) return "Assigned";
  return "Assigned";
}

export function mapTask(z: ZTask, leadsById: ReadonlyMap<string, Lead>): Visit {
  const related = z.What_Id ?? z.Who_Id;
  const lead = related ? leadsById.get(related.id) : undefined;
  const status = mapTaskStatus(z.Status);
  return {
    id: String(z.id).trim(),
    leadId: related?.id ?? "",
    customer: lead ? lead.company || lead.name : related?.name ?? "",
    phone: String(z.Mobile || z.Phone || lead?.phone || ""),
    address: lead?.address ?? "",
    area: lead?.area ?? "",
    executive: cleanZohoDisplayName(z.Owner?.name),
    executiveId: ownerId(z.Owner?.id),
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
  return { date: day(n.Created_Time), user: cleanZohoDisplayName(n.Owner?.name ?? n.Created_By?.name), note: n.Note_Content ?? "" };
}
