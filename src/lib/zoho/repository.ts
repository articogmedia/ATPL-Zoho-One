import "server-only";
import { cache } from "react";
import { canAdvanceLeadStatus, isAssignable, normalizePhone, quoteTotals, todayIST, uniqueProducts, type CallActivity, type Lead, type LeadTimelineItem, type User } from "@/lib/domain";
import { cached, invalidate } from "@/lib/cache";
import { env } from "@/lib/env";
import type { CrmRepository } from "@/lib/crm/repository";
import { zoho, zohoList, zohoWrite, ZohoError } from "./client";
import { ASSIGNED_STAGE, CALL_STATUS_BY_OUTCOME, FIELD, TASK_STATUS_WRITE, WRITE_LEAD_STATUS } from "./fields";
import {
  mapLead, mapNote, mapProduct, mapQuote, mapTask, mapUser, parseRoleOverrides,
  type ZCall, type ZLead, type ZNote, type ZProduct, type ZQuote, type ZTask, type ZUser,
} from "./mappers";
import { getSiteVisitsSchema, listSiteVisits, mapSiteVisitUpdate } from "./site-visits";

const LEAD_FIELDS = ["Last_Name", "First_Name", "Company", "Mobile", "Phone", "City", "Street", "Lead_Source", "Lead_Status", "Owner", "Description", "Created_Time", "Created_By", "Modified_By"];

export function leadPhoneMatch(record: ZLead, normalizedPhone: string): "Mobile" | "Phone" | null {
  if (normalizePhone(String(record.Mobile ?? "")) === normalizedPhone) return "Mobile";
  if (normalizePhone(String(record.Phone ?? "")) === normalizedPhone) return "Phone";
  return null;
}

export function leadPhoneSearchCriteria(normalizedPhone: string): string {
  const variants = [normalizedPhone, `+91${normalizedPhone}`, `91${normalizedPhone}`, `0${normalizedPhone}`];
  const fields = variants.flatMap((variant) =>
    [`(Mobile:equals:${variant})`, `(Phone:equals:${variant})`],
  );
  return `(${fields.join("or")})`;
}
const TASK_FIELDS = ["Subject", "Status", "Due_Date", "Owner", "Who_Id", "What_Id", "Description", ...Object.values(FIELD.task)];
const CALL_FIELDS = ["Subject", "Call_Start_Time", "Call_Type", "Owner", "What_Id", "Call_Result"];
const QUOTE_FIELDS = ["Subject", "Status", "Owner", "Created_Time", "Grand_Total", ...Object.values(FIELD.quote)];

const SHORT = 60_000;   // transactional lists
const LONG = 600_000;   // users, products
const STANDARD_TASK_FIELDS = ["Subject", "Status", "Due_Date", "Owner", "Who_Id", "What_Id", "Description"];
const relatedToLead = (leadId: string) => ({ What_Id: { id: leadId }, $se_module: "Leads" });
const leadCreateLocks = new Map<string, Promise<unknown>>();
const taskRows = cache(() => cached("visits:tasks", SHORT, async () => {
  try {
    return await zohoList<ZTask>("Tasks", TASK_FIELDS, 1000);
  } catch (error) {
    console.error("[zoho] Tasks custom fields unavailable; retrying with standard fields", {
      operation: "GET /Tasks",
      code: error instanceof ZohoError ? error.code : undefined,
      status: error instanceof ZohoError ? error.status : undefined,
    });
    return zohoList<ZTask>("Tasks", STANDARD_TASK_FIELDS, 1000);
  }
}));

const users = cache(async function users(): Promise<User[]> {
  const mappedUsers = await cached("users", LONG, async () => {
    const json = await zoho<{ users: ZUser[] }>("GET", "/users", { query: { type: "ActiveUsers" } });
    const overrides = parseRoleOverrides(env().ZOHO_ROLE_OVERRIDES);
    const rawUsers = json?.users ?? [];
    const mapped = rawUsers.map((u) => mapUser(u, overrides));
    const unmapped = rawUsers.filter((u, i) => !mapped[i]).map((u) =>
      `${u.full_name} (role: ${u.role?.name ?? "none"}, profile: ${u.profile?.name ?? "none"})`,
    );
    if (rawUsers.length > 0 && !mapped.some((u) => u?.role === "Sales Executive")) {
      console.warn(`[zoho] No Sales Executives mapped. Unmapped users: ${unmapped.join("; ") || "none"}`);
    } else if (unmapped.length) {
      console.warn(`[zoho] Unmapped active users: ${unmapped.join("; ")}`);
    }
    return mapped.filter((u): u is User => !!u);
  });
  if (!mappedUsers.length) invalidate("users");
  return mappedUsers;
});

