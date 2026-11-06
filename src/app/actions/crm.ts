"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { crm } from "@/lib/crm";
import { invalidate } from "@/lib/cache";
import type { LeadPatch } from "@/lib/crm/repository";
import { requireActionUser, ForbiddenError } from "@/lib/auth/guard";
import { hosts, ZohoError } from "@/lib/zoho/client";
import { friendlyZohoError, newErrorReference } from "@/lib/crm-action-errors";
import { env } from "@/lib/env";
import {
  LEAD_SOURCES, LEAD_STATUSES, canAdvanceLeadStatus, canAssignLeads, canUpdateWorkItem, isExecutive, nextOfferNo, todayIST, visibleFor,
  normalizePhone, type CallOutcome, type LeadSource, type LeadStatus, type LeadUpdate, type User, type VisitStatus,
} from "@/lib/domain";

export type DuplicateLeadResult = { id: string; name: string; owner: string; status: string; matchedField: "Mobile" | "Phone" };
export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string; duplicate?: DuplicateLeadResult };

class DuplicateLeadError extends Error {
  constructor(readonly lead: DuplicateLeadResult) {
    super(`Customer already exists. Mobile number is already in use. (Ref: ${newErrorReference()})`);
  }
}

function isZohoFailure(error: unknown): error is ZohoError {
  if (error instanceof ZohoError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; status?: unknown; code?: unknown };
  return candidate.name === "ZohoError"
    || (typeof candidate.code === "string" && (typeof candidate.status === "number" || candidate.status === undefined));
}

function reportActionFailure(action: string, error: unknown, fallback: string, elapsedMs?: number): string {
  const zohoFailure = isZohoFailure(error) ? error : null;
  const reference = zohoFailure?.reference
    ? zohoFailure.reference
    : newErrorReference();
  let hostDetails: { apiHost?: string; environment?: string } = {};
  try {
    hostDetails = {
      apiHost: hosts().api,
      environment: env().ZOHO_SANDBOX === "true" ? "sandbox" : "live",
    };
  } catch {
    hostDetails = { environment: "unconfigured" };
  }
  console.error(`[action] ${action} failed`, {
    reference,
    elapsedMs,
    errorName: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    cause: error instanceof Error ? error.cause : zohoFailure?.details?.cause,
    stack: error instanceof Error ? error.stack : undefined,
    ...hostDetails,
    zohoStatus: zohoFailure?.status,
    zohoCode: zohoFailure?.code,
    zohoField: zohoFailure?.field,
    zohoDetails: zohoFailure?.details,
    zohoOperation: zohoFailure?.operation,
  });
  const isProduction = process.env.NODE_ENV === "production";
  const safeReason = !isProduction && !zohoFailure && error instanceof Error
    ? ` (${error.name}: ${error.message
      .replace(/\b(access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/\btoken\s+[A-Za-z0-9._-]{16,}/gi, "token [REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
      .slice(0, 180)})`
    : "";
  return zohoFailure
    ? friendlyZohoError(zohoFailure.status, zohoFailure.code, zohoFailure.message, zohoFailure.field, reference, zohoFailure.operation, zohoFailure.details)
    : error instanceof Error && /timeout|timed out|abort/i.test(`${error.message} ${String(error.cause ?? "")}`)
      ? `Zoho timed out, please try again. (Ref: ${reference})`
      : `${fallback}${safeReason} (Ref: ${reference})`;
}

/** Turns any failure into a safe message for the browser; details stay in the server log. */
async function run<T>(fn: () => Promise<T>, duplicatePhone?: () => string): Promise<ActionResult<T>> {
  const started = Date.now();
  try {
    const data = await fn();
    console.info(`[action] completed ${Date.now() - started}ms`);
    return { ok: true, data };
  } catch (err) {
    console.info(`[action] failed ${Date.now() - started}ms`);
    if (err instanceof DuplicateLeadError) return { ok: false, error: err.message, duplicate: err.lead };
    if (err instanceof ForbiddenError) return { ok: false, error: err.message };
    if (err instanceof z.ZodError) return { ok: false, error: err.issues[0]?.message ?? "Please check the form values." };
    if (isZohoFailure(err)) {
      const error = reportActionFailure("CRM action", err, "Unable to complete this request. Please contact support.", Date.now() - started);
      if ((err.code === "DUPLICATE_DATA" || err.code === "DUPLICATE_LEAD") && duplicatePhone) {
        const duplicateLookupPhone = duplicatePhone();
        if (duplicateLookupPhone) {
          try {
            const existing = await crm().findLeadByPhone(duplicateLookupPhone);
            if (existing) {
              return {
                ok: false,
                error,
                duplicate: { id: existing.lead.id, name: existing.lead.name, owner: existing.lead.assignedTo ?? "Unassigned", status: existing.lead.status, matchedField: existing.matchedField },
              };
            }
          } catch (lookupError) {
            reportActionFailure("duplicate lead lookup", lookupError, "Could not verify the duplicate lead.", Date.now() - started);
          }
        }
      }
      return { ok: false, error };
    }
    return {
      ok: false,
      error: reportActionFailure("CRM action", err, "Unable to complete this request. Please contact support.", Date.now() - started),
    };
  }
}

