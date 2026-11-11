import { ZohoError } from "@/lib/zoho/client";

export type SetupProblem = { summary: string; hint?: string; reference?: string };

export function describeLoadProblem(error: unknown, what: string): SetupProblem {
  const message = error instanceof Error ? error.message : String(error);
  const reference = error instanceof ZohoError ? error.reference : undefined;
  const code = error instanceof ZohoError ? (error.code ?? "") : "";
  const status = error instanceof ZohoError ? error.status : undefined;
  const lower = `${code} ${message}`.toLowerCase();

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
  if (lower.includes("invalid_module") || lower.includes("invalid module") || status === 404) {
    return { summary: `${what} could not be loaded from Zoho.`, hint: "The Invoices module is not enabled in this Zoho organisation (Setup > Modules and Fields).", reference };
  }
  if (lower.includes("invalid_data") || lower.includes("field") || status === 400) {
    return {
      summary: `${what} could not be loaded from Zoho.`,
      hint: "A custom field is missing in the Zoho Invoices module. Create: ATPL_Invoice_No (single line), Customer_GSTIN (single line), ATPL_Source_Quote_ID (single line), ATPL_Invoice_Snapshot (multi-line, large).",
      reference,
    };
  }
  return { summary: `${what} could not be loaded right now.`, hint: "Please retry. If it keeps happening, contact your administrator.", reference };
}
