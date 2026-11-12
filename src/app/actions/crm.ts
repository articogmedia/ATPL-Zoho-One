"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { crm } from "@/lib/crm";
import { getCachedValue, invalidate, markStale, withIdempotency } from "@/lib/cache";
import type { LeadPatch, NewProduct } from "@/lib/crm/repository";
import { requireActionUser, ForbiddenError } from "@/lib/auth/guard";
import { hosts, ZohoError } from "@/lib/zoho/client";
import { friendlyZohoError, newErrorReference } from "@/lib/crm-action-errors";
import { env } from "@/lib/env";
import { logPerf } from "@/lib/perf-log";
import { getStoredQuotationPdf, invalidateStoredQuotationPdf, saveStoredQuotationPdf } from "@/lib/quotation-pdf-store";
import { sendEmail } from "@/lib/email";
import { takeQuotationEmailRateLimit } from "@/lib/quotation-email-rate-limit";
import { getStoredInvoicePdf, saveStoredInvoicePdf } from "@/lib/invoice-pdf-store";
import { canConvertToInvoice, canViewInvoice } from "@/lib/invoice-rules";
import { COMPANY, offerSubject } from "@/lib/company";
import { signQuotationPdfSnapshot } from "@/lib/quotation-pdf-snapshot";
import {
  GST_RATE, LEAD_SOURCES, LEAD_STATUSES, LOST_REASONS, canAdvanceLeadStatus, canAssignLeads, canUpdateWorkItem, isExecutive, todayIST, visibleFor,
  formatINR, normalizePhone, type CallOutcome, type LeadSource, type LeadStatus, type LeadUpdate, type LostReason, type User, type VisitStatus,
} from "@/lib/domain";

export type DuplicateLeadResult = { id: string; name: string; owner: string; status: string; matchedField: "Mobile" | "Phone" };
export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string; duplicate?: DuplicateLeadResult };

class DuplicateLeadError extends Error {
  constructor(readonly lead: DuplicateLeadResult) {
    super(`Customer already exists. Mobile number is already in use. (Ref: ${newErrorReference()})`);
  }
}

class DuplicateProductError extends Error {}

function isZohoFailure(error: unknown): error is ZohoError {
  if (error instanceof ZohoError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; status?: unknown; code?: unknown };
  return candidate.name === "ZohoError"
    || (typeof candidate.code === "string" && (typeof candidate.status === "number" || candidate.status === undefined));
}

function revalidateCrmPaths(...paths: string[]) {
  for (const path of new Set(paths)) revalidatePath(path);
}

function scheduleActionCompletionLog(action: string, elapsedMs: number, status: "completed" | "failed") {
  const log = () => logPerf("server_action", elapsedMs, { action, status });
  try {
    after(async () => { log(); });
  } catch {
    queueMicrotask(log);
  }
}

const LEAD_MUTATION_PATHS = ["/leads", "/visits", "/home", "/performance"];
const WORK_MUTATION_PATHS = ["/visits", "/leads", "/home", "/performance"];
const QUOTE_MUTATION_PATHS = ["/quotations", "/leads", "/home", "/performance"];

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
  return zohoFailure
    ? friendlyZohoError(zohoFailure.status, zohoFailure.code, zohoFailure.message, zohoFailure.field, reference, zohoFailure.operation, zohoFailure.details)
    : error instanceof Error && /timeout|timed out|abort/i.test(`${error.message} ${String(error.cause ?? "")}`)
      ? `Zoho timed out, please try again. (Ref: ${reference})`
      : `${fallback} (Ref: ${reference})`;
}