const id = z.string().trim().min(1).max(64);
const text = (max: number) => z.string().trim().max(max);
const status = z.string().refine((s): s is LeadStatus => (LEAD_STATUSES as string[]).includes(s));
const source = z.string().refine((s): s is LeadSource => (LEAD_SOURCES as string[]).includes(s));
const phone = z.string().trim().transform((value, ctx) => {
  const normalized = normalizePhone(value);
  if (!/^\d{10}$/.test(normalized)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid 10-digit Indian mobile number" });
    return z.NEVER;
  }
  return normalized;
});
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const callOutcome = z.string().refine((value): value is CallOutcome =>
  ["Connected", "No Answer", "Busy", "Wrong Number", "Call Back Later"].includes(value),
);
const zohoLeadUrl = (leadId: string) => {
  const base = env().ZOHO_CRM_WEB_BASE?.replace(/\/+$/, "");
  return base ? `${base}/tab/Leads/${encodeURIComponent(leadId)}` : undefined;
};

async function assignableNames() {
  return (await crm().listAssignableUsers()).map((u) => u.name);
}

async function ownLeadOrThrow(user: User, leadId: string) {
  const lead = await crm().getLead(leadId);
  if (!lead || visibleFor(user, [lead]).length === 0) throw new ForbiddenError("You can only work on your own leads.");
  return lead;
}

// ---------- Leads ----------

const newLeadSchema = z.object({
  name: text(120).min(1, "Lead name is required."), company: text(160), phone, area: text(120), source, remarks: text(500),
  assignedToId: id.nullable().optional(), forceCreate: z.boolean().optional(),
});

export async function addLeadAction(input: unknown) {
  let submittedPhone = "";
  return run(async () => {
    const user = await requireActionUser("leads");
    const data = newLeadSchema.parse(input);
    submittedPhone = data.phone;
    const executive = isExecutive(user);
    const forceCreate = !executive && user.role === "Manager" && data.forceCreate;
    const assigneeId = executive ? user.id : data.assignedToId ?? null;
    // Executives create leads for themselves; everyone else drops them in the fresh queue.
    if (assigneeId && !canAssignLeads(user.role)) throw new ForbiddenError("Only managers can assign leads.");
    const lead = await crm().createLead(data, user, assigneeId, forceCreate);
    invalidate("leads", ...(lead.assignedToId ? ["visits"] : []));
    return { ...lead, zohoUrl: zohoLeadUrl(lead.id) };
  }, () => submittedPhone);
}

export async function getAssignableUsersAction() {
  return run(async () => {
    const user = await requireActionUser("leads");
    if (!canAssignLeads(user.role)) throw new ForbiddenError("Only managers can load team members.");
    const members = await crm().listAssignableUsers();
    if (!members.length) console.warn("[action] no active assignable team members returned by CRM");
    return members.map(({ id, name }) => ({ id, name }));
  });
}

const updateLeadSchema = z.object({
  id, status: status.optional(), remarks: text(500).optional(), assignedTo: text(120).nullable().optional(),
});

const editLeadSchema = z.object({
  id, name: text(120).min(1), company: text(160), phone, source,
  status: status.optional(), remarks: text(500).optional(), followUp: isoDate.optional(),
});

