import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { canConvertToInvoice } from "@/lib/invoice-rules";
import { visibleFor } from "@/lib/domain";
import { withPageTimeout } from "@/lib/page-timeout";
import { describeLoadProblem } from "@/lib/zoho-setup-hint";
import { PageHeader } from "@/components/ui-bits";
import { LoadProblem } from "@/components/LoadProblem";
import { InvoiceClient } from "./InvoiceClient";
import { beginPagePerf, endPagePerf } from "@/lib/page-perf";

export const metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";

export default async function InvoicesPage() {
  const perf = beginPagePerf("invoices");
  const user = await requireSection("invoices");
  const repository = crm();
  let allInvoices: Awaited<ReturnType<typeof repository.listInvoices>>;
  let candidates: Awaited<ReturnType<typeof repository.listInvoiceCandidates>>;
  try {
    [allInvoices, candidates] = await withPageTimeout(Promise.all([
      repository.listInvoices(),
      repository.listInvoiceCandidates(),
    ]), 20_000);
  } catch (error) {
    const problem = describeLoadProblem(error, "Invoices");
    console.error("[page] invoices load failed", { message: error instanceof Error ? error.message : String(error), reference: problem.reference });
    endPagePerf(perf);
    return (
      <section className="space-y-6">
        <PageHeader title="Invoices" subtitle="Convert accepted or Won quotations, then view, download, or email the invoice." />
        <LoadProblem
          summary={problem.summary}
          hint={user.role === "Manager" ? problem.hint : "Please retry. If it keeps happening, contact your manager."}
          reference={problem.reference}
        />
      </section>
    );
  }

  const invoices = visibleFor(user, allInvoices);
  const leads = visibleFor(user, candidates.leads);
  const leadsById = new Map(leads.map((lead) => [lead.id, lead]));
  const existingQuoteIds = new Set(allInvoices.map((invoice) => invoice.quoteId));
  const convertibleQuotes = visibleFor(user, candidates.quotes)
    .filter((quote) => !existingQuoteIds.has(quote.id) && canConvertToInvoice(quote, leadsById.get(quote.leadId) ?? null))
    .map((quote) => ({
      id: quote.id,
      offerNo: quote.offerNo,
      customer: quote.customer,
      leadId: quote.leadId,
      status: quote.status ?? "",
      total: quote.total,
    }));

  endPagePerf(perf);
  return <InvoiceClient invoices={invoices} convertibleQuotes={convertibleQuotes} />;
}