/** Turns any failure into a safe message for the browser; details stay in the server log. */
async function run<T>(
  fn: () => Promise<T>,
  duplicatePhone?: () => string,
  mutation?: { input: unknown; action: string; section: "leads" | "quotations" | "invoices" | "visits" },
): Promise<ActionResult<T>> {
  const started = Date.now();
  const execute = async (): Promise<ActionResult<T>> => {
    try {
      const data = await fn();
      scheduleActionCompletionLog(mutation?.action ?? "crm-read", Date.now() - started, "completed");
      return { ok: true, data };
    } catch (err) {
      scheduleActionCompletionLog(mutation?.action ?? "crm-read", Date.now() - started, "failed");
      if (err instanceof DuplicateLeadError) return { ok: false, error: err.message, duplicate: err.lead };
      if (err instanceof DuplicateProductError) return { ok: false, error: err.message };
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
  };
  if (!mutation) return execute();
  const rawKey = mutation.input && typeof mutation.input === "object" && "idempotencyKey" in mutation.input
    ? (mutation.input as { idempotencyKey?: unknown }).idempotencyKey
    : undefined;
  if (typeof rawKey !== "string" || !z.string().uuid().safeParse(rawKey).success) return execute();
  try {
    const user = await requireActionUser(mutation.section);
    return await withIdempotency(`${mutation.action}:${user.id}:${rawKey}`, execute);
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: error.message };
    if (error instanceof z.ZodError) return { ok: false, error: error.issues[0]?.message ?? "Please check the form values." };
    return {
      ok: false,
      error: reportActionFailure(mutation.action, error, "Unable to complete this request. Please contact support.", Date.now() - started),
    };
  }
}

function scheduleCrmEffects(action: string, invalidations: string[], paths: string[]) {
  const work = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await markStale(...invalidations);
        revalidateCrmPaths(...paths);
        return;
      } catch (error) {
        console.error(`[action] deferred ${action} cache update ${attempt === 0 ? "retrying" : "failed"}`, {
          attempt: attempt + 1,
          message: error instanceof Error ? error.message : String(error),
        });
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
  };
  try {
    after(work);
  } catch (error) {
    console.error(`[action] could not schedule ${action} cache update`, {
      message: error instanceof Error ? error.message : String(error),
    });
    void work();
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
    scheduleCrmEffects("lead create", ["leads", "visits"], LEAD_MUTATION_PATHS);
    return { ...lead, zohoUrl: zohoLeadUrl(lead.id) };
  }, () => submittedPhone, { input, action: "add-lead", section: "leads" });
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

export async function getLeadSourcesAction() {
  return run(async () => {
    await requireActionUser("leads");
    return await crm().listLeadSources();
  });
}

const updateLeadSchema = z.object({
  id, status: status.optional(), lostReason: z.enum(LOST_REASONS).optional(), remarks: text(500).optional(), assignedTo: text(120).nullable().optional(),
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
    const current = await ownLeadOrThrow(user, p.id);
    if (normalizePhone(current.phone) !== normalizePhone(p.phone)) {
      const duplicate = await crm().findLeadByPhone(p.phone);
      if (duplicate && duplicate.lead.id !== p.id) {
        throw new DuplicateLeadError({
          id: duplicate.lead.id, name: duplicate.lead.name,
          owner: duplicate.lead.assignedTo ?? "Unassigned", status: duplicate.lead.status,
          matchedField: duplicate.matchedField,
        });
      }
    }
    const patch: LeadPatch = {
      name: p.name, company: p.company, phone: p.phone, source: p.source,
      status: p.status, remarks: p.remarks, followUp: p.followUp,
    };
    const updated = await crm().updateLead(p.id, patch, user, current);
    scheduleCrmEffects("lead edit", ["leads", "visits"], LEAD_MUTATION_PATHS);
    return {
      zohoUrl: zohoLeadUrl(p.id),
      lead: updated ?? {
        ...current,
        name: p.name,
        company: p.company,
        phone: p.phone,
        source: p.source,
        ...(p.status ? { status: p.status } : {}),
        ...(p.remarks !== undefined ? { remarks: p.remarks } : {}),
        ...(p.followUp ? { followUp: p.followUp } : {}),
      },
    };
  }, () => submittedPhone, { input, action: "edit-lead", section: "leads" });
}

const reassignLeadSchema = z.object({ id, assignedToId: id });

