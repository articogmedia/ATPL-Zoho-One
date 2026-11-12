import "server-only";
import { cache } from "react";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { canAdvanceLeadStatus, DEFAULT_NOT_RESPONSIVE_ATTEMPTS, GST_RATE, isAssignable, LEAD_SOURCES, nextOfferNo, normalizePhone, quotationGstBreakdown, summarizeLeadCalls, summarizeLeads, todayIST, uniqueProducts, type CallActivity, type CallOutcome, type Lead, type LeadSource, type LeadTimelineItem, type Product, type Quotation, type QuoteGstBreakdown, type User, type Visit } from "@/lib/domain";
import { cached, getCachedValue, invalidate, markStale, setCachedValue, withIdempotency } from "@/lib/cache";
import { env } from "@/lib/env";
import { offerSubject } from "@/lib/company";
import type { CrmRepository, LogCallInput, NewProduct } from "@/lib/crm/repository";
import { hosts, zoho, zohoList, zohoWrite, ZohoError, ZOHO_CRM_API_VERSION } from "./client";
import { ASSIGNED_STAGE, CALL_STATUS_BY_OUTCOME, FIELD, TASK_STATUS_WRITE, WRITE_LEAD_STATUS, zohoLeadSource } from "./fields";
import {
  mapLead, mapNote, mapProduct, mapQuote, mapTask, mapUser, parseRoleOverrides,
  parseQuoteCustomerSnapshot, quoteLineItemsField, invoiceLineItemsField, type InvoiceLineItemsField, type QuoteCustomerSnapshot, type QuoteLineItemsField, type ZCall, type ZEvent, type ZLead, type ZNote, type ZProduct, type ZQuote, type ZTask, type ZUser,
} from "./mappers";
import { getSiteVisitsSchema, listSiteVisits, mapSiteVisitRecord, mapSiteVisitUpdate } from "./site-visits";
import { zohoDateTime } from "./date-time";
import { leadSearchCriteria } from "./search";
import { invoiceSnapshot } from "@/lib/invoice-rules";
import { mapZohoInvoice, type ZohoInvoiceRecord } from "@/lib/invoice-mappers";
import { nextInvoiceNumber } from "@/lib/invoice-number";

const LEAD_FIELDS = ["Last_Name", "First_Name", "Company", "Mobile", "Phone", FIELD.lead.email, FIELD.lead.accountId, "City", "Lead_Source", "Lead_Status", "Owner", "Description", "Created_Time", "Created_By", "Modified_By"];
const LEAD_DETAIL_FIELDS = [...LEAD_FIELDS, "Street", "Created_By", "Modified_By"];

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
const TASK_FIELDS = ["Subject", "Status", "Due_Date", "Owner", "Who_Id", "What_Id", "Description", "Created_Time", ...Object.values(FIELD.task)];
const NOTE_FIELDS = ["Note_Title", "Note_Content", "Created_Time", "Owner", "Created_By"];
const CALL_FIELDS = ["Subject", "Call_Start_Time", "Call_Type", "Owner", "What_Id", "Call_Result", "Description"];
const EVENT_FIELDS = ["Event_Title", "Start_DateTime", "Created_Time", "Owner", "Description"];
const QUOTE_FIELDS = [...new Set(["Subject", FIELD.quote.stage, "Owner", "Created_Time", "Sub_Total", "Discount", "Tax", "Adjustment", "Grand_Total", "Account_Name", "Contact_Name", "Valid_Till", "Description", ...Object.values(FIELD.quote)])];

const SHORT = () => env().CACHE_SHORT_TTL_MS;
const LONG = 600_000;   // users and field metadata
const PRODUCTS_TTL = 120_000;
const STANDARD_TASK_FIELDS = ["Subject", "Status", "Due_Date", "Owner", "Who_Id", "What_Id", "Description"];
let productFieldSet: string[] | undefined;
type QuoteFieldMetadata = {
  api_name?: string;
  field_label?: string;
  data_type?: string;
  json_type?: string;
  max_length?: number;
  lookup?: { api_name?: string; module?: { api_name?: string; id?: string } };
  system_mandatory?: boolean;
  required?: boolean;
  is_mandatory?: boolean;
  read_only?: boolean;
  pick_list_values?: { actual_value?: string; display_value?: string }[];
  subform?: { fields?: QuoteLineItemFieldMetadata[] };
  subform_fields?: QuoteLineItemFieldMetadata[];
  fields?: QuoteLineItemFieldMetadata[];
  is_dependent?: boolean;
  depends_on?: string | { api_name?: string };
  dependent_on?: string | { api_name?: string };
  dependent_fields?: (string | { api_name?: string })[];
};

type QuoteLineItemFieldMetadata = {
  api_name?: string;
  field_label?: string;
  data_type?: string;
  required?: boolean;
  system_mandatory?: boolean;
  is_mandatory?: boolean;
};

function quoteLineItemFields(field?: QuoteFieldMetadata): QuoteLineItemFieldMetadata[] {
  return field?.subform_fields ?? field?.fields ?? field?.subform?.fields ?? [];
}

type QuoteLayoutField = {
  api_name?: string;
  field_label?: string;
  required?: boolean;
  system_mandatory?: boolean;
};

type QuoteLayout = {
  name?: string;
  id?: string;
  is_default?: boolean;
  default?: boolean;
  fields?: QuoteLayoutField[];
  sections?: { fields?: QuoteLayoutField[] }[];
};

function quoteLeadReference(field: QuoteFieldMetadata, leadId: string): string | { id: string } | undefined {
  const normalizedLeadId = leadId.trim();
  if (!normalizedLeadId) throw new ZohoError("The selected lead has no Zoho record ID.", 400, "INVALID_LEAD_REFERENCE", FIELD.quote.lead);
  if (field.read_only) return undefined;
  const dataType = field.data_type?.trim().toLowerCase();
  if (dataType === "lookup") {
    const targetModule = field.lookup?.module?.api_name?.trim();
    if (targetModule?.toLowerCase() !== "leads") {
      return undefined;
    }
    return { id: normalizedLeadId };
  }
  if (["text", "string", "singleline", "single_line"].includes(dataType ?? "")) {
    if (field.max_length !== undefined && normalizedLeadId.length > field.max_length) {
      return undefined;
    }
    return normalizedLeadId;
  }
  return undefined;
}

function requiredQuoteLayoutFields(layouts: QuoteLayout[]): { layout: string | null; fields: string[] } {
  const selectedLayouts = layouts.filter((layout) => layout.is_default === true || layout.default === true);
  const selected = selectedLayouts.length === 1 ? selectedLayouts[0] : layouts.length === 1 ? layouts[0] : undefined;
  if (!selected) return { layout: null, fields: [] };
  const fields = [...(selected.fields ?? []), ...(selected.sections ?? []).flatMap((section) => section.fields ?? [])]
    .filter((field) => field.required === true || field.system_mandatory === true)
    .map((field) => field.api_name)
    .filter((name): name is string => !!name);
  return { layout: selected.name ?? selected.id ?? null, fields: [...new Set(fields)] };
}

const relatedToLead = (leadId: string) => ({ What_Id: { id: leadId }, $se_module: "Leads" });
function noteLeadReference(leadId: string): Record<string, unknown> {
  const majorVersion = Number(String(ZOHO_CRM_API_VERSION ?? "v6").replace(/^v/i, ""));
  return majorVersion >= 6
    ? { Parent_Id: { module: { api_name: "Leads" }, id: leadId } }
    : { Parent_Id: { id: leadId }, se_module: "Leads" };
}
const leadCreateLocks = new Map<string, Promise<unknown>>();
type ZohoLeadField = {
  api_name?: string;
  field_label?: string;
  pick_list_values?: { actual_value?: string; display_value?: string }[];
};

const leadSchema = async () => {
  const schema = await cached("zoho:lead-schema", LONG, async () => {
    const response = await zoho<{
      fields?: ZohoLeadField[];
    }>("GET", "/settings/fields", { query: { module: "Leads" } });
    const fields = response?.fields ?? [];
    const fieldNames = fields.map((field) => field.api_name).filter((name): name is string => !!name);
    return {
      fields,
      fieldNames,
      sourceValues: fields.find((field) => field.api_name === "Lead_Source")?.pick_list_values
        ?.map((item) => item.actual_value?.trim() || item.display_value?.trim() || "")
        .filter(Boolean) ?? [],
      areaField: fields.find((field) => field.api_name === "City")?.api_name
        ?? fields.find((field) => field.api_name === "Area" || field.field_label?.trim().toLowerCase() === "area")?.api_name
        ?? null,
      remarksField: fieldNames.includes("Description") ? "Description" : null,
    };
  });
  return { ...schema, fieldNames: new Set(schema.fieldNames) };
};
const quoteSchema = async () => {
  const schema = await cached("zoho:quote-schema", LONG, async () => {
    const [response, layoutsResponse] = await Promise.all([
      zoho<{ fields?: QuoteFieldMetadata[] }>("GET", "/settings/fields", { query: { module: "Quotes" } }),
      zoho<{ layouts?: QuoteLayout[] }>("GET", "/settings/layouts", { query: { module: "Quotes" } })
        .catch((error: unknown) => {
          console.error("[zoho] Quotes layout metadata unavailable", {
            operation: "GET /settings/layouts?module=Quotes",
            status: error instanceof ZohoError ? error.status : undefined,
            code: error instanceof ZohoError ? error.code : undefined,
            message: error instanceof Error ? error.message : String(error),
          });
          return null;
        }),
    ]);
    const fields = response?.fields ?? [];
    const layouts = layoutsResponse?.layouts ?? [];
    const layoutRequirements = requiredQuoteLayoutFields(layouts);
    if (layouts.length > 1 && !layoutRequirements.layout) {
      console.warn("[zoho] no default Quotes layout could be identified; using field metadata for mandatory validation", {
        layouts: layouts.map((layout) => ({ id: layout.id, name: layout.name, is_default: layout.is_default, default: layout.default })),
      });
    }
    return {
      fields,
      fieldNames: fields.map((field) => field.api_name).filter((name): name is string => !!name),
      mandatoryFields: [...new Set([...fields
        .filter((field) => field.system_mandatory === true || field.required === true || field.is_mandatory === true)
        .map((field) => field.api_name)
        .filter((name): name is string => !!name), ...layoutRequirements.fields])],
      mandatoryLayout: layoutRequirements.layout,
      layoutRequiredFields: layoutRequirements.fields,
    };
  });
  return {
    ...schema,
    fieldNames: new Set(schema.fieldNames),
    fieldsByName: new Map(schema.fields.filter((field): field is typeof field & { api_name: string } => !!field.api_name)
      .map((field) => [field.api_name, field])),
  };
};

type InvoiceFieldMetadata = QuoteFieldMetadata;
const invoiceSchema = async () => {
  const schema = await cached("zoho:invoice-schema", LONG, async () => {
    const response = await zoho<{ fields?: InvoiceFieldMetadata[] }>(
      "GET", "/settings/fields", { query: { module: "Invoices" } },
    );
    const fields = response?.fields ?? [];
    return {
      fields,
      fieldNames: fields.map((field) => field.api_name).filter((name): name is string => !!name),
    };
  });
  return {
    ...schema,
    fieldNames: new Set(schema.fieldNames),
    fieldsByName: new Map(schema.fields.filter((field): field is typeof field & { api_name: string } => !!field.api_name)
      .map((field) => [field.api_name, field])),
  };
};

function quoteLineItemsPayload(
  lineItemsField: QuoteLineItemsField | InvoiceLineItemsField,
  lines: { p: Product; qty: number; discount: number; amount: number; taxRate: number }[],
  fieldMetadata?: QuoteFieldMetadata,
  configuredTaxes: Product["zohoTaxes"] = [],
): Record<string, unknown>[] {
  const subfields = quoteLineItemFields(fieldMetadata);
  const availableNames = new Set(subfields.map((field) => field.api_name).filter((name): name is string => !!name));
  const supportsLineTax = availableNames.has("Line_Tax");
  if (subfields.length) {
    console.info("[zoho] CRM line-item field metadata", {
      lineItemsField,
      subfieldApiNames: [...availableNames],
    });
  } else {
    console.info("[zoho] CRM line-item subfield metadata unavailable; using documented inventory fields", {
      lineItemsField,
    });
  }

  const configuredTaxForRate = (product: Product, rate: number) =>
    product.zohoTaxes?.find((configured) => Math.abs(configured.rate - rate) < 0.000001)
      ?? configuredTaxes.find((configured) => Math.abs(configured.rate - rate) < 0.000001);
  const missingTaxMappings = lines.filter(({ p, taxRate }) =>
    taxRate > 0 && (!supportsLineTax || !configuredTaxForRate(p, taxRate)),
  );
  if (missingTaxMappings.length) {
    console.warn("[zoho] no configured Quotes line-tax mapping for some GST rates; computed quote-level GST totals are retained", {
      lineItemsField,
      supportsLineTax,
      unmatchedRates: [...new Set(missingTaxMappings.map((line) => line.taxRate))],
      productIds: [...new Set(missingTaxMappings.map((line) => line.p.id))],
    });
  }

  return lines.map(({ p, qty, discount, amount, taxRate }) => {
    const tax = configuredTaxForRate(p, taxRate);
    const lineTax = supportsLineTax && tax
      ? [{ percentage: tax.percentage, name: tax.name }]
      : undefined;
    if (lineItemsField === "Product_Details") {
      return {
        product: { id: p.id },
        quantity: qty,
        list_price: p.price,
        Discount: discount,
        total: p.price * qty,
        total_after_discount: amount,
        net_total: amount,
        ...(lineTax ? { Line_Tax: lineTax } : {}),
        ...(p.description ? { Description: p.description } : {}),
      };
    }

    const candidates: Record<string, unknown> = {
      Product_Name: { id: p.id },
      Quantity: qty,
      List_Price: p.price,
      Unit_Price: p.price,
      Discount: discount,
      Total: p.price * qty,
      Net_Total: amount,
      Total_After_Discount: amount,
      Description: p.description,
      Line_Tax: lineTax,
    };
    const newItem: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(candidates)) {
      if ((!subfields.length || availableNames.has(name)) && value !== undefined && value !== "") newItem[name] = value;
    }
    if (subfields.length && !availableNames.has("List_Price") && availableNames.has("Unit_Price")) {
      delete newItem.List_Price;
    } else {
      delete newItem.Unit_Price;
    }
    return newItem;
  });
}

