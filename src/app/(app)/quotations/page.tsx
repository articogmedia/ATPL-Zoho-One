import { Suspense } from "react";
import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { uniqueProducts } from "@/lib/domain";
import type { Product, User } from "@/lib/domain";
import { QuotationsClient } from "./QuotationsClient";
import { beginPagePerf, endPagePerf } from "@/lib/page-perf";
import { PageLoadError } from "@/components/PageLoadError";
import { withPageTimeout } from "@/lib/page-timeout";

export const metadata = { title: "Create Quotation" };
export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";
export const maxDuration = 30;

function QuotationsShell() {
  return <section aria-label="Create quotation" className="space-y-6">
    <div className="flex items-center justify-between gap-3">
      <h1 className="text-2xl font-bold">Create Quotation</h1>
      <div className="h-11 w-40 animate-pulse rounded-lg bg-secondary" />
    </div>
    <div className="h-14 animate-pulse rounded-xl bg-secondary" />
    <div className="h-64 animate-pulse rounded-xl bg-secondary" />
  </section>;
}

async function QuotationsData({ user, presetLeadId }: { user: User; presetLeadId: string }) {
  const perf = beginPagePerf("quotations");
  const repo = crm();
  let customerPage: Awaited<ReturnType<NonNullable<typeof repo.listLeadsPage>>>;
  let presetLead: Awaited<ReturnType<typeof repo.getLead>> = null;
  let products: Product[];
  let suggestedOfferNo: string;
  let leadSources: Awaited<ReturnType<typeof repo.listLeadSources>> = [];
  let savedQuotesCount: number | undefined;
  let leadSourcesUnavailable = false;
  const savedQuotesCountPromise = repo.countQuotes
    ? repo.countQuotes(user.role === "Sales Executive" ? user.id : undefined).catch((error: unknown) => {
      console.error("[page] quotation count unavailable", {
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    })
    : Promise.resolve(undefined);
  try {
    [customerPage, products, leadSources, presetLead, savedQuotesCount, suggestedOfferNo] = await withPageTimeout(Promise.all([
      repo.listLeadsPage
        ? repo.listLeadsPage(1, 30, user.role === "Sales Executive" ? user.id : undefined)
        : repo.listLeads().then((rows) => ({ leads: rows.slice(0, 30), total: rows.length, hasMore: rows.length > 30 })),
      repo.listProducts(),
      repo.listLeadSources().catch((error: unknown) => {
        leadSourcesUnavailable = true;
        console.error("[page] quotation lead sources unavailable", {
          message: error instanceof Error ? error.message : String(error),
        });
        return [];
      }),
      presetLeadId ? repo.getLead(presetLeadId).catch((error: unknown) => {
        console.error("[page] preset quotation customer unavailable", {
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      }) : Promise.resolve(null),
      savedQuotesCountPromise,
      repo.suggestOfferNo(),
    ]));
  } catch (error) {
    console.error("[page] quotations data load failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    endPagePerf(perf);
    return <PageLoadError message="Quotation data is temporarily unavailable. Retry without leaving this page." />;
  }
  const visibleLeads = customerPage.leads;
  const visiblePresetLead = presetLead && (user.role !== "Sales Executive" ||
    String(presetLead.ownerId ?? presetLead.assignedToId ?? "") === user.id) ? presetLead : null;
  const presetLeadError = presetLeadId && !visiblePresetLead
    ? "We couldn't find that customer. Please search for them."
    : "";
  const initialCustomerRows = visiblePresetLead && !visibleLeads.some((customer) => customer.id === visiblePresetLead.id)
    ? [...visibleLeads, visiblePresetLead]
    : visibleLeads;
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
  console.info(`[page] quotations ${Date.now() - perf.startedAt}ms`);
  endPagePerf(perf);

  return <QuotationsClient
    leads={initialCustomers}
    initialSavedQuotesCount={savedQuotesCount}
    initialCustomersHasMore={customerPage.hasMore}
    leadSources={leadSources}
    leadSourcesUnavailable={leadSourcesUnavailable || leadSources.length === 0}
    products={uniqueProducts(products)}
    suggestedOfferNo={suggestedOfferNo}
    presetLeadId={presetLead && !presetLeadError ? String(presetLead.id).trim() : ""}
    presetLeadError={presetLeadError}
  />;
}

export default async function QuotationsPage({ searchParams }: { searchParams: Promise<{ lead?: string }> }) {
  const user = await requireSection("quotations");
  const { lead } = await searchParams;
  const presetLeadId = String(lead ?? "").trim();

  return <Suspense fallback={<QuotationsShell />}>
    <QuotationsData user={user} presetLeadId={presetLeadId} />
  </Suspense>;
}