export async function reassignLeadAction(input: unknown) {
  return run<{ owner: string; ownerId: string; status: string; taskCreated: boolean; warningCheckId: string; zohoUrl?: string }>(async () => {
    const user = await requireActionUser("leads");
    if (!canAssignLeads(user.role)) throw new ForbiddenError("Only managers can reassign leads.");
    const p = reassignLeadSchema.parse(input);
    await ownLeadOrThrow(user, p.id);
    const assignee = (await crm().listAssignableUsers()).find((member) => String(member.id) === String(p.assignedToId));
    if (!assignee) throw new ForbiddenError("Choose an active team member.");
    const assignment = await crm().assignLead(p.id, p.assignedToId, user);
    scheduleCrmEffects("lead reassign", ["leads", "visits"], LEAD_MUTATION_PATHS);
    return { ...assignment, zohoUrl: zohoLeadUrl(p.id) };
  }, undefined, { input, action: "reassign-lead", section: "leads" });
}

const bulkReassignLeadsSchema = z.object({
  ids: z.array(id).min(1).max(50).refine((ids) => new Set(ids).size === ids.length, "Choose each lead only once."),
  assignedToId: id,
});

export async function bulkReassignLeadsAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("leads");
    if (user.role !== "Manager") throw new ForbiddenError("Only managers can bulk assign leads.");
    const { ids, assignedToId } = bulkReassignLeadsSchema.parse(input);
    const repository = crm();
    const assignee = (await repository.listAssignableUsers()).find((member) => String(member.id) === assignedToId);
    if (!assignee) throw new ForbiddenError("Choose an active sales executive.");

    const assigned: { id: string; owner: string; ownerId: string; status: string; taskCreated: boolean; warningCheckId: string }[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const leadId of ids) {
      try {
        const result = await repository.assignLead(leadId, assignedToId, user);
        assigned.push({ id: leadId, ...result });
      } catch (error) {
        failed.push({
          id: leadId,
          error: reportActionFailure("bulk lead assignment", error, "Could not assign this lead."),
        });
      }
    }
    if (assigned.length) scheduleCrmEffects("bulk lead reassign", ["leads", "visits"], LEAD_MUTATION_PATHS);
    return { assigned, failed };
  }, undefined, { input, action: "bulk-reassign-leads", section: "leads" });
}

export async function getAssignmentWarningsAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("leads");
    if (!canAssignLeads(user.role)) throw new ForbiddenError("You cannot check reassignment warnings.");
    const { id: warningCheckId } = z.object({ id }).parse(input);
    return getCachedValue<{ taskWarning?: string; historyWarning?: string }>(`assignment-warnings:${warningCheckId}`);
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
    scheduleCrmEffects("lead delete", ["leads", "visits"], LEAD_MUTATION_PATHS);
  }, undefined, { input, action: "delete-lead", section: "leads" });
}

export async function saveLeadUpdateAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("leads");
    const p = updateLeadSchema.parse(input);
    const current = await ownLeadOrThrow(user, p.id);
    if (p.assignedTo !== undefined) {
      if (!canAssignLeads(user.role)) throw new ForbiddenError("Only managers can assign leads.");
      if (p.assignedTo && !(await assignableNames()).includes(p.assignedTo)) throw new ForbiddenError("Choose a team member.");
    }
      if (p.status === "Lost Lead" && !p.lostReason) throw new ForbiddenError("Choose a reason before marking this lead lost.");
      const patch: LeadPatch = { status: p.status as LeadStatus | undefined, lostReason: p.lostReason as LostReason | undefined, remarks: p.remarks, assignedTo: p.assignedTo };
    const updated = await crm().updateLead(p.id, patch, user, current);
    scheduleCrmEffects("lead update", ["leads", "visits"], LEAD_MUTATION_PATHS);
    return {
      zohoUrl: zohoLeadUrl(p.id),
      lead: updated ?? {
        ...current,
        ...(p.status ? { status: p.status as LeadStatus } : {}),
        ...(p.lostReason ? { lostReason: p.lostReason as LostReason } : {}),
        ...(p.remarks !== undefined ? { remarks: p.remarks } : {}),
        ...(p.assignedTo !== undefined ? { assignedTo: p.assignedTo } : {}),
      },
    };
  }, undefined, { input, action: "save-lead-update", section: "leads" });
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
    const result = await crm().logCall({ ...data, notResponsiveAttempts: env().NOT_RESPONSIVE_ATTEMPTS }, user);
    scheduleCrmEffects("call outcome", ["leads", "visits", "performance"], WORK_MUTATION_PATHS);
    return result;
  }, undefined, { input, action: "log-call-outcome", section: "leads" });
}