export async function updateLeadAction(input: unknown) {
  let submittedPhone = "";
  return run(async () => {
    const user = await requireActionUser("leads");
    const p = editLeadSchema.parse(input);
    submittedPhone = p.phone;
    await ownLeadOrThrow(user, p.id);
    const duplicate = await crm().findLeadByPhone(p.phone);
    if (duplicate && duplicate.lead.id !== p.id) {
      throw new DuplicateLeadError({
        id: duplicate.lead.id, name: duplicate.lead.name,
        owner: duplicate.lead.assignedTo ?? "Unassigned", status: duplicate.lead.status,
        matchedField: duplicate.matchedField,
      });
    }
    const patch: LeadPatch = {
      name: p.name, company: p.company, phone: p.phone, source: p.source,
      status: p.status, remarks: p.remarks, followUp: p.followUp,
    };
    await crm().updateLead(p.id, patch, user);
    invalidate("leads");
    return { zohoUrl: zohoLeadUrl(p.id) };
  }, () => submittedPhone);
}

const reassignLeadSchema = z.object({ id, assignedToId: id });

export async function reassignLeadAction(input: unknown) {
  return run<{ owner: string; ownerId: string; status: string; taskCreated: boolean; taskWarning?: string; zohoUrl?: string }>(async () => {
    const user = await requireActionUser("leads");
    if (!canAssignLeads(user.role)) throw new ForbiddenError("Only managers can reassign leads.");
    const p = reassignLeadSchema.parse(input);
    await ownLeadOrThrow(user, p.id);
    const assignee = (await crm().listAssignableUsers()).find((member) => String(member.id) === String(p.assignedToId));
    if (!assignee) throw new ForbiddenError("Choose an active team member.");
    const assignment = await crm().assignLead(p.id, p.assignedToId, user);
    invalidate("leads");
    return { ...assignment, zohoUrl: zohoLeadUrl(p.id) };
  });
}

const deleteLeadSchema = z.object({ id });

export async function deleteLeadAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("leads");
    if (user.role !== "Manager") throw new ForbiddenError("Only managers can delete leads.");
    const p = deleteLeadSchema.parse(input);
    await ownLeadOrThrow(user, p.id);
    await crm().deleteLead(p.id);
    invalidate("leads");
  });
}

export async function saveLeadUpdateAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("leads");
    const p = updateLeadSchema.parse(input);
    await ownLeadOrThrow(user, p.id);
    if (p.assignedTo !== undefined) {
      if (!canAssignLeads(user.role)) throw new ForbiddenError("Only managers can assign leads.");
      if (p.assignedTo && !(await assignableNames()).includes(p.assignedTo)) throw new ForbiddenError("Choose a team member.");
    }
    await crm().updateLead(p.id, { status: p.status as LeadStatus | undefined, remarks: p.remarks, assignedTo: p.assignedTo }, user);
    invalidate("leads");
    return { zohoUrl: zohoLeadUrl(p.id) };
  });
}

export async function getLeadHistoryAction(leadId: string): Promise<ActionResult<LeadUpdate[]>> {
  try {
    const user = await requireActionUser("leads");
    await ownLeadOrThrow(user, id.parse(leadId));
    return { ok: true, data: await crm().getLeadHistory(leadId) };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message };
    if (err instanceof z.ZodError) return { ok: false, error: "Lead not found." };
    return { ok: false, error: reportActionFailure("lead history", err, "Could not load lead history.") };
  }
}

const callSchema = z.object({
  leadId: id, outcome: callOutcome, remarks: text(500),
  followUp: isoDate.optional(), followUpTime: hhmm.optional(),
});

export async function logCallAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("leads");
    const data = callSchema.parse(input);
    await ownLeadOrThrow(user, data.leadId);
    if (data.outcome === "Call Back Later" && !data.followUp) {
      throw new ForbiddenError("Call Back Later requires a follow-up date.");
    }
    const result = await crm().logCall(data, user);
    invalidate("leads", "visits");
    return result;
  });
}

export async function fixAssignedLeadsAction() {
  return run(async () => {
    const user = await requireActionUser("leads");
    if (user.role !== "Manager") throw new ForbiddenError("Only managers can fix assigned leads.");
    const changed = await crm().fixAssignedLeads(user);
    invalidate("leads");
    return { changed };
  });
}

export async function listFixableAssignedLeadsAction() {
  return run(async () => {
    const user = await requireActionUser("leads");
    if (user.role !== "Manager") throw new ForbiddenError("Only managers can inspect assigned leads.");
    return crm().listFixableAssignedLeads(user);
  });
}

export async function getLeadTimelineAction(leadId: string): Promise<ActionResult<import("@/lib/domain").LeadTimelineItem[]>> {
  try {
    const user = await requireActionUser("leads");
    await ownLeadOrThrow(user, id.parse(leadId));
    return { ok: true, data: await crm().getLeadTimeline(leadId) };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message };
    if (err instanceof z.ZodError) return { ok: false, error: "Lead not found." };
    return { ok: false, error: reportActionFailure("lead timeline", err, "Could not load lead timeline.") };
  }
}

