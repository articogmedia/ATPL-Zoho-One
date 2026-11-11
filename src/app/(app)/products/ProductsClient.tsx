"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { Package, Plus, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { createProductAction, refreshProductsAction } from "@/app/actions/crm";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader, fieldClass } from "@/components/ui-bits";
import { formatINR, type Product } from "@/lib/domain";

export function ProductsClient({ initialProducts }: { initialProducts: Product[] }) {
  const [products, setProducts] = useState(initialProducts);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [unit, setUnit] = useState("Nos");
  const [price, setPrice] = useState("");
  const [gstRate, setGstRate] = useState("18");
  const [pending, startTransition] = useTransition();
  const filtered = useMemo(() => products.filter((product) => [product.model, product.code ?? "", product.description ?? ""].some((value) => value.toLowerCase().includes(search.trim().toLowerCase()))), [products, search]);

  function addProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await createProductAction({ name, code, unit, price: Number(price), gstRate: Number(gstRate) / 100 });
      if (!result.ok || !result.data) { toast.error(result.ok ? "Product could not be created." : result.error); return; }
      setProducts((current) => [...current, result.data as Product].sort((a, b) => a.model.localeCompare(b.model)));
      setName(""); setCode(""); setUnit("Nos"); setPrice(""); setGstRate("18"); setShowForm(false);
      toast.success("Product added to the catalogue.");
    });
  }

  function refresh() {
    startTransition(async () => {
      const result = await refreshProductsAction();
      if (!result.ok) { toast.error(result.error); return; }
      setProducts(result.data ?? []);
      toast.success("Product catalogue refreshed from Zoho CRM.");
    });
  }

  return <section className="space-y-6">
    <PageHeader title="Product catalogue" subtitle="A single, searchable catalogue of approved products, units, GST rates and quotation prices." />
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl border bg-card p-4"><p className="text-sm text-muted-foreground">Total products</p><p className="mt-1 text-2xl font-semibold tabular-nums">{products.length}</p></div>
      <div className="rounded-xl border bg-card p-4"><p className="text-sm text-muted-foreground">Search results</p><p className="mt-1 text-2xl font-semibold tabular-nums">{filtered.length}</p></div>
      <div className="rounded-xl border bg-card p-4"><p className="text-sm text-muted-foreground">Source of truth</p><p className="mt-1 text-lg font-semibold">Zoho CRM</p></div>
    </div>
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center">
      <label className="relative min-w-0 flex-1"><span className="sr-only">Search products</span><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by product name, code or description" className={`${fieldClass} pl-9`} /></label>
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={refresh} disabled={pending}><RefreshCw className={`h-4 w-4 ${pending ? "animate-spin" : ""}`} />Refresh from Zoho</Button><Button type="button" onClick={() => setShowForm((value) => !value)}><Plus className="h-4 w-4" />Add product</Button></div>
    </div>
    {showForm && <form onSubmit={addProduct} className="grid gap-3 rounded-xl border border-primary/20 bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="sm:col-span-2 lg:col-span-3"><h2 className="font-semibold">Add a catalogue product</h2><p className="mt-1 text-sm text-muted-foreground">New products are saved to Zoho CRM and become available in quotation creation.</p></div>
      <label className="text-sm font-medium">Product name<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} className={`${fieldClass} mt-1`} placeholder="e.g. Daikin VRV Indoor Unit" /></label>
      <label className="text-sm font-medium">Product code<input required maxLength={60} value={code} onChange={(event) => setCode(event.target.value)} className={`${fieldClass} mt-1`} placeholder="e.g. FXFQ50" /></label>
      <label className="text-sm font-medium">Unit<input required maxLength={40} value={unit} onChange={(event) => setUnit(event.target.value)} className={`${fieldClass} mt-1`} placeholder="Nos / Set / Sq.ft" /></label>
      <label className="text-sm font-medium">Unit price (₹)<input required type="number" min="0.01" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} className={`${fieldClass} mt-1`} placeholder="0.00" /></label>
      <label className="text-sm font-medium">GST rate<select value={gstRate} onChange={(event) => setGstRate(event.target.value)} className={`${fieldClass} mt-1`}><option value="0">0%</option><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="28">28%</option></select></label>
      <div className="flex items-end gap-2"><Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save product"}</Button><Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button></div>
    </form>}
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3"><div><h2 className="font-semibold">All products</h2><p className="text-sm text-muted-foreground">Approved catalogue items and current quotation rates</p></div><Package className="h-5 w-5 text-muted-foreground" /></div>
      {filtered.length === 0 ? <div className="p-8"><EmptyState icon={<Package className="h-5 w-5" />} message={products.length ? "No products match your search." : "No products are available in Zoho CRM yet."} /></div> : <>
        <div className="hidden grid-cols-[minmax(0,2fr)_minmax(100px,1fr)_90px_120px_90px] gap-3 bg-muted/60 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:grid"><span>Product</span><span>Code</span><span>Unit</span><span className="text-right">Price</span><span className="text-right">GST</span></div>
        <ul className="divide-y">{filtered.map((product) => <li key={product.id} className="grid gap-2 px-4 py-4 md:grid-cols-[minmax(0,2fr)_minmax(100px,1fr)_90px_120px_90px] md:items-center md:gap-3"><div className="min-w-0"><p className="truncate font-medium">{product.model}</p>{product.description && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{product.description}</p>}</div><p className="text-sm text-muted-foreground md:truncate">{product.code || "—"}</p><p className="text-sm text-muted-foreground">{product.unit}</p><p className="font-semibold tabular-nums md:text-right">{formatINR(product.price)}</p><p className="text-sm text-muted-foreground md:text-right">{((product.gstRate ?? 0.18) * 100).toFixed(0)}%</p></li>)}</ul>
      </>}
    </div>
  </section>;
}