const leadOutcomeSchema = z.object({
  leadId: id,
  outcome: z.enum(["Won", "Lost Lead"]),
  lostReason: z.enum(LOST_REASONS).optional(),
});

export async function setLeadOutcomeAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("leads");
    const data = leadOutcomeSchema.parse(input);
    if (data.outcome === "Lost Lead" && !data.lostReason) {
      throw new ForbiddenError("Choose a reason before marking this lead lost.");
    }
    const current = await ownLeadOrThrow(user, data.leadId);
    const lead = await crm().updateLead(data.leadId, {
      status: data.outcome,
      ...(data.lostReason ? { lostReason: data.lostReason } : {}),
    }, user, current);
    scheduleCrmEffects("lead outcome", ["leads", "quotes", "performance"], LEAD_MUTATION_PATHS);
    return {
      lead: lead ?? {
        ...current,
        status: data.outcome,
        ...(data.lostReason ? { lostReason: data.lostReason } : {}),
      },
    };
  }, undefined, { input, action: "set-lead-outcome", section: "leads" });
}

export async function fixAssignedLeadsAction(input?: unknown) {
  return run(async () => {
    const user = await requireActionUser("leads");
    if (user.role !== "Manager") throw new ForbiddenError("Only managers can fix assigned leads.");
    const changed = await crm().fixAssignedLeads(user);
    scheduleCrmEffects("fix assigned leads", ["leads", "visits"], LEAD_MUTATION_PATHS);
    return { changed };
  }, undefined, { input, action: "fix-assigned-leads", section: "leads" });
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
  items: z.array(z.object({
    productId: id,
    qty: z.number().int().min(1).max(10_000),
    discount: z.number().min(0).default(0),
    taxRate: z.number().min(0).max(1).optional(),
  })).min(1).max(50),
  extraCharges: z.array(z.object({
    label: z.string().trim().min(1).max(100),
    amount: z.number().min(0).max(100_000_000),
    taxRate: z.number().min(0).max(1).optional(),
  }).strict()).max(50).default([]),
});

export async function createQuoteAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("quotations");
    const q = quoteSchema.parse(input);
    const lead = await ownLeadOrThrow(user, q.leadId);
    const executive = lead.assignedTo ?? user.name;
    const repository = crm();
    const quote = await repository.createQuote({ ...q, offerNo: "" }, user, executive);
    scheduleCrmEffects("create quote", ["quotes", "leads", "performance"], QUOTE_MUTATION_PATHS);
    return quote;
  }, undefined, { input, action: "create-quote", section: "quotations" });
}

export async function updateQuoteAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("quotations");
    const { quoteId, ...quoteInput } = quoteSchema.extend({ quoteId: id }).parse(input);
    const repository = crm();
    const current = await repository.getQuote(quoteId);
    if (!current || visibleFor(user, [current]).length === 0) {
      throw new ForbiddenError("Quotation not found or access denied.");
    }
    if (user.role !== "Manager" && ["sent", "won"].includes((current.status ?? "").trim().toLowerCase())) {
      throw new ForbiddenError("Only managers can edit Sent or Won quotations.");
    }
    if (quoteInput.leadId !== current.leadId) {
      throw new ForbiddenError("The customer cannot be changed while editing a quotation.");
    }
    const updated = await repository.updateQuote(quoteId, quoteInput, user);
    await invalidateStoredQuotationPdf(quoteId);
    scheduleCrmEffects("revise quotation", ["quotes"], QUOTE_MUTATION_PATHS);
    return updated;
  }, undefined, { input, action: "update-quote", section: "quotations" });
}

const quotationEmailSchema = z.object({
  quoteId: id,
  to: z.string().trim().email("Enter a valid recipient email address.").max(254),
});

