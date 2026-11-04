import "server-only";
import { cached } from "@/lib/cache";
import { env } from "@/lib/env";
import { zoho, zohoList } from "./client";
import type { Lead, Visit, VisitStatus } from "@/lib/domain";

type ZohoField = {
  api_name?: string;
  field_label?: string;
  label?: string;
  data_type?: string;
  lookup?: { module?: { api_name?: string } } | { module?: string };
  pick_list_values?: { display_value?: string; actual_value?: string }[];
};

export type SiteVisitsSchema = {
  module: string;
  lead?: string;
  date?: string;
  time?: string;
  status?: string;
  address?: string;
  notes?: string;
  nextAction?: string;
  followUp?: string;
  statusValues: Record<VisitStatus, string>;
};

const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const label = (field: ZohoField) => field.field_label ?? field.label ?? "";
const apiName = (field: ZohoField) => String(field.api_name ?? "").trim();

function lookupModule(field: ZohoField): string {
  const lookup = field.lookup;
  if (!lookup) return "";
  const moduleValue = lookup.module;
  return typeof moduleValue === "string" ? moduleValue : moduleValue?.api_name ?? "";
}

function findField(fields: ZohoField[], match: (field: ZohoField) => boolean) {
  return fields.find(match) ? apiName(fields.find(match)!) : undefined;
}

export async function getSiteVisitsSchema(): Promise<SiteVisitsSchema | null> {
  return cached("site-visits-schema", 600_000, async () => {
    try {
      const override = env().ZOHO_SITE_VISITS_MODULE?.trim();
      let moduleApiName = override;
      if (!moduleApiName) {
        const response = await zoho<{ modules?: { api_name?: string; module_name?: string; plural_label?: string; singular_label?: string }[] }>("GET", "/settings/modules");
        const matched = response?.modules?.find((module) =>
          /site.?visits?/i.test(`${module.api_name ?? ""} ${module.module_name ?? ""} ${module.plural_label ?? ""} ${module.singular_label ?? ""}`),
        );
        moduleApiName = matched?.api_name ?? matched?.module_name;
      }

      if (!moduleApiName) return null;

      const response = await zoho<{ fields?: ZohoField[] }>("GET", "/settings/fields", { query: { module: moduleApiName } });
      const fields = response?.fields ?? [];
      const text = (field: ZohoField) => normalise(label(field));
      const date = findField(fields, (field) => /date|datetime/.test(field.data_type?.toLowerCase() ?? "") || /visitdate|scheduleddate|dateofvisit/.test(normalise(label(field))));
      const lead = findField(fields, (field) => field.data_type === "lookup" && /lead/i.test(lookupModule(field))) ??
        findField(fields, (field) => field.data_type === "lookup" && /lead/i.test(text(field)));
      const time = findField(fields, (field) => text(field).includes("time") && /date/.test(label(field)) === false);
      const address = findField(fields, (field) => /address|location/.test(text(field)));
      const notes = findField(fields, (field) => /notes?|remarks?|description/.test(text(field)));
      const nextAction = findField(fields, (field) => /nextaction|followupaction/.test(text(field)));
      const followUp = findField(fields, (field) => /followupdate/.test(text(field)));
      const statusField = fields.find((field) => /status|stage/.test(text(field)) && field.pick_list_values?.length);

      const statusValues = { Assigned: "", "In Progress": "", Completed: "" } as Record<VisitStatus, string>;
      for (const option of statusField?.pick_list_values ?? []) {
        const value = option.actual_value ?? option.display_value ?? "";
        const normalised = normalise(option.display_value ?? value);
        if (/assign|schedule|planned/.test(normalised)) statusValues.Assigned ||= value;
        if (/progress|started/.test(normalised)) statusValues["In Progress"] ||= value;
        if (/complete|done|closed/.test(normalised)) statusValues.Completed ||= value;
      }

      return {
        module: moduleApiName,
        lead, date, time, address, notes, nextAction, followUp,
        status: apiName(statusField ?? {}),
        statusValues,
      };
    } catch (error) {
      console.error("[zoho] Site Visits schema unavailable", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  });
}

export const siteVisitSchema = getSiteVisitsSchema;

function isoDate(value: unknown): string {
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  if (/^\d{2}-\d{2}-\d{4}/.test(text)) return `${text.slice(6)}-${text.slice(3, 5)}-${text.slice(0, 2)}`;
  return "";
}

function isoTime(value: unknown): string {
  const text = String(value ?? "").trim();
  const match = text.match(/(\d{1,2}):(\d{2})/);
  return match?.[1] && match[2] ? `${match[1].padStart(2, "0")}:${match[2]}` : text;
}

export async function listSiteVisits(schema: SiteVisitsSchema, leads: ReadonlyMap<string, Lead>): Promise<Visit[]> {
  if (!schema.lead || !schema.date) return [];
  const leadField = schema.lead!;
  const dateField = schema.date!;
  const fields = [...new Set([schema.lead, schema.date, schema.time, schema.status, schema.address, schema.notes, schema.nextAction, schema.followUp, "Owner", "Name"].filter(Boolean) as string[])];
  const records = await zohoList<Record<string, unknown>>(schema.module, fields, 1000);
  return records.map((record) => {
    const related = record[leadField] as { id?: string; name?: string } | undefined;
    const lead = related?.id ? leads.get(related.id) : undefined;
    const rawStatus = String(schema.status ? record[schema.status] ?? "" : "");
    const status: VisitStatus = Object.entries(schema.statusValues).find(([, value]) => value && value === rawStatus)?.[0] as VisitStatus ??
      (/progress|started/i.test(rawStatus) ? "In Progress" : /complete|done|closed/i.test(rawStatus) ? "Completed" : "Assigned");
    const owner = record.Owner as { name?: string; id?: string } | undefined;
    const dateValue = record[dateField];
    return {
      id: String(record.id ?? ""),
      module: schema.module,
      leadId: related?.id ?? "",
      customer: lead ? lead.company || lead.name : related?.name ?? "",
      address: String(schema.address ? record[schema.address] ?? lead?.address ?? "" : lead?.address ?? ""),
      area: lead?.area ?? "",
      executive: owner?.name ?? "",
      executiveId: owner?.id,
      type: String(record[schema.nextAction ?? ""] ?? record.Name ?? "Site Visit"),
      isVisit: true,
      date: isoDate(dateValue),
      time: isoTime(schema.time ? record[schema.time] : String(dateValue).slice(11, 16)),
      status,
      nextAction: String(schema.nextAction ? record[schema.nextAction] ?? "" : ""),
      followUp: isoDate(schema.followUp ? record[schema.followUp] : ""),
      notes: String(schema.notes ? record[schema.notes] ?? "" : ""),
      done: status === "Completed",
    };
  }).filter((visit) => visit.id && visit.leadId);
}

export function mapSiteVisitUpdate(schema: SiteVisitsSchema, patch: { status?: VisitStatus; date?: string; time?: string; notes?: string; followUp?: string }): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  if (patch.status && schema.status) record[schema.status] = schema.statusValues[patch.status] || patch.status;
  if (patch.date && schema.date) record[schema.date] = patch.date;
  if (patch.time && schema.time) record[schema.time] = patch.time;
  if (patch.notes && schema.notes) record[schema.notes] = patch.notes;
  if (patch.followUp && schema.followUp) record[schema.followUp] = patch.followUp;
  return record;
}