const TAX_FIELD_WRITE_STATUSES = new Set([200, 400, 422]);
const TAX_FIELD_REFERENCE = /(?:^|[^A-Za-z0-9_])(?:Line_Tax|Tax)(?:$|[^A-Za-z0-9_])/i;

function isTaxFieldWriteFailure(error: unknown): error is ZohoError {
  if (!(error instanceof ZohoError)) return false;

  // Zoho CRM can return HTTP 200 while rejecting an individual record in
  // data[0] with status: "error". zohoWrite converts that response into a
  // ZohoError(status=200), so 200 must be accepted here as well as HTTP errors.
  if (!TAX_FIELD_WRITE_STATUSES.has(error.status ?? 0)) return false;

  const details = error.details ?? {};
  const fieldReferences = [
    error.field,
    details.api_name,
    details.json_path,
    details.field,
    details.param_name,
    details.path,
    details.message,
    error.message,
  ].filter((value): value is string => typeof value === "string");

  return fieldReferences.some((value) => TAX_FIELD_REFERENCE.test(value));
}

async function writeQuoteWithTaxFallback(
  method: "POST" | "PUT",
  path: string,
  record: Record<string, unknown>,
  lineItemsField: QuoteLineItemsField,
  gstAmount: number,
  adjustmentAmount: number,
): Promise<string> {
  try {
    return await zohoWrite(method, path, record);
  } catch (error) {
    if (!isTaxFieldWriteFailure(error)) throw error;
    const operation = `${method} ${path}`;
    console.error("[zoho] quotation tax write rejected; retrying without unsupported tax fields", {
      operation,
      reference: error.reference,
      status: error.status,
      field: error.field ?? error.details?.api_name ?? error.details?.json_path,
      code: error.code,
      message: error.message,
      details: error.details,
      gstAmount,
      adjustmentAmount,
      quotePayloadKeys: Object.keys(record),
    });
    const fallbackLines = (record[lineItemsField] as Record<string, unknown>[]).map((line) => {
      const fallbackLine = { ...line };
      delete fallbackLine.Line_Tax;
      return fallbackLine;
    });
    const fallbackRecord: Record<string, unknown> = {
      ...record,
      [lineItemsField]: fallbackLines,
      Adjustment: gstAmount + adjustmentAmount,
    };
    delete fallbackRecord.Tax;
    try {
      const savedId = await zohoWrite(method, path, fallbackRecord);
      console.info("[zoho] quotation tax fallback saved", {
        operation,
        reference: error.reference,
        quoteId: savedId,
        gstPreservedInAdjustment: gstAmount,
        adjustment: fallbackRecord.Adjustment,
      });
      return savedId;
    } catch (fallbackError) {
      console.error("[zoho] quotation tax fallback failed", {
        operation,
        reference: error.reference,
        originalMessage: error.message,
        fallbackMessage: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        fallbackStatus: fallbackError instanceof ZohoError ? fallbackError.status : undefined,
        fallbackCode: fallbackError instanceof ZohoError ? fallbackError.code : undefined,
        fallbackReference: fallbackError instanceof ZohoError ? fallbackError.reference : undefined,
      });
      throw fallbackError;
    }
  }
}

const sourceValueForZoho = (source: Lead["source"], sourceValues: string[]) => {
  const exactValue = zohoLeadSource(source, sourceValues, false);
  if (!exactValue) {
    console.warn("[zoho] requested Lead_Source is not configured", {
      requestedSource: source,
      configuredValues: sourceValues,
    });
    throw new ZohoError(
      `Lead source "${source}" is not set up in Zoho. Add it under Setup → Modules and Fields → Leads → Lead Source.`,
      400, "INVALID_PICKLIST", "Lead_Source", source, "GET /settings/fields",
      { availableValues: sourceValues },
    );
  }
  return exactValue;
};
let taskMetadataWarning: string | null = null;

const taskSchema = () => cached("zoho:task-fields", LONG, async () => {
  const response = await zoho<{ fields?: { api_name?: string; pick_list_values?: { actual_value?: string; display_value?: string }[] }[] }>(
    "GET", "/settings/fields", { query: { module: "Tasks" } },
  );
  const fields = response?.fields ?? [];
  const fieldNames = new Set(fields.map((field) => field.api_name).filter((name): name is string => !!name));
  const missingCustomFields = Object.values(FIELD.task).filter((name) => !fieldNames.has(name));
  const missingStandardFields = ["Subject", "Status", "Due_Date", "Owner", "What_Id"].filter((name) => !fieldNames.has(name));
  const statusField = fields.find((field) => field.api_name === "Status");
  const statusValues = statusField?.pick_list_values?.map((item) => item.actual_value ?? item.display_value ?? "").filter(Boolean) ?? [];
  const hasStatuses = ["Not Started", "In Progress", "Completed"].every((expected) =>
    statusValues.some((value) => value.toLowerCase() === expected.toLowerCase()),
  );
  const warningParts = [
    missingStandardFields.length ? `Tasks standard fields unavailable: ${missingStandardFields.join(", ")}` : "",
    missingCustomFields.length ? `Tasks fields unavailable: ${missingCustomFields.join(", ")}` : "",
    statusValues.length && !hasStatuses ? `Tasks Status picklist differs from expected values: ${statusValues.join(", ")}` : "",
  ].filter(Boolean);
  return {
    fields: [...STANDARD_TASK_FIELDS.filter((name) => fieldNames.has(name)), ...Object.values(FIELD.task).filter((name) => fieldNames.has(name))],
    warning: warningParts.length ? warningParts.join(". ") : null,
  };
});

const recordFields = (module: "Calls" | "Leads") => cached(`zoho:${module.toLowerCase()}-fields`, LONG, async () => {
  const response = await zoho<{ fields?: QuoteFieldMetadata[] }>("GET", "/settings/fields", {
    query: { module },
  });
  return response?.fields ?? [];
});

function picklistValue(field: QuoteFieldMetadata, outcome?: LogCallInput["outcome"]): string | undefined {
  const values = field.pick_list_values?.map((item) => item.actual_value ?? item.display_value ?? "").filter(Boolean) ?? [];
  if (!values.length) return undefined;
  if (outcome && /(?:call|outgoing_call)_?status/i.test(field.api_name ?? "")) {
    const preferred = outcome === "Connected"
      ? /completed|answered|connected|success/i
      : /not connected|no answer|busy|not reached|failed/i;
    const match = values.find((value) => preferred.test(value));
    if (match) return match;
  }
  return values[0];
}

function completeRecordFromMetadata(
  input: Record<string, unknown>,
  fields: QuoteFieldMetadata[],
  outcome?: LogCallInput["outcome"],
  module?: "Calls" | "Leads",
): Record<string, unknown> {
  const record = { ...input };
  const dependentNames = new Set(fields.flatMap((field) => (field.dependent_fields ?? []).map((item) =>
    typeof item === "string" ? item : item.api_name ?? "",
  )));
  for (const field of fields) {
    const name = field.api_name;
    if (!name) continue;
    const isRequired = field.required || field.system_mandatory || field.is_mandatory;
    const isCallStatus = /^(?:Call_Status|Outgoing_Call_Status)$/i.test(name);
    const isDependent = field.is_dependent === true || dependentNames.has(name) ||
      Boolean(field.depends_on || field.dependent_on) ||
      (module === "Calls" && /^Call_Purpose$/i.test(name));
    const values = field.pick_list_values?.map((item) => item.actual_value ?? item.display_value ?? "").filter(Boolean) ?? [];
    const currentValue = record[name];
    if (typeof currentValue === "string" && values.length) {
      const configured = values.find((value) => value.toLowerCase() === currentValue.toLowerCase());
      const value = configured ?? picklistValue(field, outcome);
      if (value !== undefined) record[name] = value;
    } else if ((isRequired || isDependent || isCallStatus) && (currentValue === undefined || currentValue === "")) {
      const value = picklistValue(field, outcome);
      if (value !== undefined) record[name] = value;
    }
  }
  return record;
}

function zohoErrorFieldNames(error: ZohoError): string[] {
  const details = error.details ?? {};
  const names = [details.api_name, error.field];
  if (typeof details.json_path === "string") {
    names.push(/\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(details.json_path)?.[1]);
  }
  if (typeof details.dependee === "string") names.push(details.dependee);
  return [...new Set(names.filter((name): name is string => typeof name === "string" && !!name))];
}

function logMissingZohoField(error: unknown, module: "Calls" | "Leads", payload: Record<string, unknown>) {
  if (!(error instanceof ZohoError) || !["DEPENDENT_FIELD_MISSING", "REQUIRED_FIELD_MISSING"].includes(error.code ?? "")) return;
  const details = error.details ?? {};
  console.error("[zoho] required/dependent field missing", {
    operation: error.operation,
    module,
    code: error.code,
    payloadKeys: Object.keys(payload),
    api_name: details.api_name,
    json_path: details.json_path,
    dependee: details.dependee,
    reference: error.reference,
  });
}

function logCallRecordFailure(error: unknown, operation: string, module: "Calls" | "Leads", payload: Record<string, unknown>) {
  const zohoError = error instanceof ZohoError ? error : undefined;
  console.error("[zoho] call outcome write failed", {
    operation,
    module,
    status: zohoError?.status,
    code: zohoError?.code,
    payloadKeys: Object.keys(payload),
    api_name: zohoError?.details?.api_name,
    json_path: zohoError?.details?.json_path,
    dependee: zohoError?.details?.dependee,
    reference: zohoError?.reference,
  });
}

async function writeWithMetadataFallback(
  method: "POST" | "PUT",
  path: string,
  module: "Calls" | "Leads",
  input: Record<string, unknown>,
  fields: QuoteFieldMetadata[],
  outcome?: LogCallInput["outcome"],
  opts: { trigger?: string[] } = {},
): Promise<string> {
  let record = completeRecordFromMetadata(input, fields, outcome, module);
  try {
    return await zohoWrite(method, path, record, opts);
  } catch (error) {
    logMissingZohoField(error, module, record);
    if (!(error instanceof ZohoError) || !["DEPENDENT_FIELD_MISSING", "REQUIRED_FIELD_MISSING"].includes(error.code ?? "")) {
      throw error;
    }
    let changed = false;
    for (const name of zohoErrorFieldNames(error)) {
      const field = fields.find((candidate) => candidate.api_name === name);
      const value = field && picklistValue(field, outcome);
      if (value !== undefined && record[name] !== value) {
        record = { ...record, [name]: value };
        changed = true;
      }
    }
    if (!changed) throw error;
    try {
      return await zohoWrite(method, path, record, opts);
    } catch (retryError) {
      logMissingZohoField(retryError, module, record);
      throw retryError;
    }
  }
}