export async function sendQuotationEmailAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("quotations");
    const { quoteId, to } = quotationEmailSchema.parse(input);
    const config = env();
    if (config.EMAIL_PROVIDER === "disabled") {
      throw new ForbiddenError("Email is not configured.");
    }
    const repository = crm();
    const quote = await repository.getQuote(quoteId);
    if (!quote || visibleFor(user, [quote]).length === 0) {
      throw new ForbiddenError("Quotation not found or access denied.");
    }
    let pdf: Awaited<ReturnType<typeof getStoredQuotationPdf>> | undefined;
    try {
      pdf = await getStoredQuotationPdf(quoteId);
    } catch (error) {
      console.warn("[action] stored quotation PDF lookup failed; regenerating for email", {
        quoteId,
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!pdf?.url) {
      const blobToken = config.BLOB_READ_WRITE_TOKEN;
      if (!blobToken) {
        throw new ForbiddenError("PDF sharing is not configured. Set BLOB_READ_WRITE_TOKEN.");
      }
      if (!quote.items?.length) {
        throw new ForbiddenError("This quotation has no saved product lines to generate a PDF.");
      }
      const pdfInput = {
        quoteId: quote.id,
        quoteSnapshotToken: signQuotationPdfSnapshot(quote, user.id),
        offerNo: quote.offerNo,
        subject: quote.subject || offerSubject(quote.items.map((item) => item.model)),
        items: quote.items.map((item) => ({
          ...(item.productId ? { productId: item.productId } : {}),
          qty: item.qty,
          discount: item.discount ?? 0,
          taxRate: item.taxRate ?? GST_RATE,
        })),
        extraCharges: quote.gstBreakdown?.extraCharges ?? [],
      };
      const [{ put }, { generateQuotationPdfBytes }] = await Promise.all([
        import("@vercel/blob"),
        import("@/lib/quotation-pdf"),
      ]);
      const { bytes } = await generateQuotationPdfBytes(pdfInput, user);
      const safeOfferNo = quote.offerNo.replace(/[^A-Za-z0-9._-]/g, "-");
      const safeQuoteId = quote.id.replace(/[^A-Za-z0-9._-]/g, "-");
      let blob: Awaited<ReturnType<typeof put>>;
      try {
        blob = await put(`quotations/${safeOfferNo}-${safeQuoteId}.pdf`, bytes, {
          access: "public",
          contentType: "application/pdf",
          token: blobToken,
          allowOverwrite: true,
        });
      } catch (error) {
        console.error("[action] quotation PDF blob upload failed", {
          quoteId,
          stage: "blob_upload",
          errorName: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      if (new URL(blob.url).protocol !== "https:") {
        throw new Error("Vercel Blob returned a non-HTTPS quotation URL.");
      }
      pdf = { url: blob.url, ownerId: quote.ownerId, executive: quote.executive };
      try {
        await saveStoredQuotationPdf(quote.id, pdf);
      } catch (error) {
        console.warn("[action] quotation PDF URL cache write failed; continuing email", {
          quoteId,
          stage: "pdf_storage",
          errorName: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!await takeQuotationEmailRateLimit(user.id, quoteId)) {
      throw new ForbiddenError("Email limit reached. Try again later.");
    }
    const offerReference = `${quote.offerNo}${quote.revision ? `/R${quote.revision}` : ""}`;
    await sendEmail({
      to,
      subject: `Quotation ${offerReference} from ${COMPANY.name}`,
      text: [
        `Dear ${quote.contactName || quote.customer || "Customer"},`,
        "",
        `Please find your quotation ${offerReference} from ${COMPANY.name}.`,
        `Grand total: ${formatINR(quote.total)}`,
        `Quotation PDF: ${pdf.url}`,
        "",
        COMPANY.name,
        COMPANY.address,
        COMPANY.contact,
        `GSTIN: ${COMPANY.gstin}`,
      ].join("\n"),
    });
    let noteLogged = true;
    try {
      await repository.addLeadNote(
        quote.leadId,
        "Quotation emailed",
        `Quotation ${offerReference} emailed to ${to} by ${user.name}. PDF: ${pdf.url}`,
      );
    } catch (error) {
      noteLogged = false;
      reportActionFailure("log quotation email note", error, "The email was sent but its CRM note could not be logged.");
    }
    return { noteLogged };
  }, undefined, { input, action: "send-quotation-email", section: "quotations" });
}

const quotationSentSchema = z.object({ leadId: id.optional(), quoteId: id.optional() }).refine(
  (value) => !!value.leadId || !!value.quoteId,
  { message: "Quotation is missing." },
);

export async function markQuotationSentAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("quotations");
    const { leadId: requestedLeadId, quoteId } = quotationSentSchema.parse(input);
    const repository = crm();
    const quote = quoteId ? await repository.getQuote(quoteId) : null;
    if (quoteId && (!quote || visibleFor(user, [quote]).length === 0)) {
      throw new ForbiddenError("You can only update your own quotations.");
    }
    if (quote) await repository.markQuoteSent(quote.id);
    const leadId = requestedLeadId || quote?.leadId;
    if (leadId) {
      const lead = await ownLeadOrThrow(user, leadId);
      if (lead.status !== "Quotation Sent") {
        if (!canAdvanceLeadStatus(lead.status, "Quotation Sent")) {
          throw new ForbiddenError("A closed lead cannot be marked as quotation sent.");
        }
        await repository.updateLead(lead.id, { status: "Quotation Sent" }, user, lead);
      }
    }
    scheduleCrmEffects("mark quotation sent", ["leads", "quotes", "performance"], QUOTE_MUTATION_PATHS);
    return { status: "Quotation Sent" as const, quoteStatus: "Sent" as const };
  }, undefined, { input, action: "mark-quotation-sent", section: "quotations" });
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
    return { ok: true, data: { ...quote, pdfSnapshotToken: signQuotationPdfSnapshot(quote, user.id) } };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: error.message };
    if (error instanceof z.ZodError) return { ok: false, error: "Quotation not found." };
    return { ok: false, error: reportActionFailure("quotation detail", error, "Could not load quotation details.") };
  }
}

