import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { nextOfferNo, todayIST, uniqueProducts, visibleFor } from "@/lib/domain";
import type { Lead, Product } from "@/lib/domain";
import { QuotationsClient } from "./QuotationsClient";
import { beginPagePerf, endPagePerf } from "@/lib/page-perf";
import { PageLoadError } from "@/components/PageLoadError";
import { withPageTimeout } from "@/lib/page-timeout";

export const metadata = { title: "Create Quotation" };
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function QuotationsPage({ searchParams }: { searchParams: Promise<{ lead?: string }> }) {
  const started = Date.now();
  const perf = beginPagePerf("quotations");
  const user = await requireSection("quotations");
  const { lead } = await searchParams;
  const repo = crm();
  const presetLeadId = String(lead ?? "").trim();
  let presetLeadError = "";
  let allLeads: Lead[];
  let quotePage;
  let products: Product[];
  let leadSources: Awaited<ReturnType<typeof repo.listLeadSources>> = [];
  let leadSourcesUnavailable = false;
  try {
    [allLeads, quotePage, products, leadSources] = await withPageTimeout(Promise.all([
      repo.listLeads(),
      repo.listQuotesPage(1),
      repo.listProducts(),
      repo.listLeadSources().catch((error: unknown) => {
        leadSourcesUnavailable = true;
        console.error("[page] quotation lead sources unavailable", {
          message: error instanceof Error ? error.message : String(error),
        });
        return [];
      }),
    ]));
  } catch (error) {
    console.error("[page] quotations data load failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    endPagePerf(perf);
    return <PageLoadError message="Quotation data is temporarily unavailable. Retry without leaving this page." />;
  }
  const quotes = quotePage.quotes;
  const visibleLeads = visibleFor(user, allLeads);
  const presetLead = visibleLeads.find((customer) => String(customer.id).trim() === presetLeadId);
  if (presetLeadId && (!presetLead || visibleFor(user, [presetLead]).length === 0)) {
    presetLeadError = "We couldn't find that customer. Please search for them.";
  }
  const recentCustomers = visibleLeads.slice(0, 100);
  const initialCustomerRows = presetLead && !recentCustomers.some((customer) => customer.id === presetLead.id)
    ? [...recentCustomers, presetLead]
    : recentCustomers;
  const initialCustomers = initialCustomerRows.map((customer) => ({
    id: customer.id,
    name: customer.name,
    company: customer.company,
    phone: customer.phone,
    area: customer.area,
    source: customer.source,
    status: customer.status,
    assignedTo: customer.assignedTo,
  }));
  products = uniqueProducts(products);
  console.info(`[page] quotations ${Date.now() - started}ms`);

  endPagePerf(perf);
  return (
    <>
      <QuotationsClient
        leads={initialCustomers}
        initialCustomersHasMore={visibleLeads.length > recentCustomers.length}
        leadSources={leadSources}
        leadSourcesUnavailable={leadSourcesUnavailable || leadSources.length === 0}
        products={products}
        quotes={visibleFor(user, quotes)}
        quotesHasMore={quotePage.hasMore}
        suggestedOfferNo={nextOfferNo(quotes.map((q) => q.offerNo), todayIST())}
        presetLeadId={presetLead && !presetLeadError ? String(presetLead.id).trim() : ""}
        presetLeadError={presetLeadError}
      />
    </>
  );
}
