import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { nextOfferNo, todayIST, visibleFor } from "@/lib/domain";
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
  let products: Product[] = [];
  let productError = "";
  try {
    products = await repo.listProducts();
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
      <h1 className="mb-5 text-2xl font-bold">Create Quotation</h1>
      {productError && (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {productError}
        </div>
      )}
      <QuotationsClient
        leads={visibleFor(user, leads)}
        products={products}
        quotes={visibleFor(user, quotes)}
        suggestedOfferNo={nextOfferNo(quotes.map((q) => q.offerNo), todayIST())}
        presetLeadId={lead ?? ""}
      />
    </>
  );
}