export async function getQuotationPdfUrlAction(rawId: string): Promise<ActionResult<string | null>> {
  return run(async () => {
    const user = await requireActionUser("quotations");
    const quoteId = id.parse(rawId);
    let stored: Awaited<ReturnType<typeof getStoredQuotationPdf>> | undefined;
    try {
      stored = await getStoredQuotationPdf(quoteId);
    } catch (error) {
      console.warn("[action] stored quotation PDF lookup failed", {
        quoteId,
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!stored) return null;
    if (visibleFor(user, [{ ownerId: stored.ownerId, executive: stored.executive }]).length === 0) {
      throw new ForbiddenError("You can only view your own quotations.");
    }
    return stored.url;
  }, undefined, { input: rawId, action: "quotation-pdf-url", section: "quotations" });
}

// ---------- Invoices ----------

const invoiceConversionSchema = z.object({
  quoteId: id,
  gstin: z.string().trim().toUpperCase().refine((value) => !value || /^[0-9A-Z]{15}$/.test(value), "Enter a valid 15-character GSTIN.").default(""),
  idempotencyKey: z.string().uuid().optional(),
});

export async function convertQuoteToInvoiceAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("invoices");
    const { quoteId, gstin } = invoiceConversionSchema.parse(input);
    const repository = crm();
    const quote = await repository.getQuote(quoteId);
    if (!quote || visibleFor(user, [quote]).length === 0) {
      throw new ForbiddenError("Quotation not found or access denied.");
    }
    const lead = await repository.getLead(quote.leadId);
    if (!lead || !canConvertToInvoice(quote, lead)) {
      throw new ForbiddenError("Only Won leads or accepted quotations can be converted to an invoice.");
    }
    if (!quote.items?.length) {
      throw new ForbiddenError("This quotation has no saved product lines to invoice.");
    }
    const existing = (await repository.listInvoices()).find((invoice) => invoice.quoteId === quote.id);
    if (existing) return existing;
    const invoice = await repository.createInvoice(quote, lead, user, gstin);
    scheduleCrmEffects("create invoice", ["invoices", "quotes"], ["/invoices", "/quotations", "/home"]);
    return invoice;
  }, undefined, { input, action: "convert-quote-to-invoice", section: "invoices" });
}

