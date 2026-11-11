import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { canConvertToInvoice } from "@/lib/invoice-rules";
import { visibleFor } from "@/lib/domain";
import { InvoiceClient } from "./InvoiceClient";

export const metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";

export default async function InvoicesPage() {
  const user = await requireSection("invoices");
  const repository = crm();
  const [allInvoices, allQuotes, allLeads] = await Promise.all([
    repository.listInvoices(),
    repository.listQuotes(),
    repository.listLeads(),
  ]);
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

  return <InvoiceClient invoices={invoices} convertibleQuotes={convertibleQuotes} />;
}