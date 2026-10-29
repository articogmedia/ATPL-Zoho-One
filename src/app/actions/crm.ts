"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { crm } from "@/lib/crm";
import { requireActionUser, ForbiddenError } from "@/lib/auth/guard";
import { ZohoError } from "@/lib/zoho/client";
import {
  LEAD_SOURCES, LEAD_STATUSES, canAssignLeads, isExecutive, nextOfferNo, todayIST, visibleFor,
  type LeadSource, type LeadStatus, type LeadUpdate, type User, type VisitStatus,
} from "@/lib/domain";

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

/** Turns any failure into a safe message for the browser; details stay in the server log. */
async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message };
    if (err instanceof z.ZodError) return { ok: false, error: "Please check the form values." };
    console.error("Action failed", err);
    return { ok: false, error: err instanceof ZohoError ? err.message : "Something went wrong. Please try again." };
  }
}

const id = z.string().trim().min(1).max(64);
const text = (max: number) => z.string().trim().max(max);
const status = z.string().refine((s): s is LeadStatus => (LEAD_STATUSES as string[]).includes(s));
const source = z.string().refine((s): s is LeadSource => (LEAD_SOURCES as string[]).includes(s));
const phone = z.string().trim().regex(/^[0-9+()\-\s]{7,20}$/, "Enter a valid mobile number");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

async function executiveNames() {
  return (await crm().listUsers()).filter(isExecutive).map((u) => u.name);
}

async function ownLeadOrThrow(user: User, leadId: string) {
  const lead = await crm().getLead(leadId);
  if (!lead || visibleFor(user, [lead]).length === 0) throw new ForbiddenError("You can only work on your own leads.");
  return lead;
}

// ---------- Leads ----------

const newLeadSchema = z.object({
  name: text(120).min(1), company: text(160), phone, area: text(120), source, remarks: text(500),
});

export async function addLeadAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("leads");
    const data = newLeadSchema.parse(input);
    // Executives create leads for themselves; everyone else drops them in the fresh queue.
    return crm().createLead(data, user, isExecutive(user) ? user.name : null);
  });
}

const updateLeadSchema = z.object({
  id, status: status.optional(), remarks: text(500).optional(), assignedTo: text(120).nullable().optional(),
});

export async function saveLeadUpdateAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("leads");
    const p = updateLeadSchema.parse(input);
    await ownLeadOrThrow(user, p.id);
    if (p.assignedTo !== undefined) {
      if (!canAssignLeads(user.role)) throw new ForbiddenError("Only managers and the calling team can assign leads.");
      if (p.assignedTo && !(await executiveNames()).includes(p.assignedTo)) throw new ForbiddenError("Choose a sales executive.");
    }
    await crm().updateLead(p.id, { status: p.status as LeadStatus | undefined, remarks: p.remarks, assignedTo: p.assignedTo }, user);
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

// ---------- Quotations ----------

const quoteSchema = z.object({
  offerNo: text(30).min(1),
  leadId: id,
  items: z.array(z.object({ productId: id, qty: z.number().int().min(1).max(10_000) })).min(1).max(50),
});

export async function createQuoteAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("quotations");
    const q = quoteSchema.parse(input);
    const lead = await ownLeadOrThrow(user, q.leadId);
    const executive = lead.assignedTo ?? user.name;
    return crm().createQuote(q, user, executive);
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
  date: isoDate, time: hhmm, nextAction: text(200),
});

export async function scheduleVisitAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("visits");
    const v = newVisitSchema.parse(input);
    await ownLeadOrThrow(user, v.leadId);
    const executive = isExecutive(user) ? user.name : v.executive;
    if (!executive || !(await executiveNames()).includes(executive)) throw new ForbiddenError("Choose a sales executive.");
    await crm().createVisit({ ...v, executive }, user);
  });
}

const visitPatchSchema = z.object({
  id,
  status: z.enum(["Assigned", "In Progress", "Completed"]).optional(),
  notes: text(1000).optional(), date: isoDate.optional(), time: hhmm.optional(),
});

export async function updateVisitAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("visits");
    const p = visitPatchSchema.parse(input);
    const visit = await crm().getVisit(p.id);
    if (!visit || visibleFor(user, [visit]).length === 0) throw new ForbiddenError("You can only update your own work.");
    await crm().updateVisit(p.id, { status: p.status as VisitStatus | undefined, notes: p.notes, date: p.date, time: p.time }, user);
  });
}
