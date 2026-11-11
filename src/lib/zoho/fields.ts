import type { CallOutcome, LeadSource, LeadStatus, Role, VisitStatus } from "@/lib/domain";

const LEAD_SOURCE_ALIASES: Record<LeadSource, string[]> = {
  "Meta Ads": ["meta ads", "facebook ads", "facebook", "instagram", "advertisement", "social media"],
  "Google Ads": ["google ads", "google adwords", "adwords", "google", "web research"],
  "Direct Call": ["direct call", "cold call", "telephone", "phone", "call"],
  "Walk-in": ["walk in", "walk-in", "store visit", "in person"],
  Referral: ["referral", "employee referral", "customer referral", "partner referral"],
  Website: ["website", "web site", "website inquiry", "online"],
  Other: ["other", "others"],
};

export function zohoLeadSource(source: LeadSource, configuredValues: string[], fallbackToOther = true): string | null {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const values = configuredValues.filter((value) => !!value.trim()).map((value) => ({ value, normalized: normalize(value) }));
  const aliases = LEAD_SOURCE_ALIASES[source].map(normalize);
  const match = values.find(({ normalized }) => aliases.includes(normalized))?.value
    ?? values.find(({ normalized }) => aliases.some((alias) => normalized.includes(alias) || alias.includes(normalized)))?.value
    ?? null;
  if (match || !fallbackToOther || source === "Other") return match;
  const otherAliases = LEAD_SOURCE_ALIASES.Other.map(normalize);
  return values.find(({ normalized }) => otherAliases.includes(normalized))?.value
    ?? values.find(({ normalized }) => otherAliases.some((alias) => normalized.includes(alias) || alias.includes(normalized)))?.value
    ?? null;
}

/**
 * Everything that depends on how ATPL's Zoho org is configured lives in this one file.
 * Confirm each value during the P0 audit (plan section 03) and adjust here, not in the code.
 */

/** Custom fields that must exist in Zoho (Setup > Customization > Modules and Fields). */
export const FIELD = {
  lead: { email: "Email", state: "State", accountId: "ATPL_Account_ID", lostReason: "Lost_Reason" },
  quote: { offerNo: "Offer_No", lead: "Lead_Ref" /* Lookup -> Leads */ },
  invoice: {
    invoiceNo: "ATPL_Invoice_No",
    customerGstin: "Customer_GSTIN",
    sourceQuoteId: "ATPL_Source_Quote_ID",
    snapshot: "ATPL_Invoice_Snapshot",
  },
  account: { customerGstin: "Customer_GSTIN" },
  task: {
    isSiteVisit: "Is_Site_Visit" /* Checkbox */,
    visitTime: "Visit_Time" /* Single line, HH:mm */,
    nextAction: "Next_Action" /* Single line */,
    followUp: "Follow_Up_Date" /* Date */,
    type: "Task_Type" /* Single line or pick list */,
  },
  call: {
    result: "Call_Result",
    startTime: "Call_Start_Time",
  },
} as const;

/** Zoho role or profile name -> portal role. Users that match nothing cannot sign in. */
export const ROLE_BY_ZOHO_NAME: Record<string, Role> = {
  administrator: "Manager",
  ceo: "Manager",
  manager: "Manager",
  "sales manager": "Manager",
  "sales executive": "Sales Executive",
  "calling team": "Calling Team",
};

/** Partial, case-insensitive Zoho role/profile keywords used when names vary by org. */
export const ROLE_KEYWORDS: Record<Role, string[]> = {
  "Sales Executive": ["sales", "business development", "executive"],
  "Calling Team": ["calling", "telecall"],
  Manager: ["manager", "admin", "ceo"],
};

/** Pick-list values used by the portal when WRITING Lead_Status. Create these values in Zoho. */
export const WRITE_LEAD_STATUS: Record<LeadStatus, string> = {
  "Fresh Lead": "Fresh Lead",
  "Attempted to Contact": "Attempted to Contact",
  "Callback in Future": "Callback in Future",
  Contacted: "Contacted",
  "Junk Lead": "Junk Lead",
  "Lost Lead": "Lost Lead",
  "Not Contacted": "Not Contacted",
  "Pre-Qualified": "Pre-Qualified",
  "Not Qualified": "Not Qualified",
  "Not Responsive": "Not Responsive",
  "Assigned to Sales": "Assigned to Sales",
  "Site Visit Scheduled": "Site Visit Scheduled",
  "Quotation Sent": "Quotation Sent",
  Won: "Won",
};

export const ASSIGNED_STAGE = "Assigned to Sales" as const;
export const CALL_STATUS_BY_OUTCOME: Record<CallOutcome, LeadStatus> = {
  Connected: "Contacted",
  "No Answer": "Attempted to Contact",
  Busy: "Attempted to Contact",
  "Call Back Later": "Callback in Future",
  "Wrong Number": "Not Responsive",
};

/** Tolerant READ mapping, so Zoho's stock statuses still land in a sensible bucket. */
export const READ_LEAD_STATUS: Record<string, LeadStatus> = {
  ...Object.fromEntries(Object.values(WRITE_LEAD_STATUS).map((v) => [v.toLowerCase(), v as LeadStatus])),
  "not contacted": "Fresh Lead",
  "contact in future": "Callback in Future",
  "pre-qualified": "Contacted",
  "lost lead": "Lost Lead",
  "junk lead": "Junk Lead",
  "not qualified": "Not Qualified",
};

export const TASK_STATUS_WRITE: Record<VisitStatus, string> = {
  Assigned: "Not Started",
  "In Progress": "In Progress",
  Completed: "Completed",
};
