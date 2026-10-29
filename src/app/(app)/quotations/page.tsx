import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { nextOfferNo, todayIST, visibleFor } from "@/lib/domain";
import { QuotationsClient } from "./QuotationsClient";

export const metadata = { title: "Create Quotation" };
export const dynamic = "force-dynamic";

export default async function QuotationsPage({ searchParams }: { searchParams: Promise<{ lead?: string }> }) {
  const user = await requireSection("quotations");
  const { lead } = await searchParams;
  const repo = crm();
  const [leads, products, quotes] = await Promise.all([repo.listLeads(), repo.listProducts(), repo.listQuotes()]);

  return (
    <>
      <h1 className="mb-5 text-2xl font-bold">Create Quotation</h1>
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