const listAssignableUsers = async () => {
  const queueOwnerId = env().ZOHO_QUEUE_OWNER_ID;
  return (await users()).filter((u) => isAssignable(u, queueOwnerId));
};
const assignableIds = async () => new Set((await listAssignableUsers()).map((u) => String(u.id).trim()));
const userByName = async (name: string) => {
  const u = (await users()).find((x) => x.name === name);
  if (!u) throw new ZohoError(`No active Zoho user named "${name}"`);
  return u;
};

export async function advanceLead(leadId: string, currentStatus: Lead["status"], target: "Site Visit Scheduled" | "Quotation Sent"): Promise<boolean> {
  if (!canAdvanceLeadStatus(currentStatus, target)) return false;
  await zohoWrite("PUT", `/Leads/${leadId}`, { Lead_Status: WRITE_LEAD_STATUS[target] }, { trigger: ["workflow"] });
  invalidate("leads");
  return true;
}
const activeUserById = async (id: string) => {
  const expected = String(id).trim();
  return (await users()).find((u) => String(u.id).trim() === expected);
};
const queueOwnerId = async () => {
  const configured = env().ZOHO_QUEUE_OWNER_ID;
  if (!configured) throw new ZohoError("Set ZOHO_QUEUE_OWNER_ID to an active Zoho user");
  if (!(await activeUserById(configured))) {
    throw new ZohoError(`ZOHO_QUEUE_OWNER_ID "${configured}" is not an active Zoho user`);
  }
  return configured.trim();
};

const leads = cache(async function leads(): Promise<Lead[]> {
  return cached("leads", SHORT, async () => {
    const [raw, assignable, tasks, allUsers] = await Promise.all([
      zohoList<ZLead>("Leads", LEAD_FIELDS, env().ZOHO_MAX_LEADS),
      assignableIds(),
      taskRows().catch((error) => {
        console.error("[zoho] Tasks unavailable while loading leads", {
          operation: "GET /Tasks",
          code: error instanceof ZohoError ? error.code : undefined,
          status: error instanceof ZohoError ? error.status : undefined,
        });
        return [];
      }),
      users(),
    ]);
    const salesExecutives = new Set(allUsers.filter((user) => user.role === "Sales Executive").map((user) => String(user.id).trim()));
    const followUps = new Map<string, { date: string; time: string }>();
    for (const task of tasks) {
      const leadId = task.What_Id?.id ?? task.Who_Id?.id;
      const date = String(task[FIELD.task.followUp] ?? "");
      if (leadId && date && (!followUps.has(leadId) || date > followUps.get(leadId)!.date)) {
        followUps.set(leadId, { date, time: String(task[FIELD.task.visitTime] ?? "") });
      }
    }
    return raw.map((z) => {
      const lead = mapLead(z, assignable, salesExecutives);
      const followUp = followUps.get(lead.id);
      return followUp ? { ...lead, followUp: followUp.date, followUpTime: followUp.time } : lead;
    }).sort((a, b) => b.createdOn.localeCompare(a.createdOn));
  });
});
const leadMap = async () => new Map((await leads()).map((l) => [l.id, l]));

async function addNote(leadId: string, title: string, content: string) {
  await zohoWrite("POST", "/Notes", {
    Note_Title: title, Note_Content: content, Parent_Id: { id: leadId, module: { api_name: "Leads" } },
  });
}

