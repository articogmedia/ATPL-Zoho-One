"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Image from "next/image";
import { ArrowLeft, Check, ChevronDown, Eye, History, Minus, Plus, Printer, Search, Trash2, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";
import { StatusBadge, fieldClass } from "@/components/ui-bits";
import { addLeadAction, createQuoteAction, getQuoteDetailAction } from "@/app/actions/crm";
import { COMPANY, OFFER_TEXT, offerSubject } from "@/lib/company";
import { splitQuotationItems } from "@/lib/quotation-presentation";
import { LEAD_SOURCES, formatINR, quoteTotals, validateQuoteLine, type Lead, type LeadSource, type LeadStatus, type Product, type Quotation } from "@/lib/domain";

type Row = { productId: string; qty: number; discount: number };
type DuplicateCustomer = { id: string; name: string; owner: string; status: string };
type Props = { leads: Lead[]; products: Product[]; quotes: Quotation[]; suggestedOfferNo: string; presetLeadId: string; presetLeadError?: string };

export function QuotationsClient({ leads, products, quotes, suggestedOfferNo, presetLeadId, presetLeadError }: Props) {
  const [created, setCreated] = useState<Lead[]>([]);
  const myLeads = useMemo(() => [...created.filter((c) => !leads.some((l) => l.id === c.id)), ...leads], [created, leads]);
  const [q, setQ] = useState("");
  const [leadId, setLeadId] = useState(String(presetLeadId).trim());
  const [adding, setAdding] = useState(false);
  const [nl, setNl] = useState({ name: "", company: "", phone: "", area: "", source: "Direct Call" as LeadSource });
  const [duplicateCustomer, setDuplicateCustomer] = useState<DuplicateCustomer | null>(null);
  const [rows, setRows] = useState<Row[]>([{ productId: "", qty: 1, discount: 0 }]);
  const [offerNo, setOfferNo] = useState(suggestedOfferNo);
  const [preview, setPreview] = useState(false);
  const [pending, start] = useTransition();
  const [savedQuotes, setSavedQuotes] = useState(quotes);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedSearch, setSavedSearch] = useState("");
  const [loadingQuoteId, setLoadingQuoteId] = useState<string | null>(null);
  const [readOnlyQuote, setReadOnlyQuote] = useState<Quotation | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const savedSearchRef = useRef<HTMLInputElement>(null);
  const savedButtonRef = useRef<HTMLButtonElement>(null);
  const previousPreview = useRef(false);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const items = rows.flatMap((r) => { const p = byId.get(r.productId); return p ? [{ productId: p.id, model: p.model, description: p.description, unit: p.unit, price: p.price, qty: r.qty, discount: r.discount }] : []; });
  const t = quoteTotals(items);
  const lead = myLeads.find((l) => String(l.id).trim() === String(leadId).trim());
  const validLineCount = rows.filter((row) => {
    const product = byId.get(row.productId);
    return !!product && validateQuoteLine(row.qty, row.discount, product.price) === null;
  }).length;
  const productsValid = items.length > 0 && validLineCount === items.length;
  const upd = (i: number, p: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));

  useEffect(() => {
    if (preview) {
      window.scrollTo({ top: 0, behavior: "instant" });
      requestAnimationFrame(() => document.getElementById("offer-heading")?.focus({ preventScroll: true }));
    } else if (previousPreview.current) {
      requestAnimationFrame(() => document.getElementById("quote-step-products")?.scrollIntoView({ behavior: "instant", block: "start" }));
    }
    previousPreview.current = preview;
  }, [preview]);

  useEffect(() => {
    if (!savedOpen) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    savedSearchRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSavedOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [savedOpen]);

  useEffect(() => {
    if (readOnlyQuote) {
      requestAnimationFrame(() => document.getElementById("offer-heading")?.focus({ preventScroll: true }));
    }
  }, [readOnlyQuote]);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return myLeads.filter((l) => !s || [l.name, l.company, l.phone, l.area].some((f) => f.toLowerCase().includes(s))).slice(0, 6);
  }, [q, myLeads]);

  const focusProducts = () => {
    requestAnimationFrame(() => {
      const section = document.getElementById("quote-step-products");
      section?.scrollIntoView({ behavior: "smooth", block: "start" });
      requestAnimationFrame(() => {
        Array.from(document.querySelectorAll<HTMLButtonElement>('#quote-step-products button[aria-label="Item 1 product"]'))
          .find((button) => button.getClientRects().length > 0)
          ?.focus({ preventScroll: true });
      });
    });
  };

  useEffect(() => {
    const normalizedPresetId = String(presetLeadId).trim();
    if (normalizedPresetId && String(leadId).trim() === normalizedPresetId && lead) focusProducts();
  }, [presetLeadId, leadId, lead]);

  const selectDuplicateCustomer = (duplicate: DuplicateCustomer) => {
    const existing = leads.find((item) => item.id === duplicate.id) ?? created.find((item) => item.id === duplicate.id);
    if (!existing) {
      const customer: Lead = {
        id: duplicate.id,
        name: duplicate.name,
        company: "",
        phone: nl.phone.replace(/\D/g, "").slice(-10),
        area: nl.area,
        source: nl.source,
        status: duplicate.status as LeadStatus,
        assignedTo: duplicate.owner === "Unassigned" ? null : duplicate.owner,
        ownerId: undefined,
        remarks: "",
        createdOn: "",
        address: "",
        touchedBy: [],
      };
      setCreated((current) => [customer, ...current.filter((item) => item.id !== customer.id)]);
    }
    setLeadId(duplicate.id);
    setDuplicateCustomer(null);
    setAdding(false);
    focusProducts();
  };

  const saveNewLead = () => start(async () => {
    const res = await addLeadAction({ ...nl, remarks: "Added from Create Quotation" });
    if (res.ok && res.data) {
      setCreated((current) => [res.data!, ...current.filter((item) => item.id !== res.data!.id)]);
      setLeadId(res.data.id);
      setAdding(false);
      setDuplicateCustomer(null);
      setNl({ name: "", company: "", phone: "", area: "", source: "Direct Call" });
      toast.success("Customer added and selected");
      focusProducts();
    } else if (!res.ok && res.duplicate) {
      setDuplicateCustomer(res.duplicate);
    } else if (!res.ok) {
      toast.error(res.error);
    }
  });

  const save = () => start(async () => {
    if (!lead) return;
    const selectedRows = rows.filter((row) => row.productId && byId.has(row.productId) &&
      validateQuoteLine(row.qty, row.discount, byId.get(row.productId)!.price) === null);
    const res = await createQuoteAction({ offerNo, leadId: lead.id, items: selectedRows });
    if (!res.ok) { toast.error(res.error); return; }
    if (!res.data) { toast.error("Quotation was saved but could not be loaded."); return; }
    const savedItems = selectedRows.flatMap((row) => {
      const product = byId.get(row.productId);
      return product ? [{
        productId: product.id,
        model: product.model,
        description: product.description,
        unit: product.unit,
        qty: row.qty,
        price: product.price,
        discount: Math.min(product.price * row.qty, Math.max(0, row.discount)),
      }] : [];
    });
    const saved = { ...res.data, items: savedItems };
    setSavedQuotes((current) => [saved, ...current.filter((quote) => quote.id !== saved.id)]);
    setPreview(false);
    setSavedOpen(true);
    toast.success("Quotation saved");
  });

  const viewSavedQuote = async (quoteId: string) => {
    if (loadingQuoteId) return;
    setLoadingQuoteId(quoteId);
    try {
      const result = await getQuoteDetailAction(quoteId);
      if (!result.ok || !result.data) {
        toast.error(result.ok ? "Could not load quotation details." : result.error);
        return;
      }
      setReadOnlyQuote(result.data);
      setSavedOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load quotation details.");
    } finally {
      setLoadingQuoteId(null);
    }
  };

  const savedMatches = [...savedQuotes]
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter((quote) => `${quote.offerNo} ${quote.customer}`.toLowerCase().includes(savedSearch.trim().toLowerCase()));

  if (readOnlyQuote) {
    const savedLead = myLeads.find((item) => item.id === readOnlyQuote.leadId) ?? {
      id: readOnlyQuote.leadId,
      name: readOnlyQuote.customer,
      company: "",
      phone: "",
      area: "",
      address: "",
      source: "Direct Call" as LeadSource,
      status: "Quotation Sent" as const,
      assignedTo: readOnlyQuote.executive,
      ownerId: readOnlyQuote.ownerId,
      remarks: "",
      createdOn: readOnlyQuote.date,
      touchedBy: [],
    };
    return <Offer
      lead={savedLead}
      offerNo={readOnlyQuote.offerNo}
      setOfferNo={() => undefined}
      items={readOnlyQuote.items ?? []}
      onBack={() => setReadOnlyQuote(null)}
      onSave={() => undefined}
      saving={false}
      readOnly
      customer={readOnlyQuote.customer}
      offerDate={readOnlyQuote.date}
      status={readOnlyQuote.status ?? "Draft"}
    />;
  }

  if (preview && lead) {
    return <Offer lead={lead} offerNo={offerNo} setOfferNo={setOfferNo} items={items} onBack={() => setPreview(false)} onSave={save} saving={pending} />;
  }

  const setQty = (i: number, v: string) => upd(i, { qty: Math.min(10000, Math.max(1, Math.floor(Number(v)) || 1)) });
  const remove = (i: number) => setRows(rows.filter((_, j) => j !== i));
  const scrollToStep = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const currentStep = !lead ? 0 : productsValid ? 2 : 1;

  return (
    <div className={`space-y-6 ${lead && productsValid ? "pb-[calc(8rem+env(safe-area-inset-bottom))] sm:pb-6" : "pb-6"}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">Create Quotation</h1>
        <Button ref={savedButtonRef} variant="outline" className="h-11 w-full sm:w-auto" onClick={() => setSavedOpen(true)}>
          <History className="h-4 w-4" /> Saved quotations ({savedQuotes.length})
        </Button>
      </div>
      <nav aria-label="Quotation progress" className="grid grid-cols-3 gap-2 rounded-xl border border-border bg-card p-2">
        {["Customer", "Products", "Preview"].map((label, index) => {
          const completed = index === 0 ? !!lead : index === 1 ? productsValid : preview;
          const disabled = index === 1 ? !lead : index === 2 ? !lead || !productsValid : false;
          const active = index === currentStep && !preview;
          const selectStep = () => {
            if (index === 0) scrollToStep("quote-step-customer");
            if (index === 1) scrollToStep("quote-step-products");
            if (index === 2) setPreview(true);
          };
          return <button type="button" key={label} disabled={disabled} onClick={selectStep} className={`flex min-h-11 cursor-pointer items-center justify-center gap-1 rounded-lg px-2 py-2 text-center text-xs font-semibold transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${active ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`} aria-current={active ? "step" : undefined}>{completed && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}<span>{index + 1}. {label}</span></button>;
        })}
      </nav>
      <section id="quote-step-customer" className="scroll-mt-20 space-y-3 rounded-xl bg-card p-4 shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold">Step 1 · Choose customer</h2>
        {lead ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-secondary p-3 text-secondary-foreground">
            <div><div className="font-semibold">{lead.company || lead.name}</div><div className="text-sm">{lead.name} · {lead.phone} · {lead.area}</div></div>
            <Button variant="outline" onClick={() => setLeadId("")}>Change</Button>
          </div>
        ) : adding ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <input className={fieldClass} placeholder="Contact name *" value={nl.name} onChange={(e) => setNl({ ...nl, name: e.target.value })} />
            <input className={fieldClass} placeholder="Company" value={nl.company} onChange={(e) => setNl({ ...nl, company: e.target.value })} />
            <input className={fieldClass} placeholder="Mobile number *" inputMode="tel" value={nl.phone} onChange={(e) => setNl({ ...nl, phone: e.target.value })} />
            <input className={fieldClass} placeholder="Area" value={nl.area} onChange={(e) => setNl({ ...nl, area: e.target.value })} />
            <SelectField value={nl.source} onValueChange={(value) => setNl({ ...nl, source: value as LeadSource })} options={LEAD_SOURCES.map((source) => ({ value: source, label: source }))} />
            {duplicateCustomer && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm sm:col-span-2">
              <p><span className="font-semibold">{duplicateCustomer.name}</span> already exists. Owner: {duplicateCustomer.owner}.</p>
              <Button type="button" variant="outline" className="mt-2" onClick={() => selectDuplicateCustomer(duplicateCustomer)}>Use this customer</Button>
            </div>}
            <div className="flex gap-2">
              <Button className="flex-1" onClick={saveNewLead} disabled={pending || !nl.name.trim() || !nl.phone.trim()}>Add customer</Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <>
            {presetLeadError && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{presetLeadError}</div>}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-3.5 h-5 w-5 text-muted-foreground" />
                <input className={`${fieldClass} pl-10`} placeholder="Search name, company, mobile, area" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <Button variant="outline" onClick={() => setAdding(true)}><UserPlus className="h-5 w-5" /><span className="hidden sm:inline">New customer</span></Button>
            </div>
            <ul className="divide-y rounded-lg border">
              {matches.map((l) => (
                <li key={l.id}>
                  <button className="w-full p-3 text-left hover:bg-secondary" onClick={() => setLeadId(String(l.id).trim())}>
                    <div className="font-medium">{l.company || l.name}</div>
                    <div className="text-sm text-muted-foreground">{l.name} · {l.phone} · {l.area}</div>
                  </button>
                </li>
              ))}
              {!matches.length && <li className="p-3 text-sm text-muted-foreground">No matching customer. Add a new one.</li>}
            </ul>
          </>
        )}
      </section>

      <section id="quote-step-products" className={`scroll-mt-20 space-y-4 rounded-xl bg-card p-4 shadow-sm sm:p-6 ${!lead ? "hidden sm:block" : ""}`}>
        <h2 className="text-lg font-semibold">Step 2 · Products</h2>
        {!lead && <p className="text-sm text-muted-foreground">Choose a customer in Step 1 before adding products.</p>}
        {products.length === 0 && <p className="text-sm text-destructive">No products found in Zoho CRM</p>}
        <div className="hidden overflow-x-auto lg:block">
          <table className="w-full text-sm">
            <thead className="bg-secondary text-left text-secondary-foreground">
              <tr><th className="w-12 p-2">S.No</th><th className="p-2">Product</th><th className="w-20 p-2">Unit</th><th className="w-28 p-2">Qty</th><th className="w-32 p-2 text-right">Rate</th><th className="w-36 p-2 text-right">Discount</th><th className="w-36 p-2 text-right">Amount</th><th className="w-12" /></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => { const p = byId.get(r.productId); return (
                <tr key={i} className="border-b">
                  <td className="p-2">{i + 1}</td>
                  <td className="p-2"><ProductPicker products={products} value={r.productId} onChange={(productId) => upd(i, { productId })} label={`Item ${i + 1} product`} />{!p && <p className="mt-1 text-xs text-muted-foreground">Select a product</p>}</td>
                  <td className="p-2">{p?.unit}</td>
                  <td className="p-2"><input aria-label="Quantity" type="number" min={1} className={fieldClass} value={r.qty} onChange={(e) => setQty(i, e.target.value)} /></td>
                  <td className="p-2 text-right">{formatINR(p?.price ?? 0)}</td>
                  <td className="p-2"><input aria-label="Discount" type="number" min={0} className={fieldClass} value={r.discount} onChange={(e) => upd(i, { discount: Math.max(0, Number(e.target.value) || 0) })} /></td>
                  <td className="p-2 text-right font-semibold">{formatINR((p?.price ?? 0) * r.qty - r.discount)}</td>
                  <td className="p-2"><Button variant="ghost" size="icon" aria-label="Remove row" onClick={() => remove(i)}><Trash2 className="h-5 w-5" /></Button></td>
                </tr>); })}
            </tbody>
          </table>
        </div>
        <div className="space-y-3 lg:hidden">
          {rows.map((r, i) => { const p = byId.get(r.productId); return (
            <div key={i} className="space-y-3 rounded-xl border border-border bg-card p-3 shadow-sm">
              <div className="flex min-h-11 items-center justify-between"><span className="font-semibold">Item {i + 1}</span>
                <Button variant="ghost" size="icon" className="h-11 w-11" aria-label={`Remove item ${i + 1}`} onClick={() => remove(i)}><Trash2 className="h-5 w-5" /></Button></div>
              <ProductPicker products={products} value={r.productId} onChange={(productId) => upd(i, { productId })} label={`Item ${i + 1} product`} />
              {!p && <p className="text-sm text-muted-foreground">Select a product</p>}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Quantity ({p?.unit || "Unit"})</span><div className="grid grid-cols-[44px_1fr_44px]"><Button type="button" variant="outline" size="icon" className="h-11 w-11 rounded-r-none" aria-label={`Decrease quantity for item ${i + 1}`} onClick={() => setQty(i, String(Math.max(1, r.qty - 1)))}><Minus /></Button><input aria-label={`Quantity for item ${i + 1}`} type="number" min={1} inputMode="numeric" className={`${fieldClass} min-h-11 rounded-none text-center text-base`} value={r.qty} onChange={(e) => setQty(i, e.target.value)} /><Button type="button" variant="outline" size="icon" className="h-11 w-11 rounded-l-none" aria-label={`Increase quantity for item ${i + 1}`} onClick={() => setQty(i, String(r.qty + 1))}><Plus /></Button></div></label>
                <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Discount</span><input aria-label={`Discount for item ${i + 1}`} type="number" min={0} inputMode="numeric" className={`${fieldClass} min-h-11 text-base`} value={r.discount} onChange={(e) => upd(i, { discount: Math.max(0, Number(e.target.value) || 0) })} /></label>
              </div>
              <div className="text-sm"><span className="text-xs font-medium text-muted-foreground">Rate</span><div className="mt-1 min-h-11 rounded-lg border border-border bg-secondary px-3 py-2.5">{formatINR(p?.price ?? 0)}</div></div>
              {validateQuoteLine(r.qty, r.discount, p?.price ?? 0) && <p className="text-xs font-medium text-destructive">{validateQuoteLine(r.qty, r.discount, p?.price ?? 0)}</p>}
              <div className="text-right font-semibold"><span>Amount: </span>{r.discount > 0 && <span className="mr-2 text-sm text-muted-foreground">-{formatINR(r.discount)}</span>}<span>{formatINR(Math.max(0, (p?.price ?? 0) * r.qty - r.discount))}</span></div>
            </div>); })}
        </div>
        <Button variant="outline" size="lg" className="w-full border-dashed sm:w-auto" disabled={rows.length >= 50 || !products.length}
          onClick={() => setRows([...rows, { productId: "", qty: 1, discount: 0 }])}><Plus className="h-5 w-5" /> Add item</Button>
        <Totals t={t} />
        <div className={`fixed inset-x-0 bottom-16 z-20 border-t border-border bg-card p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] shadow-sm sm:hidden ${lead && productsValid ? "" : "hidden"}`}>
          <div className="mx-auto flex max-w-md items-center gap-3">
            <div className="min-w-0 flex-1"><div className="text-xs text-muted-foreground">Grand total</div><div className="truncate font-bold">{formatINR(t.total)}</div></div>
            <Button size="lg" className="shrink-0" disabled={!lead || !productsValid} onClick={() => setPreview(true)}>Preview</Button>
          </div>
        </div>
        <Button size="lg" className="hidden h-14 w-full text-base sm:flex" disabled={!lead || !productsValid} onClick={() => setPreview(true)}><Eye className="h-5 w-5" /> Preview Offer</Button>
        {!lead && <p className="text-center text-sm text-muted-foreground">Choose a customer first.</p>}
      </section>

      {savedOpen && <div className="fixed inset-0 z-50 bg-black/40" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setSavedOpen(false);
      }}>
        <section
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="saved-quotes-title"
          tabIndex={-1}
          className="fixed inset-x-0 bottom-0 flex h-[92dvh] max-h-[92dvh] flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl sm:inset-y-0 sm:right-0 sm:left-auto sm:h-full sm:max-h-full sm:w-full sm:max-w-lg sm:rounded-none"
        >
          <header className="flex min-h-16 shrink-0 items-center justify-between border-b border-border px-4">
            <h2 id="saved-quotes-title" className="text-lg font-semibold">Saved quotations</h2>
            <Button type="button" variant="ghost" size="icon" aria-label="Close saved quotations" onClick={() => setSavedOpen(false)}><X /></Button>
          </header>
          <div className="shrink-0 p-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
              <input
                ref={savedSearchRef}
                className={`${fieldClass} pl-10`}
                type="search"
                placeholder="Search offer number or customer"
                value={savedSearch}
                onChange={(event) => setSavedSearch(event.target.value)}
                aria-label="Search saved quotations"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 pt-0">
            {!savedQuotes.length ? <p className="text-sm text-muted-foreground">No quotations yet.</p>
              : !savedMatches.length ? <p className="text-sm text-muted-foreground">No matches</p>
              : savedMatches.map((quote) => (
                <article key={quote.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{quote.customer}</div>
                      <div className="mt-1 text-sm text-muted-foreground">Offer {quote.offerNo} · {quote.date}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-semibold">{formatINR(quote.total)}</div>
                      <StatusBadge status={quote.status ?? "Draft"} />
                    </div>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button type="button" size="sm" variant="outline" className="h-10" disabled={loadingQuoteId !== null} onClick={() => void viewSavedQuote(quote.id)}>
                      {loadingQuoteId === quote.id ? "Loading…" : "View"}
                    </Button>
                  </div>
                </article>
              ))}
          </div>
        </section>
      </div>}
    </div>
  );
}

function ProductPicker({ products, value, onChange, label }: { products: Product[]; value: string; onChange: (value: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = products.find((product) => product.id === value);
  const normalizedQuery = query.trim().toLowerCase();
  const matches = products.filter((product) =>
    `${product.model} ${product.code ?? ""} ${product.description ?? ""}`.toLowerCase().includes(normalizedQuery),
  );

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const trigger = triggerRef.current;
    document.body.style.overflow = "hidden";
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        onClick={() => { setQuery(""); setOpen(true); }}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-input bg-background px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0">
          {selected ? <><span className="block truncate font-medium">{selected.model}</span><span className="block text-xs text-muted-foreground">{formatINR(selected.price)}</span></> : <span className="text-muted-foreground">Select product</span>}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      {open && <div
        className="fixed inset-0 z-[60] flex items-end bg-black/40 md:items-center md:justify-center md:p-4"
        onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
      >
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="product-picker-title"
          className="flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl md:max-w-lg md:rounded-2xl"
        >
          <header className="flex min-h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <h2 id="product-picker-title" className="font-semibold">Choose product</h2>
            <Button type="button" variant="ghost" size="icon" className="h-11 w-11" aria-label="Close product picker" onClick={() => setOpen(false)}><X /></Button>
          </header>
          <div className="shrink-0 p-4 pb-2">
            <label htmlFor={`product-search-${label.replace(/\W/g, "-")}`} className="sr-only">Search products by name, code or description</label>
            <input
              ref={searchRef}
              id={`product-search-${label.replace(/\W/g, "-")}`}
              className={`${fieldClass} min-h-11 text-base`}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, code or description"
            />
            <p className="mt-2 text-xs text-muted-foreground">{matches.length} {matches.length === 1 ? "product" : "products"}</p>
          </div>
          <div className="min-h-0 max-h-[60dvh] flex-1 overflow-y-auto overscroll-contain px-4 pb-4" role="listbox" aria-label="Products">
            {matches.map((product) => (
              <button
                key={product.id}
                type="button"
                role="option"
                aria-selected={product.id === value}
                onClick={() => { onChange(product.id); setOpen(false); }}
                className={`min-h-16 w-full border-b border-border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${product.id === value ? "bg-secondary text-secondary-foreground" : "hover:bg-secondary/60"}`}
              >
                <span className="block break-words text-sm font-medium">{product.model}</span>
                <span className="block text-xs text-muted-foreground">{product.unit} · {formatINR(product.price)}</span>
              </button>
            ))}
            {!matches.length && <p className="p-4 text-sm text-muted-foreground">No products found</p>}
          </div>
        </section>
      </div>}
    </>
  );
}

function Totals({ t }: { t: { subtotal: number; discount: number; gst: number; total: number } }) {
  return (
    <dl className="ml-auto max-w-sm space-y-1 rounded-lg bg-secondary p-4 text-secondary-foreground">
      <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatINR(t.subtotal)}</dd></div>
      <div className="flex justify-between"><dt>Discount</dt><dd>-{formatINR(t.discount)}</dd></div>
      <div className="flex justify-between"><dt>Tax</dt><dd>{formatINR(t.gst)}</dd></div>
      <div className="flex justify-between text-lg font-bold"><dt>Grand Total</dt><dd>{formatINR(t.total)}</dd></div>
    </dl>
  );
}

type Item = { productId?: string; model: string; description?: string; unit: string; qty: number; price: number; discount?: number };

function Offer({ lead, offerNo, setOfferNo, items, onBack, onSave, saving, readOnly = false, customer: savedCustomer, offerDate, status = "Draft" }: {
  lead: Lead; offerNo: string; setOfferNo: (s: string) => void; items: Item[]; onBack: () => void; onSave: () => void; saving: boolean;
  readOnly?: boolean; customer?: string; offerDate?: string; status?: string;
}) {
  const t = quoteTotals(items);
  const [subject, setSubject] = useState(() => offerSubject(items.map((item) => item.model)));
  const customer = savedCustomer ?? (lead.company || lead.name);
  const parts = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "2-digit" }).formatToParts(new Date());
  const datePart = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const savedDateParts = offerDate?.split("-");
  const date = savedDateParts?.length === 3
    ? `${savedDateParts[2]}.${savedDateParts[1]}.${savedDateParts[0]?.slice(-2)}`
    : `${datePart("day")}.${datePart("month")}.${datePart("year")}`;
  const hasDiscount = items.some((item) => (item.discount ?? 0) > 0);
  const splitParts = splitQuotationItems(items);
  const basicAmount = (item: Item) => item.qty * item.price;
  const lineAmount = (item: Item) => basicAmount(item) - (item.discount ?? 0);
  const validTillDate = new Date(offerDate ? `${offerDate}T12:00:00Z` : Date.now());
  validTillDate.setDate(validTillDate.getDate() + 30);
  const validTill = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(validTillDate);
  const renderPart = (part: Item[], title: string, gst: string, startIndex = 0) => (
    <section className="mt-4">
      <div className="border-y border-border py-2 text-center font-bold">{title}</div>
      <table className="w-full border-collapse text-[9px]">
        <thead><tr>{["S.No", "Description", "Unit", "Qty", ...(hasDiscount ? ["Discount (Rs)"] : []), "Basic Rate (Rs)", "Amount (Rs)"].map((heading) => <th key={heading} className="border border-border px-1 py-2">{heading}</th>)}</tr></thead>
        <tbody>{part.map((item, index) => (
          <tr key={`${item.model}-${index}`} className="border border-border">
            <td className="border border-border px-1 py-2 text-center">{startIndex + index + 1}</td>
            <td className="border border-border px-1 py-2"><span className="font-semibold">{item.model}</span>{item.description && <div className="mt-1 break-words text-muted-foreground">{item.description}</div>}</td>
            <td className="border border-border px-1 py-2 text-center">{item.unit}</td>
            <td className="border border-border px-1 py-2 text-center">{item.qty}</td>
            {hasDiscount && <td className="border border-border px-1 py-2 text-right">{formatINR(item.discount ?? 0)}</td>}
            <td className="border border-border px-1 py-2 text-right">{formatINR(item.price)}</td>
            <td className="border border-border px-1 py-2 text-right">{formatINR(lineAmount(item))}</td>
          </tr>
        ))}</tbody>
      </table>
      <div className="mt-1 grid grid-cols-2 border border-border p-2 font-semibold"><span>Basic Sub Total - {title.includes("PART A") ? "Part A" : "Part B"}</span><span className="text-right">{formatINR(quoteTotals(part).total)}</span></div>
      <div className="mt-1 text-center text-[10px] font-semibold">{gst}</div>
    </section>
  );
  const shortMessage = `Dear Sir, please find our offer ${offerNo} for ${customer}. - ${COMPANY.name}`;
  const wa = `https://wa.me/91${lead.phone.replace(/\D/g, "").slice(-10)}?text=${encodeURIComponent(shortMessage)}`;
  const [downloading, setDownloading] = useState(false);
  const buildPdfFile = async (): Promise<File> => {
    const response = await fetch("/api/quotations/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leadId: lead.id,
        offerNo,
        subject,
        items: items.map((item) => ({ productId: item.productId, qty: item.qty, discount: item.discount ?? 0 })),
      }),
    });
    if (!response.ok) throw new Error("Unable to create the PDF.");
    const blob = new Blob([await response.blob()], { type: "application/pdf" });
    return new File([blob], `offer-${offerNo.replace("/", "-")}.pdf`, { type: "application/pdf" });
  };
  const downloadFile = (file: File) => {
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const downloadPdf = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      downloadFile(await buildPdfFile());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to create the PDF.");
    } finally {
      setDownloading(false);
    }
  };
  const shareOnWhatsApp = async () => {
    if (downloading) return;
    const whatsappWindow = window.open("about:blank", "_blank");
    setDownloading(true);
    try {
      const file = await buildPdfFile();
      if (navigator.canShare?.({ files: [file] })) {
        whatsappWindow?.close();
        await navigator.share({ files: [file], title: file.name, text: shortMessage });
        return;
      }
      downloadFile(file);
      if (whatsappWindow) whatsappWindow.location.href = wa;
      else window.open(wa, "_blank", "noopener,noreferrer");
      toast.info("PDF downloaded. Attach it in the WhatsApp chat (paperclip, Document).");
    } catch (error) {
      whatsappWindow?.close();
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error(error instanceof Error ? error.message : "Unable to create the PDF.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4 pb-[calc(8rem+env(safe-area-inset-bottom))] sm:pb-6">
      <div className="no-print grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Button variant="outline" className="w-full sm:w-auto" onClick={onBack}><ArrowLeft className="h-5 w-5" /> {readOnly ? "Back to Create Quotation" : "Edit"}</Button>
        <Button className="h-12 w-full sm:w-auto" onClick={downloadPdf} disabled={downloading}><Printer className="h-5 w-5" /> {downloading ? "Preparing…" : "Download PDF"}</Button>
        <Button variant="outline" className="h-12 w-full bg-white text-slate-900 hover:bg-slate-50 hover:text-slate-900 sm:w-auto" onClick={shareOnWhatsApp} disabled={downloading}><WhatsAppIcon className="h-5 w-5" /> {downloading ? "Preparing…" : "WhatsApp"}</Button>
        {!readOnly && <Button variant="outline" className="w-full sm:w-auto" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save Quotation"}</Button>}
      </div>
      <article className="print-area offer-document mx-auto max-w-full overflow-hidden rounded-xl bg-card p-3 text-[11px] leading-snug shadow-sm sm:max-w-3xl sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-300 pb-4">
          <Image src="/brand/atpl-logo.png" alt="Air Trendz" width={150} height={60} sizes="150px" className="h-auto max-w-full object-contain" priority />
          <div className="max-w-full text-right">
            <div className="text-lg font-bold">Air Trendz Pvt. Ltd.</div>
            <div className="mt-1 text-[10px]">{COMPANY.address}</div>
            <div className="text-[10px]">{COMPANY.contact}</div>
            <div className="mt-1 text-[10px] font-semibold">GSTIN - {COMPANY.gstin}</div>
          </div>
        </header>
        <div className="grid grid-cols-1 gap-4 py-4 sm:grid-cols-2">
          <div className="offer-no-break space-y-1 border-slate-300 sm:border-r sm:pr-4">
            <h1 id="offer-heading" tabIndex={-1} className="text-base font-bold outline-none">OFFER</h1>
            <label className="grid grid-cols-[70px_1fr] items-center gap-2"><span className="font-semibold">Offer Ref</span>
              {readOnly ? <span className="font-medium">{offerNo}</span> : <input aria-label="Offer reference" className="h-8 rounded-lg border border-input px-2 font-medium" pattern="\d{1,4}/\d{2}-\d{2}" value={offerNo} onChange={(event) => setOfferNo(event.target.value)} maxLength={9} />}
            </label>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Stage</span><span>{status}</span></div>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Valid Till</span><span>{validTill}</span></div>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Date</span><span>{date}</span></div>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Sales Person</span><span>{COMPANY.signatory}</span></div>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Amount</span><span>{formatINR(t.subtotal)}</span></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="offer-no-break">
              <div className="font-bold">Bill To</div>
              <div className="mt-1">{lead.company || lead.name}</div>
              <div>{lead.address || lead.area || ""}</div>
            </div>
            <div className="offer-no-break">
              <div className="font-bold">Ship To</div>
              <div className="mt-1">{lead.company || lead.name}</div>
              <div>{lead.address || lead.area || ""}</div>
            </div>
          </div>
        </div>

        <section>
          <p>Dear Sir,</p>
          <div className="mt-2 flex items-baseline gap-1 font-semibold">
            <span>Sub:</span>
            {readOnly ? <span>{subject}</span> : <input
                aria-label="Quotation subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 font-semibold outline-none print:border-0 print:outline-none"
              />}
          </div>
          <p className="mt-2 text-justify">{OFFER_TEXT.enquiry}</p>
        </section>

        <section className="mt-4 grid grid-cols-[1fr_auto] gap-2 border border-border p-3">
          <div><span className="font-bold">EQUIPMENT REQUIRED</span>{items.filter((item) => !/^B\s*-\s*/i.test(item.model)).map((item) => <div key={item.model}>{item.model} / {item.qty} / {item.unit}</div>)}</div>
          <div className="font-bold">Total Units: {items.reduce((sum, item) => sum + item.qty, 0)}</div>
        </section>
        <div className="max-w-full overflow-x-auto">
          {renderPart(splitParts.equipment, OFFER_TEXT.partA, OFFER_TEXT.partAGst)}
          {splitParts.ancillary.length > 0 && renderPart(splitParts.ancillary, OFFER_TEXT.partB, OFFER_TEXT.partBGst, splitParts.equipment.length)}
        </div>
        <div className="mt-3 grid grid-cols-2 border border-border p-2 font-bold"><span>TOTAL PART A + B</span><span className="text-right">{formatINR(t.total)}</span></div>

        <div className="offer-no-break mt-4 grid grid-cols-1 gap-8 sm:grid-cols-2">
          <div>
            <div className="font-bold">Authority Signature</div>
            <div className="mt-5">for {COMPANY.name}</div>
            <div>{COMPANY.signatory}</div>
            <div>{COMPANY.phones}</div>
          </div>
          <div className="text-right">
            <div className="grid grid-cols-[1fr_auto] gap-6 py-1"><span>Sub Total</span><span>{formatINR(t.subtotal)}</span></div>
            <div className="grid grid-cols-[1fr_auto] gap-6 py-1"><span>GST</span><span>{formatINR(0)}</span></div>
            <div className="mt-1 grid grid-cols-[1fr_auto] gap-6 bg-muted px-2 py-2 font-bold text-foreground"><span>Grand Total</span><span>{formatINR(t.subtotal)}</span></div>
          </div>
        </div>

        <section className="mt-4 space-y-2">
          <div className="offer-no-break"><span className="font-bold">NOTE</span><p>Quantities are tentative and final billing will be based on actual measurements.</p></div>
          <div className="offer-no-break"><div className="font-bold">ITEMS EXCLUDED</div><ol className="list-decimal pl-5"><li>Main incoming electrical cabling &amp; civil works such as core cutting, wall chipping in client scope</li><li>In case of Cat walk requirement for outdoor unit, the same shall be in client scope</li></ol></div>
          <div className="offer-no-break"><div className="font-bold">TERMS &amp; CONDITIONS</div>
            <dl className="grid grid-cols-[90px_1fr] gap-x-2">
              <dt>Validity</dt><dd>30 days</dd>
              <dt>Delivery</dt><dd>1-2 weeks from the date of order</dd>
              <dt>Payment Terms</dt><dd>100% advance for equipment; 60% advance for Part B and 40% on completion</dd>
            </dl>
          </div>
          <p>We hope our offer is in line with your requirement and look forward to receive your valued order.</p>
          <p>Thanking you and assuring you of our best attention at all times, we remain,</p>
        </section>
      </article>
    </div>
  );
}
