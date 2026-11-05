import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { nextOfferNo, todayIST, uniqueProducts, visibleFor } from "@/lib/domain";
import type { Product } from "@/lib/domain";
import { QuotationsClient } from "./QuotationsClient";

export const metadata = { title: "Create Quotation" };
export const dynamic = "force-dynamic";

export default async function QuotationsPage({ searchParams }: { searchParams: Promise<{ lead?: string }> }) {
  const started = Date.now();
  const user = await requireSection("quotations");
  const { lead } = await searchParams;
  const repo = crm();
  const [leads, quotes] = await Promise.all([repo.listLeads(), repo.listQuotes()]);
  const presetLeadId = String(lead ?? "").trim();
  let presetLeadError = "";
  let presetLead = presetLeadId
    ? leads.find((item) => String(item.id).trim() === presetLeadId)
    : undefined;
  if (presetLeadId && !presetLead) presetLead = await repo.getLead(presetLeadId) ?? undefined;
  if (presetLeadId && (!presetLead || visibleFor(user, [presetLead]).length === 0)) {
    presetLeadError = "We couldn't find that customer. Please search for them.";
  }
  const quotationLeads = visibleFor(user, presetLead ? [...leads, presetLead] : leads)
    .filter((item, index, list) => list.findIndex((candidate) => String(candidate.id).trim() === String(item.id).trim()) === index);
  let products: Product[] = [];
  let productError = "";
  try {
    products = uniqueProducts(await repo.listProducts());
  } catch (error) {
    console.error("[page] quotations products failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    productError = "Unable to load products. Please try again or contact your administrator.";
    products = [];
  }
  console.info(`[page] quotations ${Date.now() - started}ms`);

  return (
    <>
      {productError && (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {productError}
        </div>
      )}
      <QuotationsClient
        leads={quotationLeads}
        products={products}
        quotes={visibleFor(user, quotes)}
        suggestedOfferNo={nextOfferNo(quotes.map((q) => q.offerNo), todayIST())}
        presetLeadId={presetLead && !presetLeadError ? String(presetLead.id).trim() : ""}
        presetLeadError={presetLeadError}
      />
    </>
  );
}
