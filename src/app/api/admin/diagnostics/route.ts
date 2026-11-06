import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/guard";
import { env } from "@/lib/env";
import { LEAD_SOURCES } from "@/lib/domain";
import { FIELD, ROLE_BY_ZOHO_NAME, WRITE_LEAD_STATUS } from "@/lib/zoho/fields";
import { hosts, zoho, zohoList, zohoRuntimeStatus } from "@/lib/zoho/client";
import { ZohoError } from "@/lib/zoho/client";
import { friendlyZohoError, newErrorReference } from "@/lib/crm-action-errors";
import { mapRole, parseRoleOverrides, type ZLead, type ZUser } from "@/lib/zoho/mappers";
import { zohoLeadSource } from "@/lib/zoho/fields";
import { STATIC_USERS } from "@/lib/auth/users";
import { siteVisitSchema } from "@/lib/zoho/site-visits";

export const dynamic = "force-dynamic";

type CheckResult<T> = T | { error: string };
type ZohoField = { api_name?: string; pick_list_values?: { actual_value?: string; display_value?: string }[] };

const check = async <T>(fn: () => T | Promise<T>): Promise<CheckResult<T>> => {
  try {
    return await fn();
  } catch (error) {
    const reference = newErrorReference();
    console.error("[api] Zoho diagnostics check failed", {
      reference,
      message: error instanceof Error ? error.message : String(error),
      status: error instanceof ZohoError ? error.status : undefined,
      code: error instanceof ZohoError ? error.code : undefined,
      field: error instanceof ZohoError ? error.field : undefined,
      details: error instanceof ZohoError ? error.details : undefined,
      operation: error instanceof ZohoError ? error.operation : undefined,
    });
    const message = error instanceof ZohoError
      ? friendlyZohoError(error.status, error.code, error.message, error.field, reference)
      : `Diagnostic check failed. (Ref: ${reference})`;
    return { error: message };
  }
};

const isError = (value: unknown): value is { error: string } =>
  typeof value === "object" && value !== null && "error" in value && typeof value.error === "string";

