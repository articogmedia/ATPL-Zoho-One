import "server-only";
import { isAssignable, quoteTotals, type Lead, type User } from "@/lib/domain";
import { cached, invalidate } from "@/lib/cache";
import { env } from "@/lib/env";
import type { CrmRepository } from "@/lib/crm/repository";
import { zoho, zohoList, zohoWrite, ZohoError } from "./client";
import { FIELD, TASK_STATUS_WRITE, WRITE_LEAD_STATUS } from "./fields";
import {
  mapLead, mapNote, mapProduct, mapQuote, mapTask, mapUser, parseRoleOverrides,
  type ZLead, type ZNote, type ZProduct, type ZQuote, type ZTask, type ZUser,
} from "./mappers";

const LEAD_FIELDS = ["Last_Name", "First_Name", "Company", "Mobile", "Phone", "City", "Street", "Lead_Source", "Lead_Status", "Owner", "Description", "Created_Time", "Created_By", "Modified_By"];
const TASK_FIELDS = ["Subject", "Status", "Due_Date", "Owner", "Who_Id", "Description", ...Object.values(FIELD.task)];
const QUOTE_FIELDS = ["Subject", "Owner", "Created_Time", "Grand_Total", ...Object.values(FIELD.quote)];

const SHORT = 20_000;   // transactional lists
const LONG = 300_000;   // users, products

async function users(): Promise<User[]> {
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
}

const assignableNames = async () => {
  const queueOwnerId = env().ZOHO_QUEUE_OWNER_ID;
  return new Set((await users()).filter((u) => isAssignable(u, queueOwnerId)).map((u) => u.name));
};
const userByName = async (name: string) => {
  const u = (await users()).find((x) => x.name === name);
  if (!u) throw new ZohoError(`No active Zoho user named "${name}"`);
  return u;
};
const activeUserById = async (id: string) => {
  const json = await zoho<{ users: ZUser[] }>("GET", "/users", { query: { type: "ActiveUsers" } });
  return (json?.users ?? []).find((u) => u.id === id);
};
const queueOwnerId = async () => {
  const configured = env().ZOHO_QUEUE_OWNER_ID;
  if (!configured) throw new ZohoError("Set ZOHO_QUEUE_OWNER_ID to an active Zoho user");
  if (!(await activeUserById(configured))) {
    throw new ZohoError(`ZOHO_QUEUE_OWNER_ID "${configured}" is not an active Zoho user`);
  }
  return configured;
};

async function leads(): Promise<Lead[]> {
  return cached("leads", SHORT, async () => {
    const [raw, assignable] = await Promise.all([zohoList<ZLead>("Leads", LEAD_FIELDS, env().ZOHO_MAX_LEADS), assignableNames()]);
    return raw.map((z) => mapLead(z, assignable));
  });
}
const leadMap = async () => new Map((await leads()).map((l) => [l.id, l]));

async function addNote(leadId: string, title: string, content: string) {
  await zohoWrite("POST", "/Notes", {
    Note_Title: title, Note_Content: content, Parent_Id: { module: { api_name: "Leads" }, id: leadId },
  });
}