// ---------- Quotations ----------

const quoteSchema = z.object({
  leadId: id,
  subject: text(300).optional(),
  items: z.array(z.object({ productId: id, qty: z.number().int().min(1).max(10_000), discount: z.number().min(0).default(0) })).min(1).max(50),
});

export async function createQuoteAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("quotations");
    const q = quoteSchema.parse(input);
    const lead = await ownLeadOrThrow(user, q.leadId);
    const executive = lead.assignedTo ?? user.name;
    const repository = crm();
    const existingQuotes = await repository.listQuotes();
    const offerNo = nextOfferNo(existingQuotes.map((quote) => quote.offerNo), todayIST());
    const quote = await repository.createQuote({ ...q, offerNo }, user, executive);
    invalidate("quotes", "leads");
    return quote;
  });
}

const quotationSentSchema = z.object({ leadId: id });

export async function markQuotationSentAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("quotations");
    const { leadId } = quotationSentSchema.parse(input);
    const lead = await ownLeadOrThrow(user, leadId);
    if (lead.status !== "Quotation Sent") {
      if (!canAdvanceLeadStatus(lead.status, "Quotation Sent")) {
        throw new ForbiddenError("A closed lead cannot be marked as quotation sent.");
      }
      await crm().updateLead(lead.id, { status: "Quotation Sent" }, user);
      invalidate("leads", "quotes");
    }
    return { status: "Quotation Sent" as const };
  });
}

export async function getQuoteDetailAction(rawId: string): Promise<ActionResult<import("@/lib/domain").Quotation>> {
  try {
    const user = await requireActionUser("quotations");
    const quoteId = id.parse(rawId);
    const quote = await crm().getQuote(quoteId);
    if (!quote) return { ok: false, error: "Quotation not found." };
    if (visibleFor(user, [quote]).length === 0) {
      return { ok: false, error: "You can only view your own quotations." };
    }
    return { ok: true, data: quote };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: error.message };
    if (error instanceof z.ZodError) return { ok: false, error: "Quotation not found." };
    return { ok: false, error: reportActionFailure("quotation detail", error, "Could not load quotation details.") };
  }
}

export async function suggestOfferNoAction(): Promise<string> {
  await requireActionUser("quotations");
  try {
    const quotes = await crm().listQuotes();
    return nextOfferNo(quotes.map((q) => q.offerNo), todayIST());
  } catch (error) {
    throw new Error(reportActionFailure("suggest offer number", error, "Could not suggest an offer number."));
  }
}

// ---------- Work & site visits ----------

const newVisitSchema = z.object({
  leadId: id, executive: text(120).optional(), type: text(80).min(1), isVisit: z.boolean(),
  date: isoDate, time: hhmm, address: text(240).optional(), nextAction: text(200),
  followUp: isoDate.optional(),
});

export async function scheduleVisitAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("visits");
    const v = newVisitSchema.parse(input);
    await ownLeadOrThrow(user, v.leadId);
    const executive = isExecutive(user) ? user.name : v.executive;
    if (!executive || !(await assignableNames()).includes(executive)) throw new ForbiddenError("Choose a team member.");
    await crm().createVisit({ ...v, executive }, user);
    invalidate("visits");
    revalidatePath("/visits");
  });
}

const visitPatchSchema = z.object({
  id,
  status: z.enum(["Assigned", "In Progress", "Completed"]).optional(),
  notes: text(1000).optional(), date: isoDate.optional(), time: hhmm.optional(), followUp: isoDate.optional(),
});

export async function updateVisitAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("visits");
    const p = visitPatchSchema.parse(input);
    const visit = await crm().getVisit(p.id);
    if (!visit) throw new ZohoError("This task no longer exists, refreshing…", 404, "NOT_FOUND", undefined, undefined, `GET /Tasks/${p.id}`);
    if (!canUpdateWorkItem(user, visit)) {
      throw new ForbiddenError("You can only update your own work.");
    }
    await crm().updateVisit(p.id, { status: p.status as VisitStatus | undefined, notes: p.notes, date: p.date, time: p.time, followUp: p.followUp }, user, visit);
    invalidate("visits");
    revalidatePath("/visits");
  });
}