export async function GET() {
  try {
    const user = await check(() => currentUser());
    if (isError(user)) return NextResponse.json(user, { status: 500 });
    if (!user || user.role !== "Manager") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const configuration = await check(() => {
      const e = env();
      return {
        dataSource: e.DATA_SOURCE,
        sandboxFlag: e.ZOHO_SANDBOX,
        apiHost: hosts().api,
        sharedTokenStore: zohoRuntimeStatus(),
      };
    });
    if (isError(configuration)) return NextResponse.json(configuration, { status: 500 });

    const overrides = parseRoleOverrides(env().ZOHO_ROLE_OVERRIDES);
    const configuredQueueOwnerId = env().ZOHO_QUEUE_OWNER_ID;
    const org = await check(async () => {
      const response = await zoho<{ org?: { company_name?: string; type?: string }[] }>("GET", "/org");
      const item = response?.org?.[0];
      return { companyName: item?.company_name ?? "", environment: item?.type ?? "" };
    });
    const rawUsers = await check(async () => {
      const response = await zoho<{ users?: ZUser[] }>("GET", "/users", { query: { type: "ActiveUsers" } });
      return response?.users ?? [];
    });
    const leadCounts = await check(async () => {
      const leads = await zohoList<ZLead>("Leads", ["Owner"], env().ZOHO_MAX_LEADS);
      const counts = new Map<string, number>();
      for (const lead of leads) {
        const id = String(lead.Owner?.id ?? "").trim() || "unassigned";
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return Object.fromEntries(counts);
    });
    const moduleAccess = await check(async () => {
      const [calls, events] = await Promise.all([
        zoho<{ data?: unknown[] }>("GET", "/Calls", { query: { per_page: 1 } }),
        zoho<{ data?: unknown[] }>("GET", "/Events", { query: { per_page: 1 } }),
      ]);
      return { calls: calls?.data?.length ?? 0, events: events?.data?.length ?? 0 };
    });
    const products = await check(async () => {
      const response = await zoho<{ data?: Record<string, unknown>[]; info?: { more_records?: boolean } }>("GET", "/Products", {
        query: {
          fields: "Product_Name,Unit_Price,Product_Active",
          per_page: 200,
        },
      });
      const rows = response?.data ?? [];
      const inactive = rows.filter((row) => row.Product_Active === false || String(row.Product_Active).toLowerCase() === "false").length;
      const withoutPrice = rows.filter((row) => row.Unit_Price === undefined || row.Unit_Price === null || row.Unit_Price === "").length;
      return {
        fetched: rows.length,
        inactive,
        withoutPrice,
        sample: rows.slice(0, 3),
      };
    });
    const siteVisits = await check(async () => {
      const schema = await siteVisitSchema();
      if (!schema) {
        return { found: false, hint: "Set ZOHO_SITE_VISITS_MODULE to the custom module API name." };
      }
      const fields = [...new Set([
        schema.lead,
        schema.date,
        schema.time,
        schema.status,
        schema.address,
        schema.notes,
        schema.nextAction,
        schema.followUp,
        "Owner",
        "Name",
      ].filter(Boolean) as string[])];
      const response = await zoho<{ data?: Record<string, unknown>[] }>("GET", `/${schema.module}`, {
        query: { fields: fields.join(","), per_page: 2 },
      });
      return { found: true, schema, sample: response?.data?.slice(0, 2) ?? [] };
    });
    const normalizedQueueOwnerId = configuredQueueOwnerId?.trim();
    const queueOwner = isError(rawUsers) ? undefined : rawUsers.find((u) => String(u.id).trim() === normalizedQueueOwnerId);
    const queueOwnerRole = queueOwner ? mapRole(queueOwner, overrides) : null;
    const queueOwnerIsAssignable = !!configuredQueueOwnerId &&
      (queueOwnerRole === "Sales Executive" || queueOwnerRole === "Manager");
    const users = isError(rawUsers)
      ? rawUsers
      : {
          users: rawUsers.map((u) => ({
            id: String(u.id).trim(),
            name: u.full_name,
            email: u.email ?? "",
            role: { name: u.role?.name ?? "" },
            profile: { name: u.profile?.name ?? "" },
            portalRole: mapRole(u, overrides) ?? "NOT MAPPED",
            matchedPortalUser: STATIC_USERS.find((portalUser) =>
              portalUser.email?.trim().toLowerCase() === u.email?.trim().toLowerCase(),
            )?.name ?? null,
          })),
          leadsPerOwnerId: leadCounts,
          salesExecutives: rawUsers.filter((u) => mapRole(u, overrides) === "Sales Executive").length,
          mappedExecutiveNames: rawUsers
            .filter((u) => mapRole(u, overrides) === "Sales Executive")
            .map((u) => u.full_name),
          unmapped: rawUsers.filter((u) => !mapRole(u, overrides)).map((u) => ({
            name: u.full_name, email: u.email ?? "", role: u.role?.name ?? "", profile: u.profile?.name ?? "",
          })),
          suggestedRoleOverrides: rawUsers.filter((u) => !mapRole(u, overrides) && u.email)
            .map((u) => `${u.email}:Sales Executive`).join(","),
          queueOwner: {
            configured: !!configuredQueueOwnerId,
            resolvesToActiveUser: !!normalizedQueueOwnerId && rawUsers.some((u) => String(u.id).trim() === normalizedQueueOwnerId),
            queueOwnerIsAssignable,
            warning: queueOwnerRole === "Manager"
              ? "ZOHO_QUEUE_OWNER_ID maps to a Manager role; the queue owner should not be assignable."
              : queueOwnerIsAssignable
              ? "The queue owner is assignable; leads owned by this user will never show as unassigned."
              : undefined,
          },
        };

    const leadFields = await check(async () => {
      const response = await zoho<{ fields?: ZohoField[] }>("GET", "/settings/fields", { query: { module: "Leads" } });
      return response?.fields ?? [];
    });
    const leadPicklists = isError(leadFields)
      ? leadFields
      : {
          leadStatusMissing: missingPicklistValues(leadFields, "Lead_Status", Object.values(WRITE_LEAD_STATUS)),
          leadSourceMissing: LEAD_SOURCES.filter((source) => {
            const field = leadFields.find((candidate) => candidate.api_name === "Lead_Source");
            const values = (field?.pick_list_values ?? []).flatMap((item) => [item.actual_value, item.display_value])
              .filter((value): value is string => !!value);
            return !zohoLeadSource(source, values);
          }),
        };

    const customFields = await check(async () => {
      const [quotes, tasks] = await Promise.all([
        zoho<{ fields?: ZohoField[] }>("GET", "/settings/fields", { query: { module: "Quotes" } }),
        zoho<{ fields?: ZohoField[] }>("GET", "/settings/fields", { query: { module: "Tasks" } }),
      ]);
      return {
        quoteMissing: missingApiNames(quotes?.fields ?? [], Object.values(FIELD.quote)),
        taskMissing: missingApiNames(tasks?.fields ?? [], Object.values(FIELD.task)),
      };
    });

    return NextResponse.json({
      ...configuration,
      zohoOrg: org,
      users,
      leadPicklists,
      moduleAccess,
      products,
      siteVisits,
      customFields,
      roleOverrideEmails: [...overrides.keys()],
      knownRoleNames: Object.keys(ROLE_BY_ZOHO_NAME),
    });
  } catch (error) {
    const reference = newErrorReference();
    console.error("[api] Zoho diagnostics failed", {
      reference,
      message: error instanceof Error ? error.message : String(error),
      status: error instanceof ZohoError ? error.status : undefined,
      code: error instanceof ZohoError ? error.code : undefined,
      field: error instanceof ZohoError ? error.field : undefined,
      details: error instanceof ZohoError ? error.details : undefined,
      operation: error instanceof ZohoError ? error.operation : undefined,
    });
    const message = error instanceof ZohoError
      ? friendlyZohoError(error.status, error.code, error.message, error.field, reference)
      : `Diagnostics failed. (Ref: ${reference})`;
    return NextResponse.json({ error: message, reference }, { status: 500 });
  }
}

function missingApiNames(fields: ZohoField[], expected: string[]) {
  const present = new Set(fields.map((field) => field.api_name).filter(Boolean));
  return expected.filter((name) => !present.has(name));
}

function missingPicklistValues(fields: ZohoField[], apiName: string, expected: string[]) {
  const field = fields.find((candidate) => candidate.api_name === apiName);
  const present = new Set(
    (field?.pick_list_values ?? []).flatMap((value) => [value.actual_value, value.display_value]).filter(Boolean),
  );
  return expected.filter((value) => !present.has(value));
}