export const zohoRepository: CrmRepository = {
  listUsers: users,
  async findUserByEmail(email) {
    return (await users()).find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
  },

  listLeads: leads,
  async getLead(id) { return (await leadMap()).get(id) ?? null; },

  async createLead(input, actor, assignTo) {
    const owner = assignTo ? await userByName(assignTo) : null;
    const queueOwner = !owner ? await queueOwnerId() : undefined;
    const record: Record<string, unknown> = {
      Last_Name: input.name, Company: input.company || "-", Mobile: input.phone, City: input.area,
      Lead_Source: input.source, Lead_Status: WRITE_LEAD_STATUS["Fresh Lead"], Description: input.remarks || undefined,
      ...(owner ? { Owner: { id: owner.id } } : { Owner: { id: queueOwner } }),
    };
    const id = await zohoWrite("POST", "/Leads", record, { trigger: ["workflow"] });
    await addNote(id, "Lead created", `Lead created from ${input.source} by ${actor.name}`);
    invalidate("leads", "users");
    return (await leadMap()).get(id) ?? {
      id, ...input, status: "Fresh Lead", assignedTo: assignTo, createdOn: new Date().toISOString().slice(0, 10),
      address: "", touchedBy: [actor.name],
    };
  },

  async updateLead(id, p, actor) {
    const current = await this.getLead(id);
    if (!current) throw new ZohoError("Lead not found", 404);
    const record: Record<string, unknown> = {};
    const parts: string[] = [];

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

  async getLeadHistory(id) {
    const json = await zoho<{ data?: ZNote[] }>("GET", `/Leads/${id}/Notes`, {
      query: { fields: "Note_Content,Created_Time,Created_By", sort_by: "Created_Time", sort_order: "desc", per_page: 50 },
    });
    return (json?.data ?? []).map(mapNote);
  },

  async listProducts() {
    return cached("products", LONG, async () => {
      const raw = await zohoList<ZProduct & { Product_Active?: boolean }>("Products", ["Product_Name", "Unit_Price", "Usage_Unit", "Product_Active"], 1000);
      return raw.filter((p) => p.Product_Active !== false).map(mapProduct).sort((a, b) => a.model.localeCompare(b.model));
    });
  },

  async listQuotes() {
    return cached("quotes", SHORT, async () => {
      const [raw, map] = await Promise.all([zohoList<ZQuote>("Quotes", QUOTE_FIELDS, 1000), leadMap()]);
      return raw.map((z) => mapQuote(z, map));
    });
  },

  async createQuote(input, actor, executive) {
    const [lead, products, owner] = await Promise.all([this.getLead(input.leadId), this.listProducts(), userByName(executive)]);
    if (!lead) throw new ZohoError("Lead not found", 404);
    // Prices come from the Zoho catalogue, never from the browser.
    const lines = input.items.map((i) => {
      const p = products.find((x) => x.id === i.productId);
      if (!p) throw new ZohoError("Unknown product");
      return { p, qty: i.qty, amount: p.price * i.qty };
    });
    const { total } = quoteTotals(lines.map((l) => ({ model: l.p.model, unit: l.p.unit, qty: l.qty, price: l.p.price })));
    const customer = lead.company || lead.name;
    const id = await zohoWrite("POST", "/Quotes", {
      Subject: `Offer ${input.offerNo} - ${customer}`,
      [FIELD.quote.offerNo]: input.offerNo,
      [FIELD.quote.lead]: { id: lead.id },
      Owner: { id: owner.id },
      Quoted_Items: lines.map((l) => ({
        Product_Name: { id: l.p.id }, Quantity: l.qty, List_Price: l.p.price,
        Total: l.amount, Total_After_Discount: l.amount, Net_Total: l.amount,
      })),
      Sub_Total: total, Grand_Total: total,
    });
    await addNote(lead.id, "Quotation created", `Quotation ${input.offerNo} created by ${actor.name}`);
    invalidate("quotes", "leads");
    return { id, offerNo: input.offerNo, leadId: lead.id, customer, executive, total, date: new Date().toISOString().slice(0, 10) };
  },

  async listVisits() {
    return cached("visits", SHORT, async () => {
      const [raw, map] = await Promise.all([zohoList<ZTask>("Tasks", TASK_FIELDS, 1000), leadMap()]);
      return raw.map((z) => mapTask(z, map));
    });
  },
  async getVisit(id) { return (await this.listVisits()).find((v) => v.id === id) ?? null; },

  async createVisit(input, actor) {
    const [owner, lead] = await Promise.all([userByName(input.executive), this.getLead(input.leadId)]);
    if (!lead) throw new ZohoError("Lead not found", 404);
    await zohoWrite("POST", "/Tasks", {
      Subject: `${input.type} - ${lead.company || lead.name}`,
      Status: TASK_STATUS_WRITE.Assigned, Due_Date: input.date, Owner: { id: owner.id },
      Who_Id: { id: lead.id },
      [FIELD.task.type]: input.type, [FIELD.task.isSiteVisit]: input.isVisit,
      [FIELD.task.visitTime]: input.time, [FIELD.task.nextAction]: input.nextAction,
      [FIELD.task.followUp]: input.followUp || undefined,
    });
    await addNote(lead.id, "Work scheduled", `${input.isVisit ? "Site visit" : "Work"} scheduled: ${input.type} on ${input.date} (by ${actor.name})`);
    invalidate("visits");
  },

  async updateVisit(id, p, actor) {
    const current = await this.getVisit(id);
    if (!current) throw new ZohoError("Visit not found", 404);
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