async function taskRows(): Promise<ZTask[]> {
  let fields: string[];
  try {
    const schema = await taskSchema();
    fields = schema.fields;
    taskMetadataWarning = schema.warning;
    if (schema.warning) console.warn("[zoho] Tasks module schema warning", { warning: schema.warning });
  } catch (error) {
    taskMetadataWarning = "Unable to verify Tasks fields in Zoho; task status and visit details may be incomplete.";
    console.error("[zoho] Tasks field metadata unavailable", {
      status: error instanceof ZohoError ? error.status : undefined,
      code: error instanceof ZohoError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    if (isZohoAuthenticationError(error)) throw error;
    fields = STANDARD_TASK_FIELDS;
  }
  if (!fields.includes("Status")) {
    taskMetadataWarning = [taskMetadataWarning, "The Zoho Tasks module has no Status field; task tabs may not reflect workflow state."]
      .filter(Boolean).join(" ");
  }
  if (!fields.length) {
    taskMetadataWarning = [taskMetadataWarning, "No Tasks fields were returned by Zoho; attempting the standard Tasks fields."]
      .filter(Boolean).join(" ");
    fields = STANDARD_TASK_FIELDS;
  }
  return zohoList<ZTask>("Tasks", fields, 1000);
}

function isZohoAuthenticationError(error: unknown): boolean {
  if (!(error instanceof ZohoError)) return false;
  const reason = `${error.code ?? ""} ${error.message}`.toLowerCase();
  return error.status === 401 || error.status === 403
    || /invalid[_ ]token|authentication_failure|token_refresh|invalid_client|access denied|unauthorized|scope_mismatch|permission/.test(reason);
}

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
  if (!mappedUsers.length) await invalidate("users");
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
const userById = async (id: string) => {
  const u = (await listAssignableUsers()).find((x) => String(x.id) === String(id));
  if (!u) throw new ZohoError("The selected owner is not an active assignable Zoho user.", 400, "INVALID_OWNER", "Owner", id);
  return u;
};

export async function advanceLead(leadId: string, currentStatus: Lead["status"], target: "Site Visit Scheduled" | "Quotation Sent"): Promise<boolean> {
  if (!canAdvanceLeadStatus(currentStatus, target)) return false;
  await zohoWrite("PUT", `/Leads/${leadId}`, { Lead_Status: WRITE_LEAD_STATUS[target] }, { trigger: ["workflow"] });
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
  return cached("leads", SHORT(), async () => {
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
    const mappedLeads = raw.map((z) => {
      const lead = mapLead(z, assignable, salesExecutives);
      const followUp = followUps.get(lead.id);
      return followUp ? { ...lead, followUp: followUp.date, followUpTime: followUp.time } : lead;
    }).sort((a, b) => b.createdOn.localeCompare(a.createdOn));
    await setCachedValue("leads:aggregate", SHORT(), Object.fromEntries(allUsers.map((user) => [
      user.id,
      summarizeLeads(user, mappedLeads),
    ])));
    return mappedLeads;
  }, { keepStale: true });
});
const leadMap = async () => new Map((await leads()).map((l) => [l.id, l]));

async function findRecentLeadByPhoneCreatedBy(phone: string, actorId: string): Promise<Lead | null> {
  const normalizedPhone = normalizePhone(phone);
  const response = await zoho<{ data?: ZLead[] }>("GET", "/Leads/search", {
    query: { fields: LEAD_DETAIL_FIELDS.join(","), phone: normalizedPhone, per_page: 200 },
  });
  const cutoff = Date.now() - 2 * 60_000;
  const recent = (response?.data ?? []).find((record) =>
    leadPhoneMatch(record, normalizedPhone) !== null &&
    String(record.Created_By?.id ?? "") === String(actorId) &&
    Date.parse(record.Created_Time ?? "") >= cutoff,
  );
  if (!recent) return null;
  return mapLead(recent, await assignableIds());
}

async function addNote(leadId: string, title: string, content: string) {
  const parentId = leadId.trim();
  if (!parentId) throw new ZohoError("Cannot create a note without a Zoho Lead ID.", 400, "INVALID_LEAD_REFERENCE", "Parent_Id");
  await zohoWrite("POST", "/Notes", {
    Note_Title: title, Note_Content: content, ...noteLeadReference(parentId),
  });
}

async function loadVisits(): Promise<Visit[]> {
  const [raw, map, schema] = await Promise.all([taskRows(), leadMap(), getSiteVisitsSchema()]);
  const tasks = raw.map((task) => mapTask(task, map));
  if (!schema) return tasks;
  try {
    const siteVisits = await listSiteVisits(schema, map);
    const keys = new Set(siteVisits.map((visit) => `${visit.leadId}:${visit.date}`));
    return [...siteVisits, ...tasks.filter((task) => task.isVisit && !keys.has(`${task.leadId}:${task.date}`))];
  } catch (error) {
    console.error("[zoho] Site Visits records unavailable; showing Tasks only", {
      status: error instanceof ZohoError ? error.status : undefined,
      code: error instanceof ZohoError ? error.code : undefined,
      field: error instanceof ZohoError ? error.field : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    return tasks;
  }
}

async function addHistoryNoteBestEffort(leadId: string, title: string, content: string, context: Record<string, unknown>) {
  try {
    await addNote(leadId, title, content);
    return undefined;
  } catch (error) {
    console.error("[zoho] primary change succeeded but history note failed", {
      ...context,
      leadId,
      operation: "POST /Notes",
      status: error instanceof ZohoError ? error.status : undefined,
      code: error instanceof ZohoError ? error.code : undefined,
      field: error instanceof ZohoError ? error.field : undefined,
      details: error instanceof ZohoError ? error.details : undefined,
      api_name: error instanceof ZohoError ? error.details?.api_name : undefined,
      json_path: error instanceof ZohoError ? error.details?.json_path : undefined,
      reference: error instanceof ZohoError ? error.reference : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    return "The change was saved, but its history note could not be added.";
  }
}

function scheduleSideEffects(
  operation: string,
  effects: [name: string, task: () => Promise<unknown>][],
  onComplete?: () => Promise<void>,
) {
  const retryEffect = async (name: string, task: () => Promise<unknown>) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await task();
        return;
      } catch (error) {
        console.error(`[zoho] deferred ${operation} side effect ${attempt === 0 ? "retrying" : "failed"}`, {
          sideEffect: name,
          attempt: attempt + 1,
          message: error instanceof Error ? error.message : String(error),
          status: error instanceof ZohoError ? error.status : undefined,
          code: error instanceof ZohoError ? error.code : undefined,
          field: error instanceof ZohoError ? error.field : undefined,
          details: error instanceof ZohoError ? error.details : undefined,
        });
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
  };
  const run = async () => {
    await Promise.all(effects.map(([name, task]) => retryEffect(name, task)));
    if (onComplete) await retryEffect("cache update", onComplete);
  };
  try {
    after(run);
  } catch (error) {
    console.error(`[zoho] could not schedule ${operation} side effects; running them asynchronously`, {
      message: error instanceof Error ? error.message : String(error),
    });
    void run();
  }
}

async function quotePage(page: number) {
  const schema = await quoteSchema();
  return cached(`quotes:page:${page}`, SHORT(), async () => {
    const response = await zoho<{ data?: ZQuote[]; info?: { more_records?: boolean; count?: number } }>("GET", "/Quotes", {
      query: {
        fields: QUOTE_FIELDS.join(","),
        per_page: 200,
        page,
        sort_by: "Created_Time",
        sort_order: "desc",
      },
    });
    const quotes = (response?.data ?? []).map((record) => mapQuote(record, new Map(), undefined, schema.fieldNames));
    return { quotes, hasMore: response?.info?.more_records === true, count: response?.info?.count };
  }, { keepStale: true });
}

async function zohoSearchList<T>(module: "Leads" | "Quotes", fields: string[], criteria: string, maxRecords: number): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;
  let moreRecords = true;
  const path = `/${module}/search`;
  try {
    while (moreRecords && rows.length < maxRecords) {
      const response = await zoho<{ data?: T[]; info?: { more_records?: boolean } }>(
        "GET", path, {
          query: { fields: fields.join(","), criteria, per_page: 200, page },
        },
      );
      const batch = response?.data ?? [];
      rows.push(...batch);
      moreRecords = response?.info?.more_records === true && batch.length > 0;
      page += 1;
    }
  } catch (error) {
    if (error instanceof ZohoError && String(error.code ?? "").toUpperCase() === "INVALID_QUERY") {
      console.error("[zoho] CRM search query rejected", {
        module,
        path,
        operation: error.operation ?? `GET ${path}`,
        status: error.status,
        code: error.code,
        field: error.field,
        message: error.message,
      });
    }
    throw error;
  }
  return rows.slice(0, maxRecords);
}

function quoteLeadId(record: ZQuote) {
  const raw = record[FIELD.quote.lead];
  if (raw && typeof raw === "object" && "id" in raw) return String(raw.id ?? "").trim();
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return parseQuoteCustomerSnapshot(record).leadId?.trim() ?? "";
}

async function invoiceCandidates(): Promise<{ quotes: Quotation[]; leads: Lead[] }> {
  const maxRecords = env().ZOHO_MAX_LEADS;
  const schema = await quoteSchema();
  const hasLeadReference = schema.fieldNames.has(FIELD.quote.lead);
  const snapshotField = customerSnapshotField(schema.fields)?.api_name
    ?? (schema.fieldNames.has("Description") ? "Description" : undefined);
  const quoteFields = [...new Set([
    ...QUOTE_FIELDS.filter((field) => schema.fieldNames.has(field)),
    ...(snapshotField ? [snapshotField] : []),
  ])];
  if (!hasLeadReference) {
    console.warn("[zoho] Quotes module is missing the lead reference field; Won-quote candidates will use saved snapshot lead IDs.", {
      module: "Quotes",
      field: FIELD.quote.lead,
    });
  }
  const wonRecords = await cached("leads:invoice-won", SHORT(), () =>
    zohoSearchList<ZLead>("Leads", LEAD_FIELDS, `(Lead_Status:equals:Won)`, maxRecords),
    { keepStale: true },
  );
  const wonLeads = wonRecords
    .filter((record) => String(record.Lead_Status ?? "").trim().toLowerCase() === "won")
    .map((record) => mapLead(record, new Set()));
  const wonLeadIds = wonLeads.map((lead) => lead.id).filter(Boolean);
  const quoteCriteria = [
    `(${FIELD.quote.stage}:equals:Accepted)`,
    `(${FIELD.quote.stage}:equals:Won)`,
    ...(hasLeadReference && wonLeadIds.length ? [`(${FIELD.quote.lead}.id:in:${wonLeadIds.join(",")})`] : []),
  ];
  let quoteRecords = await zohoSearchList<ZQuote>(
    "Quotes",
    quoteFields,
    `(${quoteCriteria.join("or")})`,
    maxRecords,
  );
  if (!hasLeadReference && wonLeadIds.length) {
    const wonLeadIdsSet = new Set(wonLeadIds);
    const snapshotQuotes = await cached("quotes:invoice-won:snapshot", SHORT(), () =>
      zohoList<ZQuote>("Quotes", quoteFields, maxRecords),
      { keepStale: true },
    );
    const quoteRecordsById = new Map(quoteRecords.map((record) => [String(record.id ?? ""), record]));
    for (const record of snapshotQuotes) {
      if (wonLeadIdsSet.has(quoteLeadId(record))) {
        quoteRecordsById.set(String(record.id ?? ""), record);
      }
    }
    quoteRecords = [...quoteRecordsById.values()];
  }
  const neededLeadIds = [...new Set(quoteRecords.map(quoteLeadId).filter(Boolean))];
  const leadsById = new Map(wonLeads.map((lead) => [lead.id, lead]));
  const additionalLeadIds = neededLeadIds.filter((leadId) => !leadsById.has(leadId));
  const additionalLeadRecords = await Promise.all(additionalLeadIds.map(async (leadId) => {
    try {
      const response = await zoho<{ data?: ZLead[] }>("GET", `/Leads/${encodeURIComponent(leadId)}`, {
        query: { fields: LEAD_DETAIL_FIELDS.join(",") },
      });
      return response?.data?.[0];
    } catch (error) {
      if (error instanceof ZohoError && error.status === 404) return undefined;
      throw error;
    }
  }));
  for (const record of additionalLeadRecords) {
    if (record?.id) leadsById.set(String(record.id), mapLead(record, new Set()));
  }

  const eligibleRecords = quoteRecords.filter((record) => {
    const status = String(record[FIELD.quote.stage] ?? "").trim().toLowerCase();
    const lead = leadsById.get(quoteLeadId(record));
    return status === "accepted" || status === "won" || lead?.status === "Won";
  });
  const needed = new Set(eligibleRecords.map(quoteLeadId).filter(Boolean));
  return {
    quotes: eligibleRecords.map((record) => mapQuote(record, leadsById))
      .sort((left, right) => right.date.localeCompare(left.date)),
    leads: [...leadsById.values()].filter((lead) => needed.has(lead.id)),
  };
}

let quoteWriteLock: Promise<void> = Promise.resolve();
async function withQuoteWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = quoteWriteLock;
  let release!: () => void;
  quoteWriteLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function customerSnapshotField(fields: QuoteFieldMetadata[]): QuoteFieldMetadata | undefined {
  const candidates = fields.filter((field) => {
    const name = field.api_name?.toLowerCase() ?? "";
    const label = field.field_label?.toLowerCase() ?? "";
    const textField = /^(text|string|singleline|single_line|textarea|multiline)$/i.test(field.data_type ?? "");
    return textField && !field.read_only &&
      (/^customer_(snapshot|details|info|profile)$/.test(name) ||
        /customer\s+(snapshot|details|information|profile)/.test(label));
  });
  return candidates[0];
}

function quoteRecordSnapshot(lead: Lead, gstBreakdown?: QuoteGstBreakdown, revision = 0): QuoteCustomerSnapshot {
  return {
    leadId: lead.id,
    revision,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    company: lead.company,
    area: lead.area,
    address: lead.address,
    gstBreakdown,
  };
}

async function allQuoteRecords(): Promise<{ schema: Awaited<ReturnType<typeof quoteSchema>>; records: ZQuote[] }> {
  const schema = await quoteSchema();
  const snapshotField = customerSnapshotField(schema.fields)?.api_name;
  const fields = ["Subject", "Created_Time", FIELD.quote.offerNo, ...(snapshotField ? [snapshotField] : [])]
    .filter((name, index, list) => list.indexOf(name) === index)
    .filter((name) => name === "Subject" || name === "Created_Time" || schema.fieldNames.has(name));
  const records = await zohoList<ZQuote>("Quotes", fields, 100_000);
  return { schema, records };
}

async function allOfferNumbers(): Promise<string[]> {
  const { records } = await allQuoteRecords();
  return records.map((record) => mapQuote(record, new Map()).offerNo).filter(Boolean);
}

async function repairDuplicateOfferNumbersUnlocked() {
  const { schema, records } = await allQuoteRecords();
  const grouped = new Map<string, ZQuote[]>();
  for (const record of records) {
    const offerNo = mapQuote(record, new Map()).offerNo;
    if (!offerNo) continue;
    grouped.set(offerNo, [...(grouped.get(offerNo) ?? []), record]);
  }
  const duplicates = [...grouped.values()].filter((group) => group.length > 1);
  if (!duplicates.length) return;
  const offerField = schema.fieldsByName.get(FIELD.quote.offerNo);
  if (offerField?.read_only) {
    throw new ZohoError("Duplicate quotation references exist, but the Zoho Offer_No field is read-only.", 400, "DUPLICATE_OFFER_NO_READ_ONLY", FIELD.quote.offerNo);
  }
  const used = [...grouped.keys()];
  for (const group of duplicates) {
    const oldestFirst = [...group].sort((a, b) => String(a.Created_Time ?? "").localeCompare(String(b.Created_Time ?? "")));
    for (const duplicate of oldestFirst.slice(1)) {
      let replacement = nextOfferNo(used, todayIST());
      while (used.includes(replacement)) replacement = nextOfferNo([...used, replacement], todayIST());
      used.push(replacement);
      const oldSubject = String(duplicate.Subject ?? "");
      const title = /^Offer\s+.+?\s+-\s+(.+)$/.exec(oldSubject)?.[1] ?? oldSubject.replace(/^Offer\s+/i, "");
      const payload: Record<string, unknown> = { Subject: `Offer ${replacement}${title ? ` - ${title}` : ""}` };
      if (schema.fieldNames.has(FIELD.quote.offerNo)) payload[FIELD.quote.offerNo] = replacement;
      await zohoWrite("PUT", `/Quotes/${encodeURIComponent(String(duplicate.id))}`, payload);
      console.warn("[zoho] repaired duplicate quotation reference", {
        quoteId: duplicate.id,
        previousOfferNo: mapQuote(duplicate, new Map()).offerNo,
        replacementOfferNo: replacement,
      });
    }
  }
}

export async function suggestedZohoOfferNo(): Promise<string> {
  const offerNumbers = await cached("quotes:offer-numbers", LONG, allOfferNumbers, { keepStale: true });
  return nextOfferNo(offerNumbers, todayIST());
}

function isProductFieldSetError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown; code?: unknown; field?: unknown; message?: unknown; details?: Record<string, unknown>;
  };
  if (candidate.status !== 400 || !["INVALID_DATA", "INVALID_MODULE"].includes(String(candidate.code ?? "").toUpperCase())) {
    return false;
  }
  const hasFieldDetail = Boolean(
    candidate.field
    || candidate.details?.api_name
    || candidate.details?.field
    || candidate.details?.param_name,
  );
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return hasFieldDetail || /\bfields?\b|api_name/i.test(message);
}

function escapeZohoCriteriaValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/[(),]/g, "\\$&");
}

