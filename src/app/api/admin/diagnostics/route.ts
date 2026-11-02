import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/guard";
import { env } from "@/lib/env";
import { LEAD_SOURCES } from "@/lib/domain";
import { FIELD, ROLE_BY_ZOHO_NAME, WRITE_LEAD_STATUS } from "@/lib/zoho/fields";
import { hosts, zoho } from "@/lib/zoho/client";
import { mapRole, parseRoleOverrides, type ZUser } from "@/lib/zoho/mappers";

export const dynamic = "force-dynamic";

type CheckResult<T> = T | { error: string };
type ZohoField = { api_name?: string; pick_list_values?: { actual_value?: string; display_value?: string }[] };

const check = async <T>(fn: () => T | Promise<T>): Promise<CheckResult<T>> => {
  try {
    return await fn();
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Diagnostic check failed" };
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
      return { dataSource: e.DATA_SOURCE, sandboxFlag: e.ZOHO_SANDBOX, apiHost: hosts().api };
    });
    if (isError(configuration)) return NextResponse.json(configuration, { status: 500 });

    const overrides = parseRoleOverrides(env().ZOHO_ROLE_OVERRIDES);
    const org = await check(async () => {
      const response = await zoho<{ org?: { company_name?: string; type?: string }[] }>("GET", "/org");
      const item = response?.org?.[0];
      return { companyName: item?.company_name ?? "", environment: item?.type ?? "" };
    });
    const rawUsers = await check(async () => {
      const response = await zoho<{ users?: ZUser[] }>("GET", "/users", { query: { type: "ActiveUsers" } });
      return response?.users ?? [];
    });
    const users = isError(rawUsers)
      ? rawUsers
      : {
          users: rawUsers.map((u) => ({
            name: u.full_name,
            email: u.email ?? "",
            role: { name: u.role?.name ?? "" },
            profile: { name: u.profile?.name ?? "" },
            portalRole: mapRole(u, overrides) ?? "NOT MAPPED",
          })),
          salesExecutives: rawUsers.filter((u) => mapRole(u, overrides) === "Sales Executive").length,
          unmapped: rawUsers.filter((u) => !mapRole(u, overrides)).map((u) => ({
            name: u.full_name, email: u.email ?? "", role: u.role?.name ?? "", profile: u.profile?.name ?? "",
          })),
          suggestedRoleOverrides: rawUsers.filter((u) => !mapRole(u, overrides) && u.email)
            .map((u) => `${u.email}:Sales Executive`).join(","),
        };

    const leadFields = await check(async () => {
      const response = await zoho<{ fields?: ZohoField[] }>("GET", "/settings/fields", { query: { module: "Leads" } });
      return response?.fields ?? [];
    });
    const leadPicklists = isError(leadFields)
      ? leadFields
      : {
          leadStatusMissing: missingPicklistValues(leadFields, "Lead_Status", Object.values(WRITE_LEAD_STATUS)),
          leadSourceMissing: missingPicklistValues(leadFields, "Lead_Source", LEAD_SOURCES),
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
      customFields,
      roleOverrideEmails: [...overrides.keys()],
      knownRoleNames: Object.keys(ROLE_BY_ZOHO_NAME),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Diagnostics failed" }, { status: 500 });
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