export const zohoRepository: CrmRepository = {
  listUsers: users,
  listAssignableUsers,
  async findUserByEmail(email) {
    const normalized = email.trim().toLowerCase();
    return (await users()).find((u) => u.email?.trim().toLowerCase() === normalized) ?? null;
  },

  listLeads: leads,
  async getLead(id) {
    const cachedLead = (await leadMap()).get(id);
    if (cachedLead) return cachedLead;
    try {
      const response = await zoho<{ data?: ZLead[] }>("GET", `/Leads/${encodeURIComponent(id)}`, {
        query: { fields: LEAD_FIELDS.join(",") },
      });
      const record = response?.data?.[0];
      if (!record) throw new ZohoError("Lead not found", 404, "NOT_FOUND", undefined, undefined, `GET /Leads/${id}`);
      const [assignable, allUsers] = await Promise.all([assignableIds(), users()]);
      const salesExecutives = new Set(allUsers.filter((user) => user.role === "Sales Executive").map((user) => String(user.id).trim()));
      return mapLead(record, assignable, salesExecutives);
    } catch (error) {
      if (error instanceof ZohoError && error.status === 404) return null;
      throw error;
    }
  },
  async findLeadByPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;
    const result = await zoho<{ data?: ZLead[] }>("GET", "/Leads/search", {
      query: { fields: LEAD_FIELDS.join(","), criteria: leadPhoneSearchCriteria(normalized), per_page: 200 },
    }).catch(() => null);
    for (const record of result?.data ?? []) {
      const matchedField = leadPhoneMatch(record, normalized);
      if (!matchedField) continue;
      const assignable = await assignableIds();
      return { lead: mapLead(record, assignable), matchedField };
    }
    const search = await zoho<{ data?: ZLead[] }>("GET", "/Leads/search", {
      query: { fields: LEAD_FIELDS.join(","), phone: normalized, per_page: 200 },
    }).catch(() => null);
    for (const record of search?.data ?? []) {
      const matchedField = leadPhoneMatch(record, normalized);
      if (record && matchedField) {
        const assignable = await assignableIds();
        return { lead: mapLead(record, assignable), matchedField };
      }
    }
    return null;
  },

  async createLead(input, actor, assignTo, forceCreate = false) {
    const existing = forceCreate ? null : await this.findLeadByPhone(input.phone);
    if (existing) throw new ZohoError("Duplicate lead", 409, "DUPLICATE_LEAD");
    const phoneKey = input.phone.replace(/\D/g, "").slice(-10);
    const previous = leadCreateLocks.get(phoneKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    leadCreateLocks.set(phoneKey, chain);
    await previous;
    try {
      if (!forceCreate && await this.findLeadByPhone(input.phone)) throw new ZohoError("Duplicate lead", 409, "DUPLICATE_LEAD");
    const executiveCreatesLead = actor.role === "Sales Executive";
    const owner = executiveCreatesLead
      ? await userByName(actor.name)
      : assignTo ? await userByName(assignTo) : null;
    const queueOwner = !owner ? await queueOwnerId() : undefined;
    const status = owner ? ASSIGNED_STAGE : "Fresh Lead";
    const leadSource = input.source;
    const record: Record<string, unknown> = {
      Last_Name: input.name.trim(),
      ...(input.company.trim() ? { Company: input.company.trim() } : {}),
      Mobile: input.phone,
      ...(input.area.trim() ? { City: input.area.trim() } : {}),
      Lead_Source: leadSource,
      Lead_Status: WRITE_LEAD_STATUS[status],
      ...(input.remarks.trim() ? { Description: input.remarks.trim() } : {}),
      ...(owner ? { Owner: { id: owner.id } } : { Owner: { id: queueOwner } }),
    };
    const id = await zohoWrite("POST", "/Leads", record, { trigger: ["workflow"] });
    try {
      await addNote(id, "Lead created", `Lead created from ${input.source} by ${actor.name}`);
    } catch (error) {
      console.error("[zoho] secondary lead-created note failed", {
        leadId: id, operation: "POST /Notes",
        status: error instanceof ZohoError ? error.status : undefined,
        code: error instanceof ZohoError ? error.code : undefined,
        field: error instanceof ZohoError ? error.field : undefined,
      });
    }
    if (owner) {
      try {
        await addNote(id, "Lead assigned", `Assigned to ${owner.name} by ${actor.name} on ${new Date().toISOString()}`);
        await zohoWrite("POST", "/Tasks", {
          Subject: "Call new lead",
          Status: TASK_STATUS_WRITE.Assigned,
          Due_Date: todayIST(),
          Owner: { id: owner.id },
          ...relatedToLead(id),
        });
      } catch (error) {
        console.error("[zoho] secondary lead assignment work failed", {
          leadId: id, operation: "POST /Notes or POST /Tasks",
          status: error instanceof ZohoError ? error.status : undefined,
          code: error instanceof ZohoError ? error.code : undefined,
          field: error instanceof ZohoError ? error.field : undefined,
        });
      }
    }
    invalidate("leads", "users");
    const assignable = await assignableIds();
    try {
      const created = await zoho<{ data?: ZLead[] }>("GET", `/Leads/${id}`, {
        query: { fields: LEAD_FIELDS.join(",") },
      });
      const createdRecord = created?.data?.[0];
      if (createdRecord) return mapLead(createdRecord, assignable, new Set((await users()).filter((user) => user.role === "Sales Executive").map((user) => String(user.id))));
    } catch (error) {
      console.error("[zoho] created lead verification failed; using verified creation input", {
        leadId: id,
        operation: `GET /Leads/${id}`,
        status: error instanceof ZohoError ? error.status : undefined,
        code: error instanceof ZohoError ? error.code : undefined,
      });
    }
    return {
      id, name: input.name.trim(), company: input.company.trim(), phone: input.phone,
      area: input.area.trim(), source: input.source, status: owner ? ASSIGNED_STAGE : "Fresh Lead",
      assignedTo: owner?.name ?? null, assignedToId: owner?.id, ownerId: owner?.id ?? queueOwner,
      remarks: input.remarks.trim(), createdOn: todayIST(), address: "", touchedBy: [actor.name],
    };
    } finally {
      release();
      if (leadCreateLocks.get(phoneKey) === chain) leadCreateLocks.delete(phoneKey);
    }
  },

  async assignLead(id, assignee, actor) {
    if (actor.role !== "Manager" && actor.role !== "Calling Team") throw new ZohoError("Only managers and the calling team can assign leads.");
    const current = await this.getLead(id);
    if (!current) throw new ZohoError("Lead not found", 404);
    const owner = await userByName(assignee);
    const nextStatus = current.status === "Fresh Lead" ? ASSIGNED_STAGE : current.status;
    const record = {
      Owner: { id: owner.id },
      ...(nextStatus !== current.status ? { Lead_Status: WRITE_LEAD_STATUS[nextStatus] } : {}),
    };
    if (current.ownerId !== owner.id || record.Lead_Status) {
      try {
        await zohoWrite("PUT", `/Leads/${id}`, record, { trigger: ["workflow"] });
      } catch (error) {
        throw new ZohoError(`Lead assignment failed while updating owner/status: ${error instanceof Error ? error.message : "Zoho rejected the update"}`);
      }
    }

    const verified = await zoho<{ data?: ZLead[] }>("GET", `/Leads/${id}`, {
      query: { fields: LEAD_FIELDS.join(",") },
    });
    const persisted = verified?.data?.[0];
    if (!persisted || String(persisted.Owner?.id ?? "") !== String(owner.id)) {
      throw new ZohoError(`Lead assignment could not be verified in Zoho CRM: GET /Leads/${id}`, undefined, "ASSIGNMENT_NOT_VERIFIED", undefined, undefined, `GET /Leads/${id}`);
    }

    let taskCreated = false;
    let taskWarning: string | undefined;
    const relatedTasks = await zoho<{ data?: ZTask[] }>("GET", `/Leads/${id}/Tasks`, {
      query: { fields: TASK_FIELDS.join(","), page: 1, per_page: 200, sort_by: "Created_Time", sort_order: "desc" },
    }).catch(async () =>
      zoho<{ data?: ZTask[] }>("GET", "/Tasks", {
        query: { fields: TASK_FIELDS.join(","), page: 1, per_page: 200, sort_by: "Created_Time", sort_order: "desc" },
      }).catch(() => null),
    );
    const existingTasks = relatedTasks?.data?.length
      ? relatedTasks
      : await zoho<{ data?: ZTask[] }>("GET", "/Tasks", {
          query: { fields: TASK_FIELDS.join(","), page: 1, per_page: 200, sort_by: "Created_Time", sort_order: "desc" },
        }).catch(() => null);
    const hasAssignmentTask = (existingTasks?.data ?? []).some((task) =>
      task.Subject === "Call new lead" &&
      String(task.Owner?.id ?? "") === String(owner.id) &&
      String(task.What_Id?.id ?? task.Who_Id?.id ?? "") === String(id),
    );
    if (!hasAssignmentTask) {
      try {
        await zohoWrite("POST", "/Tasks", {
          Subject: "Call new lead",
          Status: TASK_STATUS_WRITE.Assigned,
          Due_Date: todayIST(),
          Owner: { id: owner.id },
          ...relatedToLead(id),
        });
        taskCreated = true;
      } catch (error) {
        taskWarning = error instanceof ZohoError
          ? `Follow-up task creation failed (${error.operation ?? "POST /Tasks"}${error.code ? `: ${error.code}` : ""}${error.field ? `, field: ${error.field}` : ""})`
          : "Follow-up task creation failed.";
        console.error("[zoho] reassignment follow-up task failed", {
          leadId: id, ownerId: owner.id, operation: "POST /Tasks",
          status: error instanceof ZohoError ? error.status : undefined,
          code: error instanceof ZohoError ? error.code : undefined,
          field: error instanceof ZohoError ? error.field : undefined,
        });
      }
    }

    try {
      await addNote(id, "Lead assigned", `Assigned to ${owner.name} by ${actor.name} on ${new Date().toISOString()}`);
    } catch (error) {
      console.error("[zoho] reassignment note failed", {
        leadId: id, operation: "POST /Notes",
        status: error instanceof ZohoError ? error.status : undefined,
        code: error instanceof ZohoError ? error.code : undefined,
        field: error instanceof ZohoError ? error.field : undefined,
      });
    }
    invalidate("leads", "users", "visits");
    return { owner: owner.name, status: mapLead(persisted, await assignableIds()).status, taskCreated, taskWarning };
  },

  async fixAssignedLeads(actor) {
    if (actor.role !== "Manager") throw new ZohoError("Only managers can fix assigned leads.");
    const [allLeads, allUsers] = await Promise.all([leads(), users()]);
    const salesIds = new Set(allUsers.filter((user) => user.role === "Sales Executive").map((user) => String(user.id).trim()));
    const stale = allLeads.filter((lead) => lead.status === "Fresh Lead" && salesIds.has(String(lead.ownerId ?? "").trim()));
    for (const lead of stale) {
      try {
        await zohoWrite("PUT", `/Leads/${lead.id}`, { Lead_Status: WRITE_LEAD_STATUS[ASSIGNED_STAGE] }, { trigger: ["workflow"] });
      } catch (error) {
        throw new ZohoError(`Fix assigned leads failed for ${lead.name}: ${error instanceof Error ? error.message : "Zoho rejected the update"}`);
      }
    }
    invalidate("leads");
    return stale.length;
  },
  async listFixableAssignedLeads(actor) {
    if (actor.role !== "Manager") throw new ZohoError("Only managers can inspect assigned leads.");
    const [allLeads, allUsers] = await Promise.all([leads(), users()]);
    const salesUsers = new Map(allUsers
      .filter((user) => user.role === "Sales Executive")
      .map((user) => [String(user.id).trim(), user.name]));
    return allLeads
      .filter((lead) => lead.status === "Fresh Lead" && salesUsers.has(String(lead.ownerId ?? "").trim()))
      .map((lead) => ({
        id: lead.id,
        name: lead.name,
        ownerName: salesUsers.get(String(lead.ownerId ?? "").trim()) ?? "",
      }));
  },

  async updateLead(id, p, actor) {
    const current = await this.getLead(id);
    if (!current) throw new ZohoError("Lead not found", 404);
    const record: Record<string, unknown> = {};
    const parts: string[] = [];

    if (p.name?.trim() && p.name.trim() !== current.name) {
      record.Last_Name = p.name.trim();
      record.First_Name = null;
      parts.push("Name updated");
    }
    if (p.company !== undefined && p.company.trim() !== current.company) { record.Company = p.company.trim() || "-"; parts.push("Company updated"); }
    if (p.phone?.trim() && p.phone.trim() !== current.phone) { record.Mobile = p.phone.trim(); parts.push("Phone updated"); }
    if (p.source && p.source !== current.source) { record.Lead_Source = p.source; parts.push(`Source: ${p.source}`); }

    if (p.status && p.status !== current.status) {
      record.Lead_Status = WRITE_LEAD_STATUS[p.status];
      parts.push(`Result: ${p.status}`);
    }
    if (p.assignedTo !== undefined && p.assignedTo !== current.assignedTo) {
      if (p.assignedTo) {
        record.Owner = { id: (await userByName(p.assignedTo)).id };
        parts.push(`Assigned to ${p.assignedTo}`);
      } else {
        record.Owner = { id: await queueOwnerId() };
        parts.push("Unassigned");
      }
    }
    if (p.remarks?.trim()) { record.Description = p.remarks.trim(); parts.push(`"${p.remarks.trim()}"`); }
    if (!parts.length) return;

    await zohoWrite("PUT", `/Leads/${id}`, record, { trigger: ["workflow"] });
    await addNote(id, "Lead update", `${parts.join(" · ")} (by ${actor.name})`);
    invalidate("leads", "users");
  },

  async deleteLead(id) {
    const json = await zoho<{ data?: { code?: string; message?: string }[] }>("DELETE", "/Leads", { query: { ids: id } });
    const result = json?.data?.[0];
    if (!result || result.code !== "SUCCESS") {
      throw new ZohoError(result?.message ?? "Zoho could not delete the lead", undefined, result?.code);
    }
    invalidate("leads", "users");
  },

  async getLeadHistory(id) {
    const json = await zoho<{ data?: ZNote[] }>("GET", `/Leads/${id}/Notes`, {
      query: { fields: "Note_Content,Created_Time,Created_By", sort_by: "Created_Time", sort_order: "desc", per_page: 50 },
    });
    return (json?.data ?? []).map(mapNote);
  },

  async getLeadTimeline(id): Promise<LeadTimelineItem[]> {
    const [notes, calls, tasks] = await Promise.all([
      zoho<{ data?: ZNote[] }>("GET", `/Leads/${id}/Notes`),
      zoho<{ data?: ZCall[] }>("GET", `/Leads/${id}/Calls`, { query: { fields: CALL_FIELDS.join(",") } }),
      zoho<{ data?: ZTask[] }>("GET", `/Leads/${id}/Tasks`, { query: { fields: TASK_FIELDS.join(",") } }),
    ]);
    const timeline: LeadTimelineItem[] = [
      ...(notes?.data ?? []).map((n) => ({ date: n.Created_Time?.slice(0, 10) ?? "", user: n.Created_By?.name ?? "", kind: "Note" as const, title: "Note", detail: n.Note_Content ?? "" })),
      ...(calls?.data ?? []).map((c) => ({ date: c.Call_Start_Time?.slice(0, 10) ?? "", user: c.Owner?.name ?? "", kind: "Call" as const, title: String(c[FIELD.call.result] ?? c.Subject ?? "Call"), detail: String(c.Subject ?? "") })),
      ...(tasks?.data ?? []).map((t) => ({ date: t.Due_Date ?? "", user: t.Owner?.name ?? "", kind: "Task" as const, title: String(t.Subject ?? "Task"), detail: t.Description ?? "" })),
    ];
    return timeline.sort((a, b) => b.date.localeCompare(a.date));
  },

  async logCall(input, actor) {
    const lead = await this.getLead(input.leadId);
    if (!lead) throw new ZohoError("Lead not found", 404);
    const status = CALL_STATUS_BY_OUTCOME[input.outcome];
    await zohoWrite("POST", "/Calls", {
      Subject: `${input.outcome} - ${lead.name}`,
      What_Id: { id: lead.id }, Call_Type: "Outbound",
      [FIELD.call.result]: input.outcome,
      [FIELD.call.startTime]: new Date().toISOString(),
      Description: input.remarks || undefined, Owner: { id: actor.id },
    });
    await zohoWrite("PUT", `/Leads/${lead.id}`, { Lead_Status: WRITE_LEAD_STATUS[status] }, { trigger: ["workflow"] });
    await addNote(lead.id, "Call logged", `${input.outcome}${input.remarks ? `: ${input.remarks}` : ""} (by ${actor.name} at ${new Date().toISOString()})`);
    if (input.followUp) {
      const owner = lead.assignedTo ? await userByName(lead.assignedTo) : actor;
      await zohoWrite("POST", "/Tasks", {
        Subject: `Follow-up call - ${lead.name}`, Status: TASK_STATUS_WRITE.Assigned,
        Due_Date: input.followUp, Owner: { id: owner.id }, ...relatedToLead(lead.id),
        [FIELD.task.isSiteVisit]: false, [FIELD.task.visitTime]: input.followUpTime || undefined,
        [FIELD.task.nextAction]: "Follow up call", [FIELD.task.followUp]: input.followUp,
      });
    }
    invalidate("leads", "users", "visits");
  },

  async listCalls(): Promise<CallActivity[]> {
    return cached("visits:calls", SHORT, async () => {
      const raw = await zohoList<ZCall>("Calls", CALL_FIELDS, env().ZOHO_MAX_LEADS);
      return raw.map((call) => ({
        id: String(call.id).trim(),
        leadId: String(call.What_Id?.id ?? "").trim(),
        ownerId: String(call.Owner?.id ?? "").trim(),
        date: call.Call_Start_Time?.slice(0, 10) ?? "",
      }));
    });
  },

  async listProducts() {
    return cached("products", LONG, async () => {
      const fieldAttempts = [
        ["Product_Name", "Product_Code", "Description", "Unit_Price", "Usage_Unit", "Product_Active"],
        ["Product_Name", "Unit_Price", "Product_Code", "Product_Active"],
        ["Product_Name", "Unit_Price"],
      ];
      let lastError: unknown;
      for (const fields of fieldAttempts) {
        try {
          const raw = await zohoList<ZProduct & { Product_Active?: boolean }>("Products", fields, 1000, {
            sort_by: "id",
            sort_order: "asc",
          });
          const products = uniqueProducts(raw
            .filter((product) => product.Product_Active !== false)
            .filter((product) => Boolean(product.Product_Name?.trim()))
            .map(mapProduct));
          if (products.length === 0) invalidate("products");
          return products;
        } catch (error) {
          lastError = error;
          const zohoError = error as Partial<ZohoError> | null;
          const status = zohoError?.status;
          const code = zohoError?.code;
          const field = zohoError?.field;
          console.error("[zoho] Products catalogue fields rejected; trying fallback", {
            operation: "GET /Products",
            fields: fields.join(","),
            status,
            code,
            field,
          });
        }
      }
      throw lastError;
    });
  },

  async listQuotes() {
    return cached("quotes", SHORT, async () => {
      const [raw, map] = await Promise.all([zohoList<ZQuote>("Quotes", QUOTE_FIELDS, 1000), leadMap()]);
      return raw.map((z) => mapQuote(z, map));
    });
  },

  async getQuote(id) {
    const response = await zoho<{ data?: ZQuote[] }>("GET", `/Quotes/${encodeURIComponent(id)}`, {
      query: { fields: [...QUOTE_FIELDS, "Quoted_Items"].join(",") },
    });
    const record = response?.data?.[0];
    if (!record) return null;
    const [map, products] = await Promise.all([leadMap(), this.listProducts()]);
    return mapQuote(record, map, new Map(products.map((product) => [product.id, product])));
  },

  async createQuote(input, actor, executive) {
    const [lead, products, owner] = await Promise.all([this.getLead(input.leadId), this.listProducts(), userByName(executive)]);
    if (!lead) throw new ZohoError("Lead not found", 404);
    // Prices come from the Zoho catalogue, never from the browser.
    const lines = input.items.map((i) => {
      const p = products.find((x) => x.id === i.productId);
      if (!p) throw new ZohoError("Unknown product");
      const discount = Math.min(p.price * i.qty, Math.max(0, i.discount));
      return { p, qty: i.qty, discount, amount: p.price * i.qty - discount };
    });
    const totals = quoteTotals(lines.map((l) => ({ model: l.p.model, unit: l.p.unit, qty: l.qty, price: l.p.price, discount: l.discount })));
    const customer = lead.company || lead.name;
    const id = await zohoWrite("POST", "/Quotes", {
      Subject: `Offer ${input.offerNo} - ${customer}`,
      [FIELD.quote.offerNo]: input.offerNo,
      [FIELD.quote.lead]: { id: lead.id },
      Owner: { id: owner.id },
      Quoted_Items: lines.map((l) => ({
        Product_Name: { id: l.p.id }, Quantity: l.qty, List_Price: l.p.price,
        Discount: l.discount, Total: l.p.price * l.qty, Total_After_Discount: l.amount, Net_Total: l.amount,
      })),
      Sub_Total: totals.subtotal, Discount: totals.discount, Grand_Total: totals.total,
    });
    await addNote(lead.id, "Quotation created", `Quotation ${input.offerNo} created by ${actor.name}`);
    await advanceLead(lead.id, lead.status, "Quotation Sent");
    invalidate("quotes", "leads");
    return { id, offerNo: input.offerNo, leadId: lead.id, customer, executive, total: totals.total, status: "Draft", date: new Date().toISOString().slice(0, 10) };
  },

  async listVisits() {
    return cached("visits", SHORT, async () => {
      const [raw, map] = await Promise.all([taskRows(), leadMap()]);
      const tasks = raw.map((z) => mapTask(z, map));
      try {
        const schema = await getSiteVisitsSchema();
        if (!schema) return tasks;
        const siteVisits = await listSiteVisits(schema, map);
        const keys = new Set(siteVisits.map((visit) => `${visit.leadId}:${visit.date}`));
        return [...siteVisits, ...tasks.filter((task) => task.isVisit && !keys.has(`${task.leadId}:${task.date}`))];
      } catch (error) {
        console.error("[zoho] Site Visits module unavailable; falling back to Tasks", {
          status: error instanceof ZohoError ? error.status : undefined,
          code: error instanceof ZohoError ? error.code : undefined,
          field: error instanceof ZohoError ? error.field : undefined,
        });
        return tasks;
      }
    });
  },
  async getVisit(id) { return (await this.listVisits()).find((v) => v.id === id) ?? null; },

  async createVisit(input, actor) {
    const [owner, lead] = await Promise.all([userByName(input.executive), this.getLead(input.leadId)]);
    if (!lead) throw new ZohoError("Lead not found", 404);
    const address = input.address?.trim() || [lead.address, lead.area].filter(Boolean).join(", ");
    await zohoWrite("POST", "/Tasks", {
      Subject: `${input.type} - ${lead.company || lead.name}`,
      Status: TASK_STATUS_WRITE.Assigned, Due_Date: input.date, Owner: { id: owner.id },
      ...relatedToLead(lead.id),
      [FIELD.task.type]: input.type, [FIELD.task.isSiteVisit]: input.isVisit,
      [FIELD.task.visitTime]: input.time, [FIELD.task.nextAction]: input.nextAction,
      [FIELD.task.followUp]: input.followUp || undefined,
    });
    if (input.isVisit) {
      const start = `${input.date}T${input.time}:00+05:30`;
      const endMinutes = Number(input.time.slice(0, 2)) * 60 + Number(input.time.slice(3)) + 60;
      const end = `${input.date}T${String(Math.floor(endMinutes / 60) % 24).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}:00+05:30`;
      await zohoWrite("POST", "/Events", {
        Event_Title: `${input.type} - ${lead.company || lead.name}`,
        Start_DateTime: start, End_DateTime: end, Location: address || undefined,
        ...relatedToLead(lead.id), Owner: { id: owner.id },
        Description: input.nextAction || undefined,
      });
    }
    await addNote(lead.id, "Work scheduled", `${input.isVisit ? "Site visit" : "Work"} scheduled: ${input.type} on ${input.date} (by ${actor.name})`);
    if (input.isVisit) await advanceLead(lead.id, lead.status, "Site Visit Scheduled");
    invalidate("visits");
  },

  async updateVisit(id, p, actor) {
    const current = await this.getVisit(id);
    if (!current) throw new ZohoError("Visit not found", 404);
    if (current.module) {
      const schema = await getSiteVisitsSchema();
      if (!schema) throw new ZohoError("Site Visits schema unavailable", 404);
      await zohoWrite("PUT", `/${schema.module}/${id}`, mapSiteVisitUpdate(schema, p));
      if (p.notes?.trim() && current.leadId) await addNote(current.leadId, "Work update", `Notes: ${p.notes.trim()} (by ${actor.name})`);
      invalidate("visits");
      return;
    }
    const record: Record<string, unknown> = {};
    if (p.status) record.Status = TASK_STATUS_WRITE[p.status];
    if (p.notes) record.Description = p.notes;
    if (p.date) record.Due_Date = p.date;
    if (p.time) record[FIELD.task.visitTime] = p.time;
    if (p.followUp) record[FIELD.task.followUp] = p.followUp;
    await zohoWrite("PUT", `/Tasks/${id}`, record);
    const changes = [
      p.status ? `Status: ${p.status}` : "",
      p.date ? `Date: ${p.date}` : "",
      p.time ? `Time: ${p.time}` : "",
      p.followUp ? `Follow-up: ${p.followUp}` : "",
      p.notes?.trim() ? `Notes: ${p.notes.trim()}` : "",
    ].filter(Boolean);
    if (changes.length) await addNote(current.leadId, "Work update", `${changes.join(" · ")} (by ${actor.name})`);
    invalidate("visits");
  },
};
