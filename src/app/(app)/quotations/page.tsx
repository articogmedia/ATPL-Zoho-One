import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { nextOfferNo, todayIST, uniqueProducts, visibleFor } from "@/lib/domain";
import type { Product } from "@/lib/domain";
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
  let loadedLead;
  let quotePage;
  let products: Product[];
  try {
    [loadedLead, quotePage, products] = await withPageTimeout(Promise.all([
      presetLeadId ? repo.getLead(presetLeadId) : Promise.resolve(null),
      repo.listQuotesPage(1),
      repo.listProducts(),
    ]));
  } catch (error) {
    console.error("[page] quotations data load failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    endPagePerf(perf);
    return <PageLoadError message="Quotation data is temporarily unavailable. Retry without leaving this page." />;
  }
  const quotes = quotePage.quotes;
  const presetLead = loadedLead ?? undefined;
  if (presetLeadId && (!presetLead || visibleFor(user, [presetLead]).length === 0)) {
    presetLeadError = "We couldn't find that customer. Please search for them.";
  }
  products = uniqueProducts(products);
  console.info(`[page] quotations ${Date.now() - started}ms`);

  endPagePerf(perf);
  return (
    <>
      <QuotationsClient
        leads={presetLead && !presetLeadError ? [presetLead] : []}
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