export async function getInvoicesAction(): Promise<ActionResult<import("@/lib/domain").Invoice[]>> {
  return run(async () => {
    const user = await requireActionUser("invoices");
    return (await crm().listInvoices()).filter((invoice) => canViewInvoice(user, invoice));
  });
}

const invoiceEmailSchema = z.object({
  invoiceId: id,
  to: z.string().trim().email("Enter a valid recipient email address.").max(254),
});

const invoicePdfUrlSchema = z.object({ invoiceId: id });

export async function getInvoicePdfUrlAction(input: unknown): Promise<ActionResult<{ url: string }>> {
  return run(async () => {
    const user = await requireActionUser("invoices");
    const { invoiceId } = invoicePdfUrlSchema.parse(input);
    const invoice = await crm().getInvoice(invoiceId);
    if (!invoice || !canViewInvoice(user, invoice)) {
      throw new ForbiddenError("Invoice not found or access denied.");
    }

    let storedPdf: Awaited<ReturnType<typeof getStoredInvoicePdf>> | undefined;
    try {
      storedPdf = await getStoredInvoicePdf(invoice.id);
    } catch (error) {
      console.warn("[action] stored invoice PDF lookup failed; regenerating", {
        invoiceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (storedPdf?.url) return { url: storedPdf.url };

    const blobToken = env().BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      throw new ForbiddenError("Invoice PDF sharing is not configured. Set BLOB_READ_WRITE_TOKEN.");
    }
    const [{ put }, { renderInvoicePdf }] = await Promise.all([
      import("@vercel/blob"),
      import("@/lib/invoice-pdf"),
    ]);
    const bytes = await renderInvoicePdf(invoice);
    const blob = await put(`invoices/${randomUUID()}.pdf`, Buffer.from(bytes), {
      access: "public",
      contentType: "application/pdf",
      token: blobToken,
    });
    try {
      await saveStoredInvoicePdf(invoice.id, {
        url: blob.url,
        ownerId: invoice.ownerId,
        executive: invoice.executive,
      });
    } catch (error) {
      console.warn("[action] invoice PDF URL could not be cached; returning the uploaded URL", {
        invoiceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { url: blob.url };
  }, undefined, { input, action: "get-invoice-pdf-url", section: "invoices" });
}

export async function sendInvoiceEmailAction(input: unknown) {
  return run(async () => {
    const user = await requireActionUser("invoices");
    const { invoiceId, to } = invoiceEmailSchema.parse(input);
    const repository = crm();
    const invoice = await repository.getInvoice(invoiceId);
    if (!invoice || !canViewInvoice(user, invoice)) {
      throw new ForbiddenError("Invoice not found or access denied.");
    }
    if (env().EMAIL_PROVIDER === "disabled") {
      throw new ForbiddenError("Email is not configured yet.");
    }
    let pdf = await getStoredInvoicePdf(invoice.id);
    if (!pdf?.url) {
      const blobToken = env().BLOB_READ_WRITE_TOKEN;
      if (!blobToken) throw new ForbiddenError("Email is not configured yet.");
      const [{ put }, { renderInvoicePdf }] = await Promise.all([
        import("@vercel/blob"),
        import("@/lib/invoice-pdf"),
      ]);
      const bytes = await renderInvoicePdf(invoice);
      const blob = await put(`invoices/${randomUUID()}.pdf`, Buffer.from(bytes), {
        access: "public",
        contentType: "application/pdf",
        token: blobToken,
      });
      pdf = { url: blob.url, ownerId: invoice.ownerId, executive: invoice.executive };
      await saveStoredInvoicePdf(invoice.id, pdf);
    }
    const pdfUrl = pdf.url;
    if (!await takeQuotationEmailRateLimit(user.id, invoice.id)) {
      throw new ForbiddenError("Email limit reached. Try again later.");
    }
    await sendEmail({
      to,
      subject: `Invoice ${invoice.invoiceNo} from ${COMPANY.name}`,
      text: [
        `Dear ${invoice.contactName || invoice.customer},`,
        "",
        `Please find your invoice ${invoice.invoiceNo} from ${COMPANY.name}.`,
        `Grand total: ${formatINR(invoice.total)}`,
        `Invoice PDF: ${pdfUrl}`,
        "",
        COMPANY.name,
        COMPANY.address,
        COMPANY.contact,
        `GSTIN: ${COMPANY.gstin}`,
      ].join("\n"),
    });
    let noteLogged = true;
    try {
      await repository.addLeadNote(
        invoice.leadId,
        "Invoice emailed",
        `Invoice ${invoice.invoiceNo} emailed to ${to} by ${user.name}. PDF: ${pdfUrl}`,
      );
    } catch (error) {
      noteLogged = false;
      reportActionFailure("log invoice email note", error, "The email was sent but its CRM note could not be logged.");
    }
    return { noteLogged };
  }, undefined, { input, action: "send-invoice-email", section: "invoices" });
}

export async function suggestOfferNoAction(): Promise<string> {
  await requireActionUser("quotations");
  try {
    return await crm().suggestOfferNo();
  } catch (error) {
    throw new Error(reportActionFailure("suggest offer number", error, "Could not suggest an offer number."));
  }
}

export async function getProductsAction(): Promise<ActionResult<import("@/lib/domain").Product[]>> {
  return run(async () => {
    await requireActionUser("quotations");
    return crm().listProducts();
  });
}

export async function refreshProductsAction(): Promise<ActionResult<import("@/lib/domain").Product[]>> {
  return run(async () => {
    const user = await requireActionUser("quotations");
    if (user.role !== "Manager") throw new ForbiddenError("Only managers can refresh products.");
    await invalidate("products");
    return crm().listProducts();
  });
}

const newProductSchema = z.object({
  name: z.string().trim().min(1, "Enter a product name.").max(120),
  code: z.string().trim().min(1, "Enter a product code.").max(60),
  unit: z.string().trim().min(1, "Enter a unit.").max(40),
  price: z.coerce.number().finite().positive().max(1_000_000_000),
  gstRate: z.coerce.number().finite().min(0).max(1),
});

export async function createProductAction(input: unknown): Promise<ActionResult<import("@/lib/domain").Product>> {
  return run(async () => {
    const user = await requireActionUser("quotations");
    if (user.role !== "Manager") throw new ForbiddenError("Only managers can add products.");
    const productInput: NewProduct = newProductSchema.parse(input);
    await invalidate("products");
    const existing = await crm().listProducts();
    const normalizedName = productInput.name.toLocaleLowerCase();
    const normalizedCode = productInput.code.toLocaleLowerCase();
    if (existing.some((product) => product.model.trim().toLocaleLowerCase() === normalizedName)) {
      throw new DuplicateProductError("A product with this name already exists.");
    }
    if (existing.some((product) => product.code?.trim().toLocaleLowerCase() === normalizedCode)) {
      throw new DuplicateProductError("A product with this code already exists.");
    }
    try {
      const created = await crm().createProduct(productInput);
      await invalidate("products");
      return created;
    } catch (error) {
      if (isZohoFailure(error) && ["DUPLICATE_DATA", "DUPLICATE_KEY"].includes(error.code ?? "")) {
        throw new DuplicateProductError("A product with this name or code already exists.");
      }
      throw error;
    }
  });
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
    const createdVisit = await crm().createVisit({ ...v, executive }, user);
    scheduleCrmEffects("schedule visit", ["visits", "leads"], WORK_MUTATION_PATHS);
    return createdVisit;
  }, undefined, { input, action: "schedule-visit", section: "visits" });
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
    if (p.date && p.date < todayIST()) throw new Error("Choose today or a future date.");
    const visit = await crm().getVisit(p.id);
    if (!visit) throw new ZohoError("This task no longer exists, refreshing…", 404, "NOT_FOUND", undefined, undefined, `GET /Tasks/${p.id}`);
    if (!canUpdateWorkItem(user, visit)) {
      throw new ForbiddenError("You can only update your own work.");
    }
    await crm().updateVisit(p.id, { status: p.status as VisitStatus | undefined, notes: p.notes, date: p.date, time: p.time, followUp: p.followUp }, user, visit);
    scheduleCrmEffects("update visit", ["visits", "leads"], WORK_MUTATION_PATHS);
  }, undefined, { input, action: "update-visit", section: "visits" });
}
