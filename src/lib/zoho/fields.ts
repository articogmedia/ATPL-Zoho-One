import type { LeadStatus, Role, VisitStatus } from "@/lib/domain";

/**
 * Everything that depends on how ATPL's Zoho org is configured lives in this one file.
 * Confirm each value during the P0 audit (plan section 03) and adjust here, not in the code.
 */

/** Custom fields that must exist in Zoho (Setup > Customization > Modules and Fields). */
export const FIELD = {
  quote: { offerNo: "Offer_No", lead: "Lead_Ref" /* Lookup -> Leads */ },
  task: {
    isSiteVisit: "Is_Site_Visit" /* Checkbox */,
    visitTime: "Visit_Time" /* Single line, HH:mm */,
    nextAction: "Next_Action" /* Single line */,
    followUp: "Follow_Up_Date" /* Date */,
    type: "Task_Type" /* Single line or pick list */,
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

/** Pick-list values used by the portal when WRITING Lead_Status. Create these values in Zoho. */
export const WRITE_LEAD_STATUS: Record<LeadStatus, string> = {
  "Fresh Lead": "Fresh Lead",
  "Attempted to Contact": "Attempted to Contact",
  "Callback in Future": "Callback in Future",
  Contacted: "Contacted",
  "Site Visit Scheduled": "Site Visit Scheduled",
  "Quotation Sent": "Quotation Sent",
  Won: "Won",
  Lost: "Lost",
};

/** Tolerant READ mapping, so Zoho's stock statuses still land in a sensible bucket. */
export const READ_LEAD_STATUS: Record<string, LeadStatus> = {
  ...Object.fromEntries(Object.values(WRITE_LEAD_STATUS).map((v) => [v.toLowerCase(), v as LeadStatus])),
  "not contacted": "Fresh Lead",
  "contact in future": "Callback in Future",
  "pre-qualified": "Contacted",
  "lost lead": "Lost",
  "junk lead": "Lost",
  "not qualified": "Lost",
};

export const TASK_STATUS_WRITE: Record<VisitStatus, string> = {
  Assigned: "Not Started",
  "In Progress": "In Progress",
  Completed: "Completed",
};
