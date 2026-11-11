import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { canConvertToInvoice } from "@/lib/invoice-rules";
import { visibleFor } from "@/lib/domain";
import { InvoiceClient } from "./InvoiceClient";
import { ZohoError } from "@/lib/zoho/client";
import { newErrorReference } from "@/lib/crm-action-errors";

export const metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";

export default async function InvoicesPage() {
  const user = await requireSection("invoices");
  const repository = crm();
  let allInvoices: Awaited<ReturnType<typeof repository.listInvoices>>;
  let allQuotes: Awaited<ReturnType<typeof repository.listQuotes>>;
  let allLeads: Awaited<ReturnType<typeof repository.listLeads>>;
  let loadError: string | undefined;
  try {
    [allInvoices, allQuotes, allLeads] = await Promise.all([
      repository.listInvoices(),
      repository.listQuotes(),
      repository.listLeads(),
    ]);
  } catch (error) {
    const reference = newErrorReference();
    const zohoError = error instanceof ZohoError ? error : null;
    const isInvoicePermissionError = !!zohoError && (
      ["OAUTH_SCOPE_MISMATCH", "NO_PERMISSION", "INVALID_MODULE", "MODULE_NOT_FOUND"].includes(zohoError.code ?? "") ||
      /scope|permission|module.{0,20}(not found|unavailable|invalid)/i.test(zohoError.message)
    );
    console.error("[page] invoice data load failed", {
      reference,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      zohoStatus: zohoError?.status,
      zohoCode: zohoError?.code,
      zohoOperation: zohoError?.operation,
      zohoDetails: zohoError?.details,
    });
    loadError = isInvoicePermissionError
      ? `Invoice data is not available. Ask your Zoho administrator to enable the Invoices module and grant ZohoCRM.modules.invoices.ALL, then generate a new refresh token. Reference: ${reference}`
      : `Invoice data could not be loaded. Please try again. Reference: ${reference}`;
    return <InvoiceClient invoices={[]} convertibleQuotes={[]} loadError={loadError} />;
  }
  const invoices = visibleFor(user, allInvoices);
  const leads = visibleFor(user, allLeads);
  const leadsById = new Map(leads.map((lead) => [lead.id, lead]));
  const existingQuoteIds = new Set(allInvoices.map((invoice) => invoice.quoteId));
  const convertibleQuotes = visibleFor(user, allQuotes)
    .filter((quote) => !existingQuoteIds.has(quote.id) && canConvertToInvoice(quote, leadsById.get(quote.leadId) ?? null))
    .map((quote) => ({
      id: quote.id,
      offerNo: quote.offerNo,
      customer: quote.customer,
      leadId: quote.leadId,
      status: quote.status ?? "",
      total: quote.total,
    }));

  return <InvoiceClient invoices={invoices} convertibleQuotes={convertibleQuotes} loadError={loadError} />;
}