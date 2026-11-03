"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { crm } from "@/lib/crm";
import type { LeadPatch } from "@/lib/crm/repository";
import { requireActionUser, ForbiddenError } from "@/lib/auth/guard";
import { ZohoError } from "@/lib/zoho/client";
import { env } from "@/lib/env";
import {
  LEAD_SOURCES, LEAD_STATUSES, canAssignLeads, isExecutive, nextOfferNo, todayIST, visibleFor,
  normalizePhone, type CallOutcome, type LeadSource, type LeadStatus, type LeadUpdate, type User, type VisitStatus,
} from "@/lib/domain";

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string; duplicate?: { id: string; name: string; owner: string; status: string } };

class DuplicateLeadError extends Error {
  constructor(readonly lead: { id: string; name: string; owner: string; status: string }) {
    super("A lead with this number already exists");
  }
}

/** Turns any failure into a safe message for the browser; details stay in the server log. */
async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (err) {
    if (err instanceof DuplicateLeadError) return { ok: false, error: err.message, duplicate: err.lead };
    if (err instanceof ForbiddenError) return { ok: false, error: err.message };
    if (err instanceof z.ZodError) return { ok: false, error: "Please check the form values." };
    console.error("Action failed", err);
    return {
      ok: false,
      error: err instanceof ZohoError
        ? `${err.message}${err.code ? ` (code: ${err.code})` : ""}`
        : "Something went wrong. Please try again.",
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
  name: text(120).min(1), company: text(160), phone, area: text(120), source, remarks: text(500),
  assignedTo: text(120).nullable().optional(), forceCreate: z.boolean().optional(),
});

export async function addLeadAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("leads");
    const data = newLeadSchema.parse(input);
    const duplicate = (await crm().listLeads()).find((lead) => normalizePhone(lead.phone) === data.phone);
    if (duplicate && !(user.role === "Manager" && data.forceCreate)) {
      throw new DuplicateLeadError({ id: duplicate.id, name: duplicate.name, owner: duplicate.assignedTo ?? "Unassigned", status: duplicate.status });
    }
    // Executives create leads for themselves; everyone else drops them in the fresh queue.
    const assignee = isExecutive(user) ? user.name : data.assignedTo ?? null;
    if (assignee && !canAssignLeads(user.role)) throw new ForbiddenError("Only managers can assign leads.");
    if (assignee && !(await assignableNames()).includes(assignee)) throw new ForbiddenError("Choose a team member.");
    const lead = await crm().createLead(data, user, assignee);
    revalidateTag("leads");
    revalidateTag("visits");
    revalidatePath("/leads");
    revalidateTag("users");
    return { ...lead, zohoUrl: zohoLeadUrl(lead.id) };
  });
}

const updateLeadSchema = z.object({
  id, status: status.optional(), remarks: text(500).optional(), assignedTo: text(120).nullable().optional(),
});

const editLeadSchema = z.object({
  id, name: text(120).min(1), company: text(160), phone, source,
  status: status.optional(), remarks: text(500).optional(),
});

export async function updateLeadAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("leads");
    const p = editLeadSchema.parse(input);
    await ownLeadOrThrow(user, p.id);
    const patch: LeadPatch = {
      name: p.name, company: p.company, phone: p.phone, source: p.source,
      status: p.status, remarks: p.remarks,
    };
    await crm().updateLead(p.id, patch, user);
    revalidateTag("leads");
    return { zohoUrl: zohoLeadUrl(p.id) };
  });
}

const reassignLeadSchema = z.object({ id, assignedTo: text(120).min(1) });

export async function reassignLeadAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("leads");
    if (!canAssignLeads(user.role)) throw new ForbiddenError("Only managers can reassign leads.");
    const p = reassignLeadSchema.parse(input);
    await ownLeadOrThrow(user, p.id);
    if (!(await assignableNames()).includes(p.assignedTo)) throw new ForbiddenError("Choose a team member.");
    await crm().assignLead(p.id, p.assignedTo, user);
    revalidateTag("leads");
    revalidateTag("users");
    return { zohoUrl: zohoLeadUrl(p.id) };
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
    revalidateTag("leads");
    revalidateTag("users");
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
    revalidateTag("leads");
    revalidateTag("users");
    return { zohoUrl: zohoLeadUrl(p.id) };
  });
}

export async function getLeadHistoryAction(leadId: string): Promise<ActionResult<LeadUpdate[]>> {
  try {
    const user = await requireActionUser("leads");
    await ownLeadOrThrow(user, id.parse(leadId));
    return { ok: true, data: await crm().getLeadHistory(leadId) };
  } catch (err) {
    console.error("History failed", err);
    return { ok: false, error: err instanceof ForbiddenError ? err.message : "Could not load history." };
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
    if ((data.followUp && !data.followUpTime) || (data.outcome === "Call Back Later" && (!data.followUp || !data.followUpTime))) {
      throw new ForbiddenError("Call Back Later requires a follow-up date and time.");
    }
    await crm().logCall(data, user);
    revalidateTag("leads");
    revalidateTag("visits");
  });
}

export async function fixAssignedLeadsAction() {
  return run(async () => {
    const user = await requireActionUser("leads");
    if (user.role !== "Manager") throw new ForbiddenError("Only managers can fix assigned leads.");
    const changed = await crm().fixAssignedLeads(user);
    revalidateTag("leads");
    revalidatePath("/leads");
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
    console.error("Timeline failed", err);
    return { ok: false, error: err instanceof ForbiddenError ? err.message : "Could not load timeline." };
  }
}

// ---------- Quotations ----------

const quoteSchema = z.object({
  offerNo: text(30).min(1),
  leadId: id,
  items: z.array(z.object({ productId: id, qty: z.number().int().min(1).max(10_000), discount: z.number().min(0).default(0) })).min(1).max(50),
});

export async function createQuoteAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("quotations");
    const q = quoteSchema.parse(input);
    const lead = await ownLeadOrThrow(user, q.leadId);
    const executive = lead.assignedTo ?? user.name;
    const quote = await crm().createQuote(q, user, executive);
    revalidateTag("quotes");
    revalidateTag("leads");
    return quote;
  });
}

export async function suggestOfferNoAction(): Promise<string> {
  await requireActionUser("quotations");
  const quotes = await crm().listQuotes();
  return nextOfferNo(quotes.map((q) => q.offerNo), todayIST(), 1);
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
    revalidateTag("visits");
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
    if (!visit || visibleFor(user, [visit]).length === 0) throw new ForbiddenError("You can only update your own work.");
    await crm().updateVisit(p.id, { status: p.status as VisitStatus | undefined, notes: p.notes, date: p.date, time: p.time, followUp: p.followUp }, user);
    revalidateTag("visits");
  });
}
