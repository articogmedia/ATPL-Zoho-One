import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { crm } from "@/lib/crm";
import { uniqueProducts } from "@/lib/domain";
import { PageHeader } from "@/components/ui-bits";
import { ProductsClient } from "./ProductsClient";

export const metadata = { title: "Products" };
export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";

export default async function ProductsPage() {
  const user = await requireUser();
  if (user.role !== "Manager") redirect("/home");

  try {
    const products = uniqueProducts(await crm().listProducts());
    return <ProductsClient initialProducts={products} />;
  } catch (error) {
    console.error("[page] products load failed", { message: error instanceof Error ? error.message : String(error) });
    return <section className="space-y-5"><PageHeader title="Product catalogue" subtitle="Manage the approved products and pricing used when preparing quotations." /><div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">Products could not be loaded from Zoho CRM. Check the Products module permissions and try again.</div></section>;
  }
}