type ZohoAccount = { id?: string | number; Account_Name?: string; Phone?: string };

export async function ensureAccountForLead(lead: Lead): Promise<string> {
  return withIdempotency(`ensure-account-for-lead:${lead.id}`, async () => {
    const linkedAccountId = lead.accountId?.trim();
    if (linkedAccountId) return linkedAccountId;

    const accountName = lead.company.trim() || lead.name.trim();
    if (!accountName || accountName.toLowerCase() === "(no name)") {
      throw new ZohoError(
        "Add a company or customer name to this lead before converting its quotation to an invoice.",
        400, "INVOICE_ACCOUNT_REQUIRED", "Account_Name",
      );
    }

    const searchAccounts = async (criteria: string) => {
      const response = await zoho<{ data?: ZohoAccount[] }>("GET", "/Accounts/search", {
        query: { criteria, fields: "Account_Name,Phone", per_page: 200 },
      });
      return response?.data ?? [];
    };

    const byName = await searchAccounts(`(Account_Name:equals:${escapeZohoCriteriaValue(accountName)})`);
    let accountId = byName.find((account) =>
      String(account.Account_Name ?? "").trim().toLowerCase() === accountName.toLowerCase()
      && String(account.id ?? "").trim(),
    )?.id;

    const normalizedPhone = normalizePhone(lead.phone);
    if (!accountId && normalizedPhone) {
      const phoneVariants = [...new Set([
        lead.phone.trim(),
        normalizedPhone,
        `+91${normalizedPhone}`,
        `91${normalizedPhone}`,
        `0${normalizedPhone}`,
      ].filter(Boolean))];
      const phoneCriteria = `(${phoneVariants
        .map((phone) => `(Phone:equals:${escapeZohoCriteriaValue(phone)})`)
        .join("or")})`;
      const byPhone = await searchAccounts(phoneCriteria);
      accountId = byPhone.find((account) =>
        normalizePhone(String(account.Phone ?? "")) === normalizedPhone
        && String(account.id ?? "").trim(),
      )?.id;
    }

    if (!accountId) {
      accountId = await zohoWrite("POST", "/Accounts", {
        Account_Name: accountName,
        ...(lead.phone.trim() ? { Phone: lead.phone.trim() } : {}),
        ...(lead.email?.trim() ? { Email: lead.email.trim() } : {}),
      });
    }

    const resolvedAccountId = String(accountId ?? "").trim();
    if (!resolvedAccountId) {
      throw new ZohoError("Zoho did not return the Account ID.", undefined, "ACCOUNT_ID_MISSING");
    }

    await zohoWrite("PUT", `/Leads/${encodeURIComponent(lead.id)}`, {
      [FIELD.lead.accountId]: resolvedAccountId,
    });
    await markStale("leads");
    return resolvedAccountId;
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
  async listLeadsPage(page, pageSize = 50, ownerId) {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
    const ownerFilter = ownerId?.trim() ?? "";
    return cached(`leads:page:${ownerFilter || "all"}:${safePage}:${safePageSize}`, SHORT(), async () => {
      const ownerCriteria = ownerFilter ? `(Owner.id:equals:${ownerFilter})` : undefined;
      const response = await zoho<{ data?: ZLead[]; info?: { count?: number; more_records?: boolean } }>(
        "GET", ownerCriteria ? "/Leads/search" : "/Leads", {
        query: {
          fields: LEAD_FIELDS.join(","),
          page: safePage,
          per_page: safePageSize,
          ...(ownerCriteria
            ? { criteria: ownerCriteria }
            : { sort_by: "Created_Time", sort_order: "desc" }),
        },
      });
      const [assignable, allUsers] = await Promise.all([assignableIds(), users()]);
      const salesExecutives = new Set(allUsers
        .filter((user) => user.role === "Sales Executive")
        .map((user) => String(user.id).trim()));
      const records = [...(response?.data ?? [])].sort((a, b) =>
        String(b.Created_Time ?? "").localeCompare(String(a.Created_Time ?? "")),
      );
      const mapped = records.map((record) => mapLead(record, assignable, salesExecutives));
      const total = response?.info?.count ?? ((safePage - 1) * safePageSize + mapped.length);
      return { leads: mapped, total, hasMore: response?.info?.more_records === true };
    }, { keepStale: true });
  },
  async listLeadSources(): Promise<LeadSource[]> {
    const values = (await leadSchema()).sourceValues;
    return LEAD_SOURCES.filter((source) => zohoLeadSource(source, values, false) !== null);
  },
  async searchLeads(query, page = 1) {
    const normalized = query.trim().replace(/\s+/g, " ");
    if (normalized.length < 2) return { leads: [], hasMore: false };
    const criteria = leadSearchCriteria(normalized);
    const response = await zoho<{ data?: ZLead[]; info?: { more_records?: boolean } }>("GET", "/Leads/search", {
      query: { fields: LEAD_FIELDS.join(","), criteria, per_page: 50, page: Math.max(1, Math.floor(page)) },
    });
    const [assignable, allUsers] = await Promise.all([assignableIds(), users()]);
    const salesExecutives = new Set(allUsers.filter((user) => user.role === "Sales Executive").map((user) => String(user.id).trim()));
    return {
      leads: (response?.data ?? []).map((record) => mapLead(record, assignable, salesExecutives))
        .sort((a, b) => b.createdOn.localeCompare(a.createdOn)),
      hasMore: response?.info?.more_records === true,
    };
  },
  async getLead(id) {
    try {
      const response = await zoho<{ data?: ZLead[] }>("GET", `/Leads/${encodeURIComponent(id)}`, {
        query: { fields: LEAD_DETAIL_FIELDS.join(",") },
      });
      const record = response?.data?.[0];
      if (!record) throw new ZohoError("Lead not found", 404, "NOT_FOUND", undefined, undefined, `GET /Leads/${id}`);
      const [assignable, allUsers, relatedTasks] = await Promise.all([
        assignableIds(),
        users(),
        zoho<{ data?: ZTask[] }>("GET", `/Leads/${encodeURIComponent(id)}/Tasks`, {
          query: { fields: TASK_FIELDS.join(","), page: 1, per_page: 200, sort_by: "Created_Time", sort_order: "desc" },
        }).catch((error: unknown) => {
          console.error("[zoho] related Tasks unavailable while loading lead details", {
            leadId: id,
            status: error instanceof ZohoError ? error.status : undefined,
            code: error instanceof ZohoError ? error.code : undefined,
            message: error instanceof Error ? error.message : String(error),
          });
          return null;
        }),
      ]);
      const salesExecutives = new Set(allUsers.filter((user) => user.role === "Sales Executive").map((user) => String(user.id).trim()));
      const lead = mapLead(record, assignable, salesExecutives);
      const followUpTask = (relatedTasks?.data ?? [])
        .map((task) => ({ date: String(task[FIELD.task.followUp] ?? ""), time: String(task[FIELD.task.visitTime] ?? "") }))
        .filter((task) => task.date)
        .sort((left, right) => right.date.localeCompare(left.date))[0];
      return followUpTask ? { ...lead, followUp: followUpTask.date, followUpTime: followUpTask.time } : lead;
    } catch (error) {
      if (error instanceof ZohoError && error.status === 404) return null;
      throw error;
    }
  },
  async findLeadByPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;
    let result: { data?: ZLead[] } | null = null;
    try {
      result = await zoho<{ data?: ZLead[] }>("GET", "/Leads/search", {
        query: { fields: LEAD_FIELDS.join(","), criteria: leadPhoneSearchCriteria(normalized), per_page: 200 },
      });
    } catch (error) {
      if (!(error instanceof ZohoError) || error.status !== 400) throw error;
    }
    for (const record of result?.data ?? []) {
      const matchedField = leadPhoneMatch(record, normalized);
      if (!matchedField) continue;
      const assignable = await assignableIds();
      return { lead: mapLead(record, assignable), matchedField };
    }
    const search = await zoho<{ data?: ZLead[] }>("GET", "/Leads/search", {
      query: { fields: LEAD_FIELDS.join(","), phone: normalized, per_page: 200 },
    });
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
    const phoneKey = input.phone.replace(/\D/g, "").slice(-10);
    const previous = leadCreateLocks.get(phoneKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    leadCreateLocks.set(phoneKey, chain);
    await previous;
    try {
    const executiveCreatesLead = actor.role === "Sales Executive";
    const [existing, metadata, owner] = await Promise.all([
      forceCreate ? Promise.resolve(null) : (async () => {
        const cachedLeads = await getCachedValue<Lead[]>("leads");
        const normalizedPhone = normalizePhone(input.phone);
        const localMatch = cachedLeads?.find((lead) => normalizePhone(lead.phone) === normalizedPhone);
        if (localMatch) return { lead: localMatch, matchedField: "Mobile" as const };
        return this.findLeadByPhone(input.phone);
      })(),
      leadSchema(),
      executiveCreatesLead ? userById(actor.id) : assignTo ? userById(assignTo) : Promise.resolve(null),
    ]);
    if (existing) throw new ZohoError("Duplicate lead", 409, "DUPLICATE_LEAD");
    const status = owner ? ASSIGNED_STAGE : "Fresh Lead";
    const requiredFields = ["Last_Name", "Company", "Mobile", "Lead_Source", "Lead_Status"];
    const missingFields = requiredFields.filter((field) => !metadata.fieldNames.has(field));
    if (missingFields.length) {
      console.error("[zoho] required Leads fields missing from module metadata", {
        operation: "GET /settings/fields?module=Leads",
        missingFields,
      });
      throw new ZohoError(
        `Required field missing: ${missingFields.join(", ")}`,
        400, "MANDATORY_NOT_FOUND", missingFields[0], undefined,
        "GET /settings/fields?module=Leads",
        { missingFields },
      );
    }
    const leadSource = sourceValueForZoho(input.source, metadata.sourceValues);
    const mobile = normalizePhone(input.phone);
    if (!/^\d{10}$/.test(mobile)) {
      throw new ZohoError("Mobile number must contain exactly 10 digits.", 400, "INVALID_DATA", "Mobile");
    }
    const record: Record<string, unknown> = {
      Last_Name: input.name.trim(),
      Company: input.company.trim() || input.name.trim(),
      Mobile: mobile,
      Lead_Source: leadSource,
      Lead_Status: WRITE_LEAD_STATUS[status],
      ...(input.remarks.trim() && metadata.remarksField ? { [metadata.remarksField]: input.remarks.trim() } : {}),
      ...(owner ? { Owner: { id: owner.id } } : {}),
    };
    if (input.remarks.trim() && !metadata.remarksField) {
      console.warn("[zoho] remarks omitted because Description is not available in Leads metadata", {
        requestedField: "Description",
      });
    }
    if (input.area.trim()) {
      if (metadata.areaField) record[metadata.areaField] = input.area.trim();
      else console.warn("[zoho] Area omitted because Leads has no City or Area field", { requestedField: "City/Area" });
    }
    let id: string;
    try {
      id = await zohoWrite("POST", "/Leads", record, { trigger: ["workflow"] });
    } catch (error) {
      const recent = await findRecentLeadByPhoneCreatedBy(input.phone, actor.id).catch((lookupError: unknown) => {
        console.error("[zoho] recent lead retry lookup failed", {
          phoneSuffix: normalizePhone(input.phone).slice(-4),
          actorId: actor.id,
          message: lookupError instanceof Error ? lookupError.message : String(lookupError),
        });
        return null;
      });
      if (recent) return recent;
      throw error;
    }
    const secondaryWrites: [string, () => Promise<unknown>][] = [
      ["history note", () => addNote(id, "Lead created", `Lead created from ${input.source} by ${actor.name}`)],
    ];
    if (owner) {
      secondaryWrites.push(
        ["assignment history", () => addNote(id, "Lead assigned", `Assigned to ${owner.name} by ${actor.name} on ${new Date().toISOString()}`)],
        ["initial follow-up task", () => zohoWrite("POST", "/Tasks", {
          Subject: "Call new lead",
          Status: TASK_STATUS_WRITE.Assigned,
          Due_Date: todayIST(),
          Owner: { id: owner.id },
          ...relatedToLead(id),
        })],
      );
    }
    const createdLead: Lead = {
      id, name: input.name.trim(), company: input.company.trim() || input.name.trim(), phone: mobile,
      area: input.area.trim(), source: input.source, status: owner ? ASSIGNED_STAGE : "Fresh Lead",
      assignedTo: owner?.name ?? null, assignedToId: owner?.id, ownerId: owner?.id,
      remarks: input.remarks.trim(), createdOn: todayIST(), createdAt: new Date().toISOString(), address: "", touchedBy: [actor.name],
    };
    scheduleSideEffects("lead creation", secondaryWrites, () => markStale("leads", "users", "visits"));
    return createdLead;
    } finally {
      release();
      if (leadCreateLocks.get(phoneKey) === chain) leadCreateLocks.delete(phoneKey);
    }
  },

  async assignLead(id, assigneeId, actor) {
    if (actor.role !== "Manager" && actor.role !== "Calling Team") throw new ZohoError("Only managers and the calling team can assign leads.");
    const [current, owner] = await Promise.all([this.getLead(id), userById(assigneeId)]);
    if (!current) throw new ZohoError("Lead not found", 404);
    const nextStatus = current.status === "Fresh Lead" ? ASSIGNED_STAGE : current.status;
    const record = {
      Owner: { id: owner.id },
      ...(nextStatus !== current.status ? { Lead_Status: WRITE_LEAD_STATUS[nextStatus] } : {}),
    };
    if (current.ownerId !== owner.id || record.Lead_Status) {
      try {
        await zohoWrite("PUT", `/Leads/${id}`, record, { trigger: ["workflow"] });
      } catch (error) {
        if (error instanceof ZohoError) {
          throw new ZohoError(
            `Lead assignment failed while updating owner/status: ${error.message}`,
            error.status, error.code, error.field, error.invalidValue, error.operation, error.details,
          );
        }
        throw new ZohoError(`Lead assignment failed while updating owner/status: ${error instanceof Error ? error.message : "Zoho rejected the update"}`);
      }
    }

    const createAssignmentTask = async () => {
      try {
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
        if (hasAssignmentTask) return undefined;
        const taskId = await zohoWrite("POST", "/Tasks", {
          Subject: "Call new lead",
          Status: TASK_STATUS_WRITE.Assigned,
          Due_Date: todayIST(),
          Owner: { id: owner.id },
          ...relatedToLead(id),
        });
        return {
          id: taskId,
          leadId: id,
          customer: current.company || current.name,
          phone: current.phone,
          address: current.address,
          area: current.area,
          executive: owner.name,
          executiveId: String(owner.id),
          type: "Call new lead",
          isVisit: false,
          date: todayIST(),
          time: "",
          status: "Assigned" as const,
          nextAction: "",
          followUp: "",
          notes: "",
          done: false,
        };
      } catch (error) {
        console.error("[zoho] reassignment follow-up task failed", {
          leadId: id, ownerId: owner.id, operation: error instanceof ZohoError ? error.operation ?? "POST /Tasks" : "POST /Tasks",
          status: error instanceof ZohoError ? error.status : undefined,
          code: error instanceof ZohoError ? error.code : undefined,
          field: error instanceof ZohoError ? error.field : undefined,
          message: error instanceof Error ? error.message : String(error),
        });
        return "Follow-up task creation failed.";
      }
    };
    const writeAssignmentHistory = async () => {
      return addHistoryNoteBestEffort(
        id, "Lead assigned", `Assigned to ${owner.name} by ${actor.name} on ${new Date().toISOString()}`,
        { action: "reassign lead" },
      );
    };
    const warningCheckId = randomUUID();
    const completeAssignmentActivities = async () => {
      const [createdTask, historyWarning] = await Promise.all([createAssignmentTask(), writeAssignmentHistory()]);
      const taskWarning = typeof createdTask === "string" ? createdTask : undefined;
      if (createdTask && typeof createdTask !== "string") {
        try {
          const currentVisits = await loadVisits();
          await setCachedValue("visits", SHORT(), [
            createdTask,
            ...currentVisits.filter((visit) => visit.id !== createdTask.id),
          ]);
        } catch (error) {
          console.error("[zoho] could not update visits cache after reassignment", {
            leadId: id,
            taskId: createdTask.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await setCachedValue(`assignment-warnings:${warningCheckId}`, 60_000, {
        taskWarning,
        historyWarning: historyWarning || undefined,
      });
    };
    try {
      after(completeAssignmentActivities);
    } catch (error) {
      console.error("[zoho] could not schedule reassignment history activities; running without after()", {
        leadId: id,
        message: error instanceof Error ? error.message : String(error),
      });
      void completeAssignmentActivities();
    }

    return { owner: owner.name, ownerId: String(owner.id), status: nextStatus, taskCreated: false, warningCheckId };
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
        if (error instanceof ZohoError) {
          throw new ZohoError(
            `Fix assigned leads failed for ${lead.name}: ${error.message}`,
            error.status, error.code, error.field, error.invalidValue, error.operation, error.details,
          );
        }
        throw new ZohoError(`Fix assigned leads failed for ${lead.name}: ${error instanceof Error ? error.message : "Zoho rejected the update"}`);
      }
    }
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

  async updateLead(id, p, actor, knownLead) {
    const current = knownLead ?? await this.getLead(id);
    if (!current) throw new ZohoError("Lead not found", 404);
    const record: Record<string, unknown> = {};
    const parts: string[] = [];
    let updatedOwner: User | undefined;

    if (p.name?.trim() && p.name.trim() !== current.name) {
      record.Last_Name = p.name.trim();
      record.First_Name = null;
      parts.push("Name updated");
    }
    if (p.company !== undefined && p.company.trim() !== current.company) { record.Company = p.company.trim() || "-"; parts.push("Company updated"); }
    if (p.phone?.trim() && p.phone.trim() !== current.phone) { record.Mobile = p.phone.trim(); parts.push("Phone updated"); }
    if (p.source && p.source !== current.source) {
      record.Lead_Source = sourceValueForZoho(p.source, (await leadSchema()).sourceValues);
      parts.push(`Source: ${p.source}`);
    }

    if (p.status && p.status !== current.status) {
      record.Lead_Status = WRITE_LEAD_STATUS[p.status];
      parts.push(`Result: ${p.status}`);
    }
    if (p.lostReason !== undefined && p.lostReason !== current.lostReason) {
      record[FIELD.lead.lostReason] = p.lostReason || null;
      parts.push(p.lostReason ? `Lost reason: ${p.lostReason}` : "Lost reason cleared");
    }
    if (p.assignedTo !== undefined && p.assignedTo !== current.assignedTo) {
      if (p.assignedTo) {
        updatedOwner = await userByName(p.assignedTo);
        record.Owner = { id: updatedOwner.id };
        parts.push(`Assigned to ${p.assignedTo}`);
      } else {
        record.Owner = { id: await queueOwnerId() };
        parts.push("Unassigned");
      }
    }
    if (p.remarks !== undefined && p.remarks.trim() !== current.remarks) {
      record.Description = p.remarks.trim() || null;
      parts.push(p.remarks.trim() ? `"${p.remarks.trim()}"` : "Remarks cleared");
    }
    if (p.followUp && p.followUp !== current.followUp) parts.push(`Follow-up: ${p.followUp}`);
    if (!parts.length) return;

    if (Object.keys(record).length) await zohoWrite("PUT", `/Leads/${id}`, record, { trigger: ["workflow"] });
    const updatedLead: Lead = {
      ...current,
      ...(p.name !== undefined ? { name: p.name.trim() } : {}),
      ...(p.company !== undefined ? { company: p.company.trim() } : {}),
      ...(p.phone !== undefined ? { phone: p.phone.trim() } : {}),
      ...(p.source !== undefined ? { source: p.source } : {}),
      ...(p.status !== undefined ? { status: p.status } : {}),
      ...(p.lostReason !== undefined ? { lostReason: p.lostReason } : {}),
      ...(p.remarks !== undefined ? { remarks: p.remarks.trim() } : {}),
      ...(p.followUp !== undefined ? { followUp: p.followUp } : {}),
      ...(p.assignedTo !== undefined ? {
        assignedTo: updatedOwner?.name ?? p.assignedTo,
        assignedToId: updatedOwner?.id ?? (p.assignedTo ? current.assignedToId : undefined),
        ownerId: updatedOwner?.id ?? (p.assignedTo ? current.ownerId : undefined),
      } : {}),
    };
    const sideEffects: [string, () => Promise<unknown>][] = [
      ["history note", () => addHistoryNoteBestEffort(
        id, "Lead update", `${parts.join(" · ")} (by ${actor.name})`, { action: "update lead" },
      )],
    ];
    if (p.followUp && p.followUp !== current.followUp) {
      sideEffects.push(["follow-up task", async () => {
        const owner = current.assignedTo ? await userByName(current.assignedTo) : actor;
        return zohoWrite("POST", "/Tasks", {
          Subject: `Follow-up call - ${current.name}`, Status: TASK_STATUS_WRITE.Assigned,
          Due_Date: p.followUp, Owner: { id: owner.id }, ...relatedToLead(id),
          [FIELD.task.isSiteVisit]: false, [FIELD.task.nextAction]: "Follow up call",
          [FIELD.task.followUp]: p.followUp,
        });
      }]);
    }
    scheduleSideEffects("lead update", sideEffects, () => markStale("leads", "users", "visits"));
    return updatedLead;
  },

  async deleteLead(id) {
    const json = await zoho<{ data?: { code?: string; message?: string }[] }>("DELETE", "/Leads", { query: { ids: id } });
    const result = json?.data?.[0];
    if (!result || result.code !== "SUCCESS") {
      throw new ZohoError(result?.message ?? "Zoho could not delete the lead", undefined, result?.code);
    }
  },

  async getLeadHistory(id) {
    const json = await zoho<{ data?: ZNote[] }>("GET", `/Leads/${id}/Notes`, {
      query: { fields: NOTE_FIELDS.join(","), sort_by: "Created_Time", sort_order: "desc", per_page: 50 },
    });
    return (json?.data ?? []).map(mapNote);
  },

  async addLeadNote(id, title, content) {
    await addNote(id, title, content);
  },

  async getLeadTimeline(id): Promise<LeadTimelineItem[]> {
    const relatedQuery = (fields: string[]) => ({
      query: { fields: fields.join(","), page: 1, per_page: 200, sort_by: "Created_Time", sort_order: "desc" },
    });
    const [notes, calls, tasks, events, quotes, visits] = await Promise.all([
      zoho<{ data?: ZNote[] }>("GET", `/Leads/${id}/Notes`, relatedQuery(NOTE_FIELDS)),
      zoho<{ data?: ZCall[] }>("GET", `/Leads/${id}/Calls`, relatedQuery(CALL_FIELDS)),
      zoho<{ data?: ZTask[] }>("GET", `/Leads/${id}/Tasks`, relatedQuery(TASK_FIELDS)),
      zoho<{ data?: ZEvent[] }>("GET", `/Leads/${id}/Events`, relatedQuery(EVENT_FIELDS)),
      this.listQuotes(),
      this.listVisits(),
    ]);
    const leadVisits = visits.filter((visit) => visit.isVisit && visit.leadId === id);
    const visitIds = new Set(leadVisits.map((visit) => visit.id));
    const visitKeys = new Set(leadVisits.map((visit) => `${visit.leadId}:${visit.date}`));
    const timeline: LeadTimelineItem[] = [
      ...(notes?.data ?? []).map((n) => ({ date: n.Created_Time?.slice(0, 10) ?? "", user: n.Owner?.name ?? n.Created_By?.name ?? "", kind: "Note" as const, title: n.Note_Title ?? "Note", detail: n.Note_Content ?? "" })),
      ...(calls?.data ?? []).map((c) => ({ date: c.Call_Start_Time?.slice(0, 10) ?? "", user: c.Owner?.name ?? "", kind: "Call" as const, title: String(c[FIELD.call.result] ?? c.Subject ?? "Call"), detail: String(c.Subject ?? "") })),
      ...(tasks?.data ?? []).filter((task) => {
        const relatedLeadId = (task.What_Id ?? task.Who_Id)?.id ?? "";
        const isVisitTask = task[FIELD.task.isSiteVisit] === true;
        return !visitIds.has(String(task.id)) &&
          !(isVisitTask && visitKeys.has(`${relatedLeadId}:${task.Due_Date ?? ""}`));
      }).map((t) => ({ date: t.Due_Date ?? "", user: t.Owner?.name ?? "", kind: "Task" as const, title: String(t.Subject ?? "Task"), detail: t.Description ?? "" })),
      ...(events?.data ?? []).map((event) => ({ date: (event.Start_DateTime ?? event.Created_Time)?.slice(0, 10) ?? "", user: event.Owner?.name ?? "", kind: "Event" as const, title: event.Event_Title ?? "Event", detail: event.Description ?? "" })),
      ...quotes.filter((quote) => quote.leadId === id).map((quote) => ({
        date: quote.date, user: quote.executive, kind: "Quote" as const,
        title: `Quotation ${quote.offerNo}`, detail: `${quote.status ?? "Draft"} · Rs. ${quote.total.toFixed(2)}`,
      })),
      ...visits.filter((visit) => visit.leadId === id && visit.isVisit).map((visit) => ({
        date: visit.date, user: visit.executive, kind: "Visit" as const,
        title: `${visit.type} · ${visit.status}`,
        detail: [visit.address, visit.nextAction].filter(Boolean).join(" · "),
      })),
    ];
    return timeline.sort((a, b) => b.date.localeCompare(a.date));
  },

  async logCall(input, actor) {
    const requestedLeadId = input.leadId.trim();
    if (!/^\d+$/.test(requestedLeadId)) {
      throw new ZohoError("The selected lead ID is not a valid Zoho CRM record ID.", 400, "INVALID_LEAD_REFERENCE", "What_Id.id");
    }
    const lead = await this.getLead(requestedLeadId);
    if (!lead) throw new ZohoError("Lead not found", 404);
    const leadId = lead.id.trim();
    if (!/^\d+$/.test(leadId) || leadId !== requestedLeadId) {
      throw new ZohoError("The selected lead ID does not match a valid Zoho CRM record.", 400, "INVALID_LEAD_REFERENCE", "What_Id.id");
    }
    let liveUsers: User[] = [];
    try {
      liveUsers = await users();
    } catch (error) {
      console.error("[zoho] could not resolve call owner; creating call as API user", {
        operation: "GET /users",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const actorEmail = actor.email?.trim().toLowerCase();
    const actorName = actor.name.trim().toLowerCase().replace(/\s+/g, " ");
    const emailMatch = actorEmail
      ? liveUsers.find((user) => user.id.trim() && user.email?.trim().toLowerCase() === actorEmail)
      : undefined;
    const exactNameMatch = liveUsers.find((user) =>
      user.id.trim() && user.name.trim().toLowerCase().replace(/\s+/g, " ") === actorName,
    );
    const firstNameMatches = liveUsers.filter((user) =>
      user.id.trim() && user.name.trim().toLowerCase().replace(/\s+/g, " ").startsWith(`${actorName.split(" ")[0]} `),
    );
    const callOwner = emailMatch ?? exactNameMatch ?? (firstNameMatches.length === 1 ? firstNameMatches[0] : undefined);
    const [callFields, leadFields] = await Promise.all([
      recordFields("Calls").catch((error: unknown) => {
        console.error("[zoho] Calls field metadata unavailable", {
          module: "Calls",
          status: error instanceof ZohoError ? error.status : undefined,
          code: error instanceof ZohoError ? error.code : undefined,
        });
        return [];
      }),
      recordFields("Leads").catch((error: unknown) => {
        console.error("[zoho] Leads field metadata unavailable", {
          module: "Leads",
          status: error instanceof ZohoError ? error.status : undefined,
          code: error instanceof ZohoError ? error.code : undefined,
        });
        return [];
      }),
    ]);
    const previousCalls = await zoho<{ data?: ZCall[] }>("GET", `/Leads/${leadId}/Calls`, {
      query: { fields: CALL_FIELDS.join(","), page: 1, per_page: 200, sort_by: "Call_Start_Time", sort_order: "desc" },
    });
    const knownOutcomes: CallOutcome[] = ["Connected", "No Answer", "Busy", "Wrong Number", "Call Back Later"];
    const callDate = zohoDateTime();
    const callHistory: CallActivity[] = (previousCalls?.data ?? []).flatMap((call) => {
      const outcome = call[FIELD.call.result];
      return typeof outcome === "string" && knownOutcomes.includes(outcome as CallOutcome)
        ? [{
            id: String(call.id),
            leadId,
            ownerId: String(call.Owner?.id ?? ""),
            date: call.Call_Start_Time ?? "",
            outcome: outcome as CallOutcome,
          }]
        : [];
    });
    callHistory.push({ id: "pending", leadId, ownerId: actor.id, date: callDate, outcome: input.outcome });
    const threshold = input.notResponsiveAttempts ?? DEFAULT_NOT_RESPONSIVE_ATTEMPTS;
    const callSummary = summarizeLeadCalls(callHistory, leadId, threshold);
    const status = input.outcome === "Wrong Number"
      ? lead.status
      : input.outcome === "No Answer" || input.outcome === "Busy"
        ? callSummary.attempts >= threshold ? "Not Responsive" : "Attempted to Contact"
        : CALL_STATUS_BY_OUTCOME[input.outcome];
    const description = [lead.remarks.trim(), input.remarks.trim()].filter(Boolean).join("\n");
    const leadPayload = completeRecordFromMetadata({
      Lead_Status: WRITE_LEAD_STATUS[status],
      ...(input.remarks.trim() ? { Description: description } : {}),
    }, leadFields, undefined, "Leads");
    await writeWithMetadataFallback("PUT", `/Leads/${leadId}`, "Leads", leadPayload, leadFields, undefined, { trigger: ["workflow"] });
    const historyWarning = await addHistoryNoteBestEffort(
      leadId,
      "Call logged",
      `${input.outcome}${input.remarks ? `: ${input.remarks}` : ""} (by ${actor.name} at ${new Date().toISOString()})`,
      { operation: "call outcome" },
    );
    const callPayload = completeRecordFromMetadata({
      Subject: `${input.outcome} - ${lead.name}`,
      ...relatedToLead(leadId), Call_Type: "Outbound",
      [FIELD.call.result]: input.outcome,
      [FIELD.call.startTime]: callDate,
      Description: input.remarks || undefined,
      ...(callOwner?.id.trim() ? { Owner: { id: callOwner.id.trim() } } : {}),
    }, callFields, input.outcome, "Calls");
    let callLogPending = false;
    try {
      await writeWithMetadataFallback("POST", "/Calls", "Calls", callPayload, callFields, input.outcome);
    } catch (error) {
      callLogPending = true;
      logCallRecordFailure(error, "POST /Calls", "Calls", callPayload);
      scheduleSideEffects("call log retry", [["Call record retry", async () => {
        try {
          await writeWithMetadataFallback("POST", "/Calls", "Calls", callPayload, callFields, input.outcome);
        } catch (retryError) {
          logCallRecordFailure(retryError, "POST /Calls background retry", "Calls", callPayload);
        }
      }]]);
    }
    const sideEffects: [string, () => Promise<unknown>][] = [];
    if (input.followUp) {
      sideEffects.push(["follow-up task", async () => {
        const owner = lead.assignedTo ? await userByName(lead.assignedTo) : callOwner;
        return zohoWrite("POST", "/Tasks", {
          Subject: `Follow-up call - ${lead.name}`, Status: TASK_STATUS_WRITE.Assigned,
          Due_Date: input.followUp,
          ...(owner?.id.trim() ? { Owner: { id: owner.id.trim() } } : {}),
          ...relatedToLead(leadId),
          [FIELD.task.isSiteVisit]: false, [FIELD.task.visitTime]: input.followUpTime || undefined,
          [FIELD.task.nextAction]: "Follow up call", [FIELD.task.followUp]: input.followUp,
        });
      }]);
    }
    scheduleSideEffects("call outcome", sideEffects, () => markStale("leads", "users", "visits"));
    return {
      ...(historyWarning ? { historyWarning } : {}),
      ...(callLogPending ? { callLogPending: true } : {}),
      attempts: callSummary.attempts,
      lastOutcome: callSummary.lastOutcome,
      status,
    };
  },

  async listCalls(): Promise<CallActivity[]> {
    return cached("visits:calls", SHORT(), async () => {
      const raw = await zohoList<ZCall>("Calls", CALL_FIELDS, env().ZOHO_MAX_LEADS);
      return raw.map((call) => ({
        id: String(call.id).trim(),
        leadId: String(call.What_Id?.id ?? "").trim(),
        ownerId: String(call.Owner?.id ?? "").trim(),
        date: call.Call_Start_Time ?? "",
        ...(typeof call[FIELD.call.result] === "string" ? { outcome: call[FIELD.call.result] as CallOutcome } : {}),
      }));
    }, { keepStale: true });
  },

  async listProducts() {
    return cached("products", PRODUCTS_TTL, async () => {
      const fieldAttempts = [
        ["Product_Name", "Product_Code", "Unit_Price", "Product_Active", "Usage_Unit", "Tax"],
        ["Product_Name", "Product_Code", "Unit_Price", "Product_Active", "Usage_Unit"],
        ["Product_Name", "Unit_Price", "Product_Code", "Product_Active"],
        ["Product_Name", "Unit_Price"],
      ];
      const rememberedFields = productFieldSet
        ?? (await cached<string[] | null>("zoho:products-field-set", LONG, async () => null))
        ?? undefined;
      const attempts = rememberedFields
        ? [rememberedFields, ...fieldAttempts.filter((fields) => fields.join(",") !== rememberedFields.join(","))]
        : fieldAttempts;
      for (const fields of attempts) {
        try {
          const raw = await zohoList<ZProduct & { Product_Active?: boolean }>("Products", fields, 1000, {
            sort_by: "id",
            sort_order: "asc",
          });
          const products = uniqueProducts(raw
            .filter((product) => product.Product_Active !== false)
            .filter((product) => Boolean(product.Product_Name?.trim()))
            .map(mapProduct));
          productFieldSet = fields;
          await setCachedValue("zoho:products-field-set", LONG, fields);
          if (products.length === 0) await invalidate("products");
          return products;
        } catch (error) {
          if (!isProductFieldSetError(error)) throw error;
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
      throw new ZohoError("Zoho rejected all supported Products field sets.", 400, "INVALID_PRODUCT_FIELDS");
    }, { keepStale: true });
  },

  async createProduct(input: NewProduct) {
    const taxPercent = Number((input.gstRate * 100).toFixed(2));
    const taxMappings = input.gstRate > 0
      ? new Map((await this.listProducts())
        .flatMap((product) => product.zohoTaxes ?? [])
        .filter((tax) => Math.abs(tax.rate - input.gstRate) < 0.000001)
        .map((tax) => [`${tax.name.trim().toLocaleLowerCase()}|${tax.percentage}`, tax]))
      : new Map();
    const configuredTax = taxMappings.size === 1 ? [...taxMappings.values()][0] : undefined;
    if (input.gstRate > 0 && !configuredTax) {
      throw new ZohoError(
        `No unambiguous Zoho tax mapping is available for ${taxPercent}% GST. Configure a matching tax in Zoho CRM and refresh the product catalogue.`,
        400,
        "MISSING_PRODUCT_TAX_MAPPING",
      );
    }
    const id = await zohoWrite("POST", "/Products", {
      Product_Name: input.name,
      Product_Code: input.code,
      Usage_Unit: input.unit,
      Unit_Price: input.price,
      ...(configuredTax ? { Tax: [{ percentage: configuredTax.percentage, name: configuredTax.name }] } : {}),
    });
    return {
      id,
      model: input.name,
      code: input.code,
      unit: input.unit,
      price: input.price,
      gstRate: input.gstRate,
      ...(configuredTax ? { zohoTaxes: [configuredTax] } : {}),
    };
  },

  async listQuotes() {
    return cached("quotes", SHORT(), async () => {
      return (await quotePage(1)).quotes;
    }, { keepStale: true });
  },
  async listInvoiceCandidates() {
    return invoiceCandidates();
  },
  async listQuotesPage(page) {
    return quotePage(Math.max(1, Math.floor(page)));
  },
  async suggestOfferNo() {
    return suggestedZohoOfferNo();
  },
  async countQuotes(ownerId) {
    const ownerFilter = ownerId?.trim();
    return cached(`quotes:count:${ownerFilter || "all"}`, SHORT(), async () => {
      const response = await zoho<{ count?: number }>("GET", "/Quotes/actions/count", {
        query: ownerFilter ? { criteria: `(Owner.id:equals:${ownerFilter})` } : undefined,
      });
      if (typeof response?.count !== "number" || !Number.isFinite(response.count)) {
        throw new ZohoError("Zoho did not return a quotation count.", undefined, "INVALID_QUOTE_COUNT", undefined, undefined, "GET /Quotes/actions/count");
      }
      return response.count;
    });
  },

  async getQuote(id) {
    const schema = await quoteSchema();
    const lineItemsField = quoteLineItemsField(schema.fieldNames);
    const snapshotField = customerSnapshotField(schema.fields)?.api_name;
    const response = await zoho<{ data?: ZQuote[] }>("GET", `/Quotes/${encodeURIComponent(id)}`, {
      query: { fields: [...new Set([
        ...QUOTE_FIELDS,
        ...["Mobile", "Phone", "Customer_Name", snapshotField].filter((field): field is string => !!field && schema.fieldNames.has(field)),
        lineItemsField,
      ])].join(",") },
    });
    const originalRecord = response?.data?.[0];
    if (!originalRecord) return null;
    const record: ZQuote = snapshotField && typeof originalRecord[snapshotField] === "string"
      ? { ...originalRecord, Customer_Snapshot: originalRecord[snapshotField] as string }
      : originalRecord;
    const rawLead = record[FIELD.quote.lead];
    const leadId = rawLead && typeof rawLead === "object" && "id" in rawLead
      ? String(rawLead.id ?? "").trim()
      : typeof rawLead === "string" ? rawLead.trim() : "";
    const snapshot = parseQuoteCustomerSnapshot(record);
    const hasSnapshotDetails = Boolean(
      snapshot.name || snapshot.phone || snapshot.company || snapshot.area || snapshot.address,
    );
    let lead: Lead | null = null;
    if (leadId && !hasSnapshotDetails) {
      try {
        lead = await this.getLead(leadId);
      } catch (error) {
        console.warn("[zoho] quote Lead_Ref lookup failed; continuing with saved customer details", {
          quoteId: id,
          leadId,
          status: error instanceof ZohoError ? error.status : undefined,
          code: error instanceof ZohoError ? error.code : undefined,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const lookupName = (value: unknown) =>
      value && typeof value === "object" ? String((value as { name?: string }).name ?? "").trim() : "";
    const customerName = snapshot.name || lookupName(record.Contact_Name) || lookupName(record.Account_Name);
    const quotePhone = String(snapshot.phone ?? record.Mobile ?? record.Phone ?? "").trim();
    if (!lead && !hasSnapshotDetails && customerName) {
      try {
        const normalizedName = customerName.toLowerCase();
        lead = (await this.listLeads()).find((candidate) =>
          [candidate.name, candidate.company].some((value) => value.trim().toLowerCase() === normalizedName),
        ) ?? null;
      } catch (error) {
        console.warn("[zoho] quote customer-name lookup failed; continuing with saved customer details", {
          quoteId: id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!lead && !hasSnapshotDetails && quotePhone) {
      try {
        lead = (await this.findLeadByPhone(quotePhone))?.lead ?? null;
      } catch (error) {
        console.warn("[zoho] quote customer-phone lookup failed; continuing with saved customer details", {
          quoteId: id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const lineItems = record[lineItemsField] ?? [];
    const needsProductLookup = lineItems.length === 0 || lineItems.some((item) => {
      const product = item.product ?? item.Product_Name;
      return typeof product === "string" ? !product.trim() : !product?.name?.trim();
    });
    const products = needsProductLookup ? await this.listProducts().catch((error: unknown) => {
      console.warn("[zoho] quote products unavailable; mapping saved item snapshots", {
        quoteId: id,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }) : [];
    const map = new Map(lead ? [[lead.id, lead]] : []);
    return mapQuote(record, map, new Map(products.map((product) => [product.id, product])), schema.fieldNames);
  },

  async markQuoteSent(id) {
    const schema = await quoteSchema();
    const statusField = schema.fieldsByName.get(FIELD.quote.stage);
    const sentValue = statusField?.pick_list_values
      ?.map((item) => item.actual_value ?? item.display_value ?? "")
      .find((value) => value.toLowerCase() === "sent") ?? "Sent";
    await zohoWrite("PUT", `/Quotes/${encodeURIComponent(id)}`, { [FIELD.quote.stage]: sentValue });
  },

  async createQuote(input, actor, executive) {
    const requestedLeadId = input.leadId.trim();
    const [lead, products, owner] = await Promise.all([this.getLead(requestedLeadId), this.listProducts(), userByName(executive)]);
    if (!lead) throw new ZohoError("Lead not found", 404);
    if (!lead.id.trim() || lead.id.trim() !== requestedLeadId) {
      throw new ZohoError("The selected lead ID does not match the CRM record.", 400, "INVALID_LEAD_REFERENCE", FIELD.quote.lead);
    }
    const schema = await quoteSchema();
    const leadReferenceField = schema.fieldsByName.get(FIELD.quote.lead);
    const lineItemsField = quoteLineItemsField(schema.fieldNames);
    const lineItemsMetadata = schema.fieldsByName.get(lineItemsField);
    // Prices come from the Zoho catalogue, never from the browser.
    const lines = input.items.map((i) => {
      const p = products.find((x) => x.id === i.productId);
      if (!p) throw new ZohoError("Unknown product");
      const discount = Math.min(p.price * i.qty, Math.max(0, i.discount));
      const taxRate = i.taxRate ?? p.gstRate ?? GST_RATE;
      return { p, qty: i.qty, discount, amount: p.price * i.qty - discount, taxRate };
    });
    const savedItems = lines.map((line) => ({
      productId: line.p.id,
      model: line.p.model,
      description: line.p.description,
      unit: line.p.unit,
      qty: line.qty,
      price: line.p.price,
      discount: line.discount,
      taxRate: line.taxRate,
    }));
    const extraCharges = input.extraCharges ?? [];
    const gstBreakdown = quotationGstBreakdown(savedItems, extraCharges);
    const totals = gstBreakdown;
    const customer = lead.company || lead.name;
    const leadReference = leadReferenceField ? quoteLeadReference(leadReferenceField, lead.id) : undefined;
    const snapshotField = customerSnapshotField(schema.fields);
    const customerSnapshot = JSON.stringify(quoteRecordSnapshot(lead, gstBreakdown));
    const quoteRecord: Record<string, unknown> = {
      Subject: `Offer - ${input.subject?.trim() || customer}`,
      Owner: { id: owner.id },
      [lineItemsField]: quoteLineItemsPayload(lineItemsField, lines, lineItemsMetadata, products.flatMap((product) => product.zohoTaxes ?? [])),
      Sub_Total: totals.zoho.subtotal,
      Discount: totals.zoho.discount,
      Tax: totals.zoho.tax,
      Adjustment: totals.zoho.adjustment,
    };
    if (snapshotField?.api_name) quoteRecord[snapshotField.api_name] = customerSnapshot;
    else if (schema.fieldNames.has("Description") && schema.fieldsByName.get("Description")?.read_only !== true) {
      quoteRecord.Description = customerSnapshot;
    }
    for (const [field, value] of [["Customer_Name", lead.name], ["Mobile", lead.phone], ["Phone", lead.phone]] as const) {
      if (schema.fieldNames.has(field) && schema.fieldsByName.get(field)?.read_only !== true) quoteRecord[field] = value;
    }
    if (leadReference !== undefined) quoteRecord[FIELD.quote.lead] = leadReference;
    else {
      const reason = !leadReferenceField ? "field missing from Quotes metadata"
        : leadReferenceField.read_only ? "field is read-only"
          : leadReferenceField.data_type?.toLowerCase() === "lookup"
            ? `lookup target is ${leadReferenceField.lookup?.module?.api_name ?? "unknown"}, not Leads`
            : `unsupported field type ${leadReferenceField.data_type ?? "unknown"}`;
      console.warn("[zoho] omitting unusable optional quote lead reference", {
        field: FIELD.quote.lead,
        reason,
        leadId: lead.id,
      });
    }
    if (schema.mandatoryFields.includes("Valid_Till") && !("Valid_Till" in quoteRecord)) {
      const validTill = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      quoteRecord.Valid_Till = validTill;
    }
    if (schema.mandatoryFields.includes("Quote_Stage") && !("Quote_Stage" in quoteRecord)) {
      const stage = schema.fieldsByName.get("Quote_Stage")?.pick_list_values ?? [];
      const draft = stage.find((option) => (option.actual_value ?? option.display_value ?? "").trim().toLowerCase() === "draft");
      if (draft) quoteRecord.Quote_Stage = draft.actual_value?.trim() || draft.display_value?.trim();
    }
    for (const field of schema.mandatoryFields) {
      if (field in quoteRecord) continue;
      const addressValue = field === "Billing_Street" || field === "Shipping_Street" ? lead.address.trim()
        : field === "Billing_City" || field === "Shipping_City" ? lead.area.trim()
          : "";
      if (addressValue) quoteRecord[field] = addressValue;
    }
    const payloadFields = new Set(Object.keys(quoteRecord));
    const missingMandatory = schema.mandatoryFields
      .filter((field) => field !== FIELD.quote.lead &&
        (!payloadFields.has(field) || (field === lineItemsField && lines.length === 0)));
    if (missingMandatory.length) {
      const layoutRequiredMissing = missingMandatory.filter((field) => schema.layoutRequiredFields.includes(field));
      const reason = layoutRequiredMissing.length && schema.mandatoryLayout
        ? `Required fields missing: ${missingMandatory.join(", ")} (required by Quotes layout "${schema.mandatoryLayout}")`
        : `Required fields missing: ${missingMandatory.join(", ")}`;
      console.error("[zoho] quote payload is missing mandatory module fields", {
        operation: "POST /Quotes",
        mandatoryFields: schema.mandatoryFields,
        missingMandatory,
        mandatoryLayout: schema.mandatoryLayout,
        layoutRequiredMissing,
        payloadFields: [...payloadFields],
        lineItemsField,
        lineCount: lines.length,
      });
      throw new ZohoError(
        reason,
        400, "MANDATORY_FIELDS_MISSING", missingMandatory[0], undefined,
        "GET /settings/layouts?module=Quotes", {
          missingMandatory,
          mandatoryFields: schema.mandatoryFields,
          mandatoryLayout: schema.mandatoryLayout,
          layoutRequiredMissing,
          lineItemsField,
          lineCount: lines.length,
        },
      );
    }
    const created = await withQuoteWriteLock(async () => {
      await repairDuplicateOfferNumbersUnlocked();
      const currentOfferNos = await allOfferNumbers();
      const allocate = (used: string[]) => {
        let candidate = nextOfferNo(used, todayIST());
        if (used.includes(candidate)) candidate = nextOfferNo([...used, candidate], todayIST());
        return candidate;
      };
      const assignOfferNo = (offerNo: string) => {
        const leadIdSuffix = leadReference === undefined && !snapshotField && !("Description" in quoteRecord)
          ? ` [Lead ID: ${lead.id}]`
          : "";
        quoteRecord.Subject = `Offer ${offerNo} - ${input.subject?.trim() || customer}${leadIdSuffix}`;
        if (schema.fieldNames.has(FIELD.quote.offerNo)) quoteRecord[FIELD.quote.offerNo] = offerNo;
        else console.warn("[zoho] quote offer number custom field is unavailable; retaining it in Subject", {
          requestedField: FIELD.quote.offerNo,
        });
      };
      const write = async (offerNo: string) => {
        assignOfferNo(offerNo);
        const zohoHosts = hosts();
        console.info("[zoho] creating quote", {
          operation: "POST /Quotes",
          environment: env().ZOHO_SANDBOX === "true" ? "sandbox" : "live",
          apiHost: zohoHosts.api,
          leadId: lead.id.trim(),
          leadIdMatchesRequest: lead.id.trim() === requestedLeadId,
          leadRefField: leadReferenceField?.api_name ?? null,
          leadRefValueType: leadReference === null ? "null" : Array.isArray(leadReference) ? "array" : typeof leadReference,
          fieldMetadata: {
            api_name: leadReferenceField?.api_name ?? null,
            data_type: leadReferenceField?.data_type ?? null,
            json_type: leadReferenceField?.json_type ?? null,
            lookup_module_api_name: leadReferenceField?.lookup?.module?.api_name ?? null,
            system_mandatory: leadReferenceField?.system_mandatory ?? null,
            required: leadReferenceField?.required ?? null,
            is_mandatory: leadReferenceField?.is_mandatory ?? null,
            read_only: leadReferenceField?.read_only ?? null,
            max_length: leadReferenceField?.max_length ?? null,
          },
          mandatoryLayout: schema.mandatoryLayout,
          layoutRequiredFields: schema.layoutRequiredFields,
          lineItemsField,
          lineItemSubfields: quoteLineItemFields(lineItemsMetadata)
            .map((field) => field.api_name).filter(Boolean),
          payloadKeys: Object.keys(quoteRecord),
        });
        return writeQuoteWithTaxFallback(
          "POST", "/Quotes", quoteRecord, lineItemsField,
          totals.zoho.tax, totals.zoho.adjustment,
        );
      };
      let offerNo = allocate(currentOfferNos);
      try {
        const id = await write(offerNo);
        return { id, offerNo };
      } catch (error) {
        if (!(error instanceof ZohoError) || error.code !== "DUPLICATE_DATA") throw error;
        const latestOfferNos = await allOfferNumbers();
        offerNo = allocate([...latestOfferNos, offerNo]);
        const id = await write(offerNo);
        return { id, offerNo };
      }
    });
    scheduleSideEffects("create quotation", [["history note", () => addHistoryNoteBestEffort(
      lead.id, "Quotation created", `Quotation ${created.offerNo} created by ${actor.name}`,
      { action: "create quote", quoteId: created.id },
    )]]);
    return {
      id: created.id,
      offerNo: created.offerNo,
      leadId: lead.id,
      customer,
      contactName: lead.name,
      company: lead.company,
      phone: lead.phone,
      email: lead.email,
      area: lead.area,
      address: lead.address,
      executive,
      total: totals.total,
      status: "Draft",
      date: new Date().toISOString().slice(0, 10),
      items: savedItems,
      gstBreakdown,
    };
  },

  async updateQuote(id, input, actor) {
    const current = await this.getQuote(id);
    if (!current) throw new ZohoError("Quotation not found.", 404, "NOT_FOUND");
    if (current.leadId !== input.leadId) {
      throw new ZohoError("The customer cannot be changed while editing a quotation.", 400, "INVALID_LEAD_REFERENCE");
    }
    const [lead, products] = await Promise.all([this.getLead(input.leadId), this.listProducts()]);
    if (!lead) throw new ZohoError("Lead not found.", 404);
    const schema = await quoteSchema();
    const lineItemsField = quoteLineItemsField(schema.fieldNames);
    const lineItemsMetadata = schema.fieldsByName.get(lineItemsField);
    const lines = input.items.map((item) => {
      const product = products.find((candidate) => candidate.id === item.productId);
      if (!product) throw new ZohoError("Unknown product.", 400, "INVALID_PRODUCT");
      const discount = Math.min(product.price * item.qty, Math.max(0, item.discount));
      return {
        p: product,
        qty: item.qty,
        discount,
        amount: product.price * item.qty - discount,
        taxRate: item.taxRate ?? product.gstRate ?? GST_RATE,
      };
    });
    const savedItems = lines.map((line) => ({
      productId: line.p.id,
      model: line.p.model,
      description: line.p.description,
      unit: line.p.unit,
      qty: line.qty,
      price: line.p.price,
      discount: line.discount,
      taxRate: line.taxRate,
    }));
    const revision = (current.revision ?? 0) + 1;
    const extraCharges = input.extraCharges ?? [];
    const gstBreakdown = quotationGstBreakdown(savedItems, extraCharges);
    const title = input.subject?.trim()
      || current.subject?.replace(/^Offer\s+.+?\s+-\s+/i, "").trim()
      || offerSubject(savedItems.map((item) => item.model));
    const record: Record<string, unknown> = {
      Subject: `Offer ${current.offerNo}/R${revision} - ${title}`,
      [lineItemsField]: quoteLineItemsPayload(lineItemsField, lines, lineItemsMetadata, products.flatMap((product) => product.zohoTaxes ?? [])),
      Sub_Total: gstBreakdown.zoho.subtotal,
      Discount: gstBreakdown.zoho.discount,
      Tax: gstBreakdown.zoho.tax,
      Adjustment: gstBreakdown.zoho.adjustment,
    };
    if (schema.fieldNames.has(FIELD.quote.offerNo) && schema.fieldsByName.get(FIELD.quote.offerNo)?.read_only !== true) {
      record[FIELD.quote.offerNo] = current.offerNo;
    }
    const snapshotField = customerSnapshotField(schema.fields);
    const customerSnapshot = JSON.stringify(quoteRecordSnapshot(lead, gstBreakdown, revision));
    if (snapshotField?.api_name) record[snapshotField.api_name] = customerSnapshot;
    else if (schema.fieldNames.has("Description") && schema.fieldsByName.get("Description")?.read_only !== true) {
      record.Description = customerSnapshot;
    }
    for (const [field, value] of [["Customer_Name", lead.name], ["Mobile", lead.phone], ["Phone", lead.phone]] as const) {
      if (schema.fieldNames.has(field) && schema.fieldsByName.get(field)?.read_only !== true) record[field] = value;
    }

    const write = (payload: Record<string, unknown>) =>
      writeQuoteWithTaxFallback(
        "PUT", `/Quotes/${encodeURIComponent(id)}`, payload, lineItemsField,
        gstBreakdown.zoho.tax, gstBreakdown.zoho.adjustment,
      );
    await write(record);
    scheduleSideEffects("revise quotation", [["history note", () => addHistoryNoteBestEffort(
      lead.id, "Quotation revised", `Quotation ${current.offerNo} revised R${revision} by ${actor.name}`,
      { action: "revise quotation", quoteId: id },
    )]]);
    return {
      ...current,
      offerNo: current.offerNo,
      revision,
      leadId: lead.id,
      customer: lead.company || lead.name,
      contactName: lead.name,
      company: lead.company,
      phone: lead.phone,
      email: lead.email,
      area: lead.area,
      address: lead.address,
      subject: record.Subject as string,
      total: gstBreakdown.total,
      items: savedItems,
      gstBreakdown,
    };
  },

  async listInvoices() {
    return cached("invoices", SHORT(), async () => {
      const rows = await zohoList<ZohoInvoiceRecord>("Invoices", [
        "Subject", "Status", "Created_Time", "Account_Name",
        FIELD.invoice.invoiceNo, FIELD.invoice.customerGstin,
        FIELD.invoice.sourceQuoteId, FIELD.invoice.snapshot,
      ], env().ZOHO_MAX_LEADS);
      // One bad/foreign invoice record (no ATPL snapshot) must not break the whole page.
      const invoices: ReturnType<typeof mapZohoInvoice>[] = [];
      for (const row of rows) {
        try {
          invoices.push(mapZohoInvoice(row));
        } catch (error) {
          console.warn("[zoho] skipped invoice without a valid ATPL snapshot", {
            id: String(row.id),
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return invoices;
    }, { keepStale: true });
  },

  async getInvoice(id) {
    const response = await zoho<{ data?: ZohoInvoiceRecord[] }>("GET", `/Invoices/${encodeURIComponent(id)}`, {
      query: {
        fields: [
          "Subject", "Status", "Created_Time", "Account_Name",
          FIELD.invoice.invoiceNo, FIELD.invoice.customerGstin,
          FIELD.invoice.sourceQuoteId, FIELD.invoice.snapshot,
        ].join(","),
      },
    });
    const record = response?.data?.[0];
    return record ? mapZohoInvoice(record) : null;
  },

  async createInvoice(quote, lead, actor, gstin) {
    const existing = (await this.listInvoices()).find((invoice) => invoice.quoteId === quote.id);
    if (existing) return existing;
    const accountId = quote.accountId || lead.accountId || await ensureAccountForLead(lead);
    const schema = await invoiceSchema();
    const lineItemsField = invoiceLineItemsField(schema.fieldNames);
    if (!quote.items?.length || quote.items.some((item) => !item.productId)) {
      throw new ZohoError(
        "This quotation contains an item without a Zoho Product. Update the quotation before converting it.",
        400, "INVOICE_PRODUCT_REQUIRED", lineItemsField,
      );
    }
    const invoiceNo = await nextInvoiceNumber();
    const invoice = invoiceSnapshot(quote, lead, invoiceNo, actor, gstin, todayIST());
    const products = await this.listProducts();
    const productsById = new Map(products.map((product) => [product.id, product]));
    const items = invoice.items.map((item) => ({
      p: {
        id: item.productId!,
        model: item.model,
        description: item.description,
        unit: item.unit,
        price: item.price,
        zohoTaxes: productsById.get(item.productId!)?.zohoTaxes,
      },
      qty: item.qty,
      discount: item.discount ?? 0,
      amount: Math.max(0, item.qty * item.price - (item.discount ?? 0)),
      taxRate: item.taxRate ?? GST_RATE,
    }));
    const configuredTaxes = products.flatMap((product) => product.zohoTaxes ?? []);
    const lineItemsMetadata = lineItemsField === "Invoiced_Items"
      ? schema.fieldsByName.get(lineItemsField)
      : undefined;
    const extraCharges = invoice.gstBreakdown.extraCharges ?? [];
    const payload: Record<string, unknown> = {
      Subject: `Invoice ${invoiceNo} - ${invoice.customer}`,
      Invoice_Date: invoice.date,
      Account_Name: { id: accountId },
      [lineItemsField]: quoteLineItemsPayload(lineItemsField, items, lineItemsMetadata, configuredTaxes),
      Sub_Total: invoice.gstBreakdown.subtotal,
      Discount: invoice.gstBreakdown.discount,
      Tax: invoice.gstBreakdown.gst,
      Adjustment: extraCharges.reduce((sum, charge) => sum + charge.amount, 0),
      Grand_Total: invoice.total,
      [FIELD.invoice.invoiceNo]: invoiceNo,
      [FIELD.invoice.customerGstin]: gstin,
      [FIELD.invoice.sourceQuoteId]: quote.id,
      [FIELD.invoice.snapshot]: JSON.stringify(invoice),
    };
    const id = await zohoWrite("POST", "/Invoices", payload);
    if (!id) throw new ZohoError("Zoho did not return the created invoice ID.", undefined, "INVOICE_ID_MISSING");
    const saved = { ...invoice, id };
    await invalidate("invoices");
    return saved;
  },

  async listVisits() {
    return cached("visits", SHORT(), loadVisits, { keepStale: true });
  },
  getVisitsWarning() { return taskMetadataWarning; },
  async getVisit(id) {
    const encodedId = encodeURIComponent(id);
    try {
      const response = await zoho<{ data?: ZTask[] }>("GET", `/Tasks/${encodedId}`, {
        query: { fields: [...new Set([...TASK_FIELDS, ...STANDARD_TASK_FIELDS])].join(",") },
      });
      const task = response?.data?.[0];
      if (task) return mapTask(task, await leadMap());
    } catch (error) {
      if (!(error instanceof ZohoError) || error.status !== 404) throw error;
    }

    const schema = await getSiteVisitsSchema();
    if (!schema?.lead || !schema.date) return null;
    try {
      const fields = [...new Set([schema.lead, schema.date, schema.time, schema.status, schema.address, schema.notes, schema.nextAction, schema.followUp, "Owner", "Name"].filter(Boolean) as string[])];
      const response = await zoho<{ data?: Record<string, unknown>[] }>("GET", `/${schema.module}/${encodedId}`, {
        query: { fields: fields.join(",") },
      });
      const record = response?.data?.[0];
      return record ? mapSiteVisitRecord(schema, record, await leadMap()) : null;
    } catch (error) {
      if (error instanceof ZohoError && error.status === 404) return null;
      throw error;
    }
  },

  async createVisit(input, actor) {
    const [owner, lead] = await Promise.all([userByName(input.executive), this.getLead(input.leadId)]);
    if (!lead) throw new ZohoError("Lead not found", 404);
    const address = input.address?.trim() || [lead.address, lead.area].filter(Boolean).join(", ");
    const taskId = await zohoWrite("POST", "/Tasks", {
      Subject: `${input.type} - ${lead.company || lead.name}`,
      Status: TASK_STATUS_WRITE.Assigned, Due_Date: input.date, Owner: { id: owner.id },
      ...relatedToLead(lead.id),
      [FIELD.task.type]: input.type, [FIELD.task.isSiteVisit]: input.isVisit,
      [FIELD.task.visitTime]: input.time, [FIELD.task.nextAction]: input.nextAction,
      [FIELD.task.followUp]: input.followUp || undefined,
    });
    const createdVisit: Visit = {
      id: taskId,
      leadId: lead.id,
      customer: lead.company || lead.name,
      phone: lead.phone,
      address,
      area: lead.area,
      executive: owner.name,
      executiveId: String(owner.id),
      type: input.type,
      isVisit: input.isVisit,
      date: input.date,
      time: input.time,
      status: "Assigned",
      nextAction: input.nextAction,
      followUp: input.followUp ?? "",
      notes: "",
      done: false,
    };
    const sideEffects: [string, () => Promise<unknown>][] = [
      ["history note", () => addHistoryNoteBestEffort(
        lead.id, "Work scheduled", `${input.isVisit ? "Site visit" : "Work"} scheduled: ${input.type} on ${input.date} (by ${actor.name})`,
        { action: "schedule work" },
      )],
      ...(input.isVisit ? [["lead status", () => advanceLead(lead.id, lead.status, "Site Visit Scheduled")] as [string, () => Promise<unknown>]] : []),
    ];
    if (input.isVisit) sideEffects.push(["calendar event", async () => {
      const startDate = new Date(`${input.date}T${input.time}:00+05:30`);
      const endDate = new Date(startDate.getTime() + 60 * 60_000);
      const start = zohoDateTime(startDate);
      const end = zohoDateTime(endDate);
      return zohoWrite("POST", "/Events", {
        Event_Title: `${input.type} - ${lead.company || lead.name}`,
        Start_DateTime: start, End_DateTime: end, Location: address || undefined,
        ...relatedToLead(lead.id), Owner: { id: owner.id },
        Description: input.nextAction || undefined,
      });
    }]);
    scheduleSideEffects("schedule work", sideEffects, () => markStale("leads", "visits"));
    return createdVisit;
  },

  async updateVisit(id, p, actor, existingVisit) {
    const current = existingVisit ?? await this.getVisit(id);
    if (!current) throw new ZohoError("Visit not found", 404);
    if (current.module) {
      const schema = await getSiteVisitsSchema();
      if (!schema) throw new ZohoError("Site Visits schema unavailable", 404);
      const payload = mapSiteVisitUpdate(schema, p);
      const missingFields = [
        p.status && !schema.status ? "Status" : "",
        p.date && !schema.date ? "Visit date" : "",
        p.time && !schema.time ? "Visit time" : "",
        p.followUp && !schema.followUp ? "Follow-up date" : "",
        p.notes && !schema.notes ? "Notes" : "",
      ].filter(Boolean);
      if (missingFields.length) {
        throw new ZohoError(`Site Visits fields unavailable: ${missingFields.join(", ")}`, 400, "INVALID_FIELD", undefined, undefined, `PUT /${schema.module}/${id}`);
      }
      await zohoWrite("PUT", `/${schema.module}/${id}`, payload);
      const changes = [
        p.status ? `Status: ${p.status}` : "",
        p.date ? `Date: ${p.date}` : "",
        p.time ? `Time: ${p.time}` : "",
        p.followUp ? `Follow-up: ${p.followUp}` : "",
        p.notes?.trim() ? `Notes: ${p.notes.trim()}` : "",
      ].filter(Boolean);
      if (changes.length && current.leadId) {
        scheduleSideEffects("update site visit", [["history note", () => addHistoryNoteBestEffort(current.leadId, "Work update", `${changes.join(" · ")} (by ${actor.name})`, {
          action: "update site visit",
          visitId: id,
        })]]);
      }
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
    if (changes.length) {
      scheduleSideEffects("update task", [["history note", () => addHistoryNoteBestEffort(
        current.leadId, "Work update", `${changes.join(" · ")} (by ${actor.name})`,
        { taskId: id, operation: "update task" },
      )]]);
    }
  },
};
