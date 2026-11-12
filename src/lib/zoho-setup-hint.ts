import { ZohoError } from "@/lib/zoho/client";

export type SetupProblem = { summary: string; hint?: string; reference?: string };

type ZohoModule = "Quotes" | "Invoices" | "Leads" | "Tasks";

function failingModule(error: unknown): ZohoModule | undefined {
  if (!(error instanceof ZohoError)) return undefined;
  const moduleName = /\/(Quotes|Invoices|Leads|Tasks)(?=\/|[?#\s]|$)/i.exec(error.operation ?? "")?.[1]?.toLowerCase();
  if (moduleName === "quotes") return "Quotes";
  if (moduleName === "invoices") return "Invoices";
  if (moduleName === "leads") return "Leads";
  if (moduleName === "tasks") return "Tasks";
  return undefined;
}

function failingField(error: unknown): string | undefined {
  if (!(error instanceof ZohoError)) return undefined;
  const details = error.details;
  const field = error.field ?? details?.api_name ?? details?.field ?? details?.param_name;
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

export function describeLoadProblem(error: unknown, what: string): SetupProblem {
  const message = error instanceof Error ? error.message : String(error);
  const reference = error instanceof ZohoError ? error.reference : undefined;
  const code = error instanceof ZohoError ? (error.code ?? "") : "";
  const status = error instanceof ZohoError ? error.status : undefined;
  const lower = `${code} ${message}`.toLowerCase();
  const moduleName = failingModule(error);
  const field = failingField(error);

  if (lower.includes("exceeded the request time limit") || lower.includes("timeout")) {
    return { summary: `${what} is taking longer than usual to load.`, hint: "Zoho is responding slowly. Press Retry in a few seconds.", reference };
  }
  if (status === 401 || status === 403 || lower.includes("scope") || lower.includes("no_permission") || lower.includes("oauth")) {
    return {
      summary: `${what} could not be loaded from Zoho.`,
      hint: "The Zoho connection does not have permission for this module. Generate a new refresh token that includes ZohoCRM.modules.invoices.ALL, ZohoCRM.modules.accounts.ALL and ZohoCRM.modules.products.CREATE, then update ZOHO_REFRESH_TOKEN in Vercel.",
      reference,
    };
  }
  if (code.toUpperCase() === "INVALID_QUERY" || lower.includes("invalid query formed")) {
    const fieldLabel = field ? ` (${field})` : "";
    const hint = moduleName
      ? `A search used a field that doesn't exist in the ${moduleName} module${fieldLabel}. Check the Zoho field API name and module configuration.`
      : `A Zoho search used a field that doesn't exist${fieldLabel}. Check the field API name and module configuration.`;
    return { summary: `${what} could not be loaded from Zoho.`, hint, reference };
  }
  if (lower.includes("invalid_module") || lower.includes("invalid module") || status === 404) {
    const hint = moduleName
      ? `The ${moduleName} module is not enabled in this Zoho organisation (Setup > Modules and Fields).`
      : "The requested Zoho module is not enabled in this organisation (Setup > Modules and Fields).";
    return { summary: `${what} could not be loaded from Zoho.`, hint, reference };
  }
  if (lower.includes("invalid_data") || lower.includes("field") || status === 400) {
    const fieldLabel = field ? `Field ${field}` : "A field";
    if (moduleName === "Invoices") {
      return {
        summary: `${what} could not be loaded from Zoho.`,
        hint: `Zoho rejected ${fieldLabel} in the Invoices module. Check its API name and type. Required ATPL invoice fields: ATPL_Invoice_No (single line), Customer_GSTIN (single line), ATPL_Source_Quote_ID (single line), ATPL_Invoice_Snapshot (multi-line, large).`,
        reference,
      };
    }
    return {
      summary: `${what} could not be loaded from Zoho.`,
      hint: moduleName
        ? `Zoho rejected ${fieldLabel} in the ${moduleName} module. Check that the field API name exists in this module and matches the configured Zoho field.`
        : `Zoho rejected ${fieldLabel}. Check its API name and type in the failing Zoho module.`,
      reference,
    };
  }
  return { summary: `${what} could not be loaded right now.`, hint: "Please retry. If it keeps happening, contact your administrator.", reference };
}
