"use client";

import { useMemo, useState, useTransition } from "react";
import Image from "next/image";
import { ArrowLeft, Eye, MessageCircle, Plus, Printer, Search, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui-bits";
import { addLeadAction, createQuoteAction } from "@/app/actions/crm";
import { COMPANY, offerSubject } from "@/lib/company";
import { LEAD_SOURCES, formatINR, quoteTotals, type Lead, type LeadSource, type Product, type Quotation } from "@/lib/domain";

type Row = { productId: string; qty: number; discount: number };
type Props = { leads: Lead[]; products: Product[]; quotes: Quotation[]; suggestedOfferNo: string; presetLeadId: string };

export function QuotationsClient({ leads, products, quotes, suggestedOfferNo, presetLeadId }: Props) {
  const [created, setCreated] = useState<Lead[]>([]);
  const myLeads = useMemo(() => [...created.filter((c) => !leads.some((l) => l.id === c.id)), ...leads], [created, leads]);
  const [q, setQ] = useState("");
  const [leadId, setLeadId] = useState(presetLeadId);
  const [adding, setAdding] = useState(false);
  const [nl, setNl] = useState({ name: "", company: "", phone: "", area: "", source: "Direct Call" as LeadSource });
  const [rows, setRows] = useState<Row[]>([{ productId: products[0]?.id ?? "", qty: 1, discount: 0 }]);
  const [offerNo, setOfferNo] = useState(suggestedOfferNo);
  const [preview, setPreview] = useState(false);
  const [pending, start] = useTransition();

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const items = rows.flatMap((r) => { const p = byId.get(r.productId); return p ? [{ model: p.model, description: p.description, unit: p.unit, price: p.price, qty: r.qty, discount: r.discount }] : []; });
  const t = quoteTotals(items);
  const lead = myLeads.find((l) => l.id === leadId);
  const upd = (i: number, p: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return myLeads.filter((l) => !s || [l.name, l.company, l.phone, l.area].some((f) => f.toLowerCase().includes(s))).slice(0, 6);
  }, [q, myLeads]);

  const saveNewLead = () => start(async () => {
    const res = await addLeadAction({ ...nl, remarks: "Added from Create Quotation" });
    if (res.ok && res.data) { setCreated((c) => [res.data!, ...c]); setLeadId(res.data.id); setAdding(false); setNl({ name: "", company: "", phone: "", area: "", source: "Direct Call" }); }
    else if (!res.ok) toast.error(res.error);
  });

  const save = () => start(async () => {
    if (!lead) return;
    const res = await createQuoteAction({ offerNo, leadId: lead.id, items: rows });
    if (res.ok) { toast.success("Quotation saved"); } else toast.error(res.error);
  });

  if (preview && lead) {
    return <Offer lead={lead} offerNo={offerNo} setOfferNo={setOfferNo} items={items} onBack={() => setPreview(false)} onSave={save} saving={pending} />;
  }

  const productSelect = (r: Row, i: number) => (
    <select
      aria-label="Product"
      className={fieldClass}
      value={r.productId}
      onChange={(event) => upd(i, { productId: event.target.value })}
    >
      <option value="">Select product</option>
      {products.map((product) => (
        <option key={product.id} value={product.id}>
          {product.model} · {formatINR(product.price)}
        </option>
      ))}
    </select>
  );
  const setQty = (i: number, v: string) => upd(i, { qty: Math.min(10000, Math.max(1, Math.floor(Number(v)) || 1)) });
  const remove = (i: number) => setRows(rows.filter((_, j) => j !== i));
  const scrollToStep = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const currentStep = !lead ? 0 : items.length > 0 ? 1 : 1;

  return (
    <div className="space-y-6">
      <nav aria-label="Quotation progress" className="grid grid-cols-3 gap-2 rounded-xl border border-border bg-card p-2">
        {["Customer", "Products", "Preview"].map((label, index) => {
          const disabled = index === 1 ? !lead : index === 2 ? !lead || items.length === 0 : false;
          const active = index === currentStep && !preview;
          const selectStep = () => {
            if (index === 0) scrollToStep("quote-step-customer");
            if (index === 1) scrollToStep("quote-step-products");
            if (index === 2) setPreview(true);
          };
          return <button type="button" key={label} disabled={disabled} onClick={selectStep} className={`min-h-11 cursor-pointer rounded-lg px-2 py-2 text-center text-xs font-semibold transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${active ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`} aria-current={active ? "step" : undefined}>{index + 1}. {label}</button>;
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
            <select className={fieldClass} value={nl.source} onChange={(e) => setNl({ ...nl, source: e.target.value as LeadSource })}>
              {LEAD_SOURCES.map((s) => <option key={s}>{s}</option>)}
            </select>
            <div className="flex gap-2">
              <Button className="h-12 flex-1" onClick={saveNewLead} disabled={pending || !nl.name.trim() || !nl.phone.trim()}>Add customer</Button>
              <Button variant="ghost" className="h-12" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-3.5 h-5 w-5 text-muted-foreground" />
                <input className={`${fieldClass} pl-10`} placeholder="Search name, company, mobile, area" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <Button variant="outline" className="h-12" onClick={() => setAdding(true)}><UserPlus className="h-5 w-5" /><span className="hidden sm:inline">New customer</span></Button>
            </div>
            <ul className="divide-y rounded-lg border">
              {matches.map((l) => (
                <li key={l.id}>
                  <button className="w-full p-3 text-left hover:bg-secondary" onClick={() => setLeadId(l.id)}>
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

      <section id="quote-step-products" className="scroll-mt-20 space-y-4 rounded-xl bg-card p-4 shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold">Step 2 · Products</h2>
        {products.length === 0 && <p className="text-sm text-destructive">No products found in Zoho CRM</p>}
        <div className="hidden overflow-x-auto lg:block">
          <table className="w-full text-sm">
            <thead className="bg-secondary text-left text-secondary-foreground">
              <tr><th className="w-12 p-2">S.No</th><th className="p-2">Model</th><th className="w-20 p-2">Unit</th><th className="w-28 p-2">Qty</th><th className="w-32 p-2 text-right">Rate</th><th className="w-36 p-2 text-right">Amount</th><th className="w-12" /></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => { const p = byId.get(r.productId); return (
                <tr key={i} className="border-b">
                  <td className="p-2">{i + 1}</td>
                  <td className="p-2">{productSelect(r, i)}</td>
                  <td className="p-2">{p?.unit}</td>
                  <td className="p-2"><input aria-label="Quantity" type="number" min={1} className={fieldClass} value={r.qty} onChange={(e) => setQty(i, e.target.value)} /></td>
                  <td className="p-2 text-right">{formatINR(p?.price ?? 0)}</td>
                  <td className="p-2"><input aria-label="Discount" type="number" min={0} className={fieldClass} value={r.discount} onChange={(e) => upd(i, { discount: Math.max(0, Number(e.target.value) || 0) })} /></td>
                  <td className="p-2 text-right font-semibold">{formatINR((p?.price ?? 0) * r.qty)}</td>
                  <td className="p-2"><Button variant="ghost" size="icon" aria-label="Remove row" onClick={() => remove(i)}><Trash2 className="h-5 w-5" /></Button></td>
                </tr>); })}
            </tbody>
          </table>
        </div>
        <div className="space-y-3 lg:hidden">
          {rows.map((r, i) => { const p = byId.get(r.productId); return (
            <div key={i} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between"><span className="font-semibold">#{i + 1}</span>
                <Button variant="ghost" size="sm" onClick={() => remove(i)}><Trash2 className="h-4 w-4" /> Remove</Button></div>
              {productSelect(r, i)}
              <div className="grid grid-cols-3 gap-2 text-sm">
                <label className="space-y-1"><span>Quantity ({p?.unit})</span><input type="number" min={1} inputMode="numeric" className={fieldClass} value={r.qty} onChange={(e) => setQty(i, e.target.value)} /></label>
                <div className="space-y-1"><span>Rate</span><div className="flex h-12 items-center">{formatINR(p?.price ?? 0)}</div></div>
                <label className="space-y-1"><span>Discount</span><input type="number" min={0} className={fieldClass} value={r.discount} onChange={(e) => upd(i, { discount: Math.max(0, Number(e.target.value) || 0) })} /></label>
              </div>
              <div className="flex justify-between font-semibold"><span>Amount</span><span>{formatINR((p?.price ?? 0) * r.qty)}</span></div>
            </div>); })}
        </div>
        <Button variant="outline" size="lg" className="h-12 w-full sm:w-auto" disabled={rows.length >= 50 || !products.length}
          onClick={() => setRows([...rows, { productId: products[0]!.id, qty: 1, discount: 0 }])}><Plus className="h-5 w-5" /> Add Row</Button>
        <Totals t={t} />
        <div className="fixed inset-x-0 bottom-16 z-20 border-t bg-card p-3 shadow-[0_-8px_24px_rgba(15,23,42,.12)] sm:hidden">
          <div className="mx-auto flex max-w-md items-center gap-3">
            <div className="min-w-0 flex-1"><div className="text-xs text-muted-foreground">Grand total</div><div className="truncate font-bold">{formatINR(t.total)}</div></div>
            <Button size="lg" className="h-12 shrink-0 px-5" disabled={!lead || !items.length} onClick={() => setPreview(true)}>Preview</Button>
          </div>
        </div>
        <Button size="lg" className="hidden h-14 w-full text-base sm:flex" disabled={!lead || !items.length} onClick={() => setPreview(true)}><Eye className="h-5 w-5" /> Preview Offer</Button>
        {!lead && <p className="text-center text-sm text-muted-foreground">Choose a customer first.</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Saved quotations</h2>
        {quotes.length === 0 && <p className="text-sm text-muted-foreground">No quotations yet.</p>}
        {quotes.map((x) => (
          <div key={x.id} className="rounded-xl bg-card p-4 shadow-sm">
            <div className="flex justify-between gap-2"><span className="font-semibold">{x.customer}</span><span className="font-bold text-primary">{formatINR(x.total)}</span></div>
            <div className="text-sm text-muted-foreground">Offer {x.offerNo} · {x.date} · {x.executive} · Status: {x.status ?? "Draft"}</div>
          </div>
        ))}
      </section>
    </div>
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

type Item = { model: string; description?: string; unit: string; qty: number; price: number; discount?: number };

function Offer({ lead, offerNo, setOfferNo, items, onBack, onSave, saving }: {
  lead: Lead; offerNo: string; setOfferNo: (s: string) => void; items: Item[]; onBack: () => void; onSave: () => void; saving: boolean;
}) {
  const t = quoteTotals(items);
  const [subject, setSubject] = useState(() => offerSubject(items.map((item) => item.model)));
  const customer = lead.company || lead.name;
  const parts = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "2-digit" }).formatToParts(new Date());
  const datePart = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const date = `${datePart("day")}.${datePart("month")}.${datePart("year")}`;
  const hasDiscount = items.some((item) => (item.discount ?? 0) > 0);
  const basicAmount = (item: Item) => item.qty * item.price;
  const lineAmount = (item: Item) => basicAmount(item) - (item.discount ?? 0);
  const validTillDate = new Date();
  validTillDate.setDate(validTillDate.getDate() + 30);
  const validTill = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(validTillDate);
  const msg = [
    `Dear Sir, please find our offer ${offerNo} dated ${date} for ${customer}.`,
    `Sub: ${subject}`, "",
    ...items.map((it, i) => `${i + 1}. ${it.model} - ${it.qty} ${it.unit} x ${formatINR(it.price)} = ${formatINR(it.qty * it.price)}`),
    "", `Grand Total: ${formatINR(t.total)}`, "", `for ${COMPANY.name}, ${COMPANY.signatory}, ${COMPANY.phones}`,
  ].join("\n");
  const wa = `https://wa.me/91${lead.phone.replace(/\D/g, "").slice(-10)}?text=${encodeURIComponent(msg)}`;

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap gap-2">
        <Button variant="outline" className="h-12" onClick={onBack}><ArrowLeft className="h-5 w-5" /> Edit</Button>
        <Button className="h-12" onClick={() => window.print()}><Printer className="h-5 w-5" /> Print / PDF</Button>
        <Button asChild variant="secondary" className="h-12"><a href={wa} target="_blank" rel="noreferrer"><MessageCircle className="h-5 w-5" /> Share on WhatsApp</a></Button>
        <Button variant="outline" className="h-12" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save Quotation"}</Button>
      </div>
      <article className="print-area offer-document mx-auto max-w-3xl rounded-xl bg-card p-5 text-[11px] leading-snug shadow-sm sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-300 pb-4">
          <Image src="/brand/atpl-logo.png" alt="Air Trendz" width={150} height={60} className="h-auto w-36 object-contain" priority />
          <div className="text-right">
            <div className="text-lg font-bold">Air Trendz Pvt. Ltd.</div>
            <div className="mt-1 text-[10px]">{COMPANY.address}</div>
            <div className="text-[10px]">{COMPANY.contact}</div>
            <div className="mt-1 text-[10px] font-semibold">GSTIN - {COMPANY.gstin}</div>
          </div>
        </header>
        <div className="grid grid-cols-1 gap-4 py-4 sm:grid-cols-2">
          <div className="offer-no-break space-y-1 border-slate-300 sm:border-r sm:pr-4">
            <div className="text-base font-bold">OFFER</div>
            <label className="grid grid-cols-[70px_1fr] items-center gap-2"><span className="font-semibold">Offer Ref</span>
              <input aria-label="Offer reference" className="h-8 rounded border border-input px-2 font-medium" pattern="\d{1,4}/\d{2}-\d{2}" value={offerNo} onChange={(event) => setOfferNo(event.target.value)} maxLength={9} />
            </label>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Stage</span><span>Draft</span></div>
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
            <input
              aria-label="Quotation subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              className="min-w-0 flex-1 border-0 bg-transparent p-0 font-semibold outline-none print:border-0 print:outline-none"
            />
          </div>
          <p className="mt-2 text-justify">We thank you very much for your enquiry. We are pleased to submit herewith our offer. Our detailed Bill of quantities are as follows.</p>
        </section>

        <div className="overflow-x-auto">
        <table className="mt-4 min-w-[520px] w-full border-collapse text-[10px]">
          <thead><tr className="bg-[#4f94cd] text-white">
            <th className="px-2 py-2 text-left">Item &amp; Description</th>
            <th className="px-2 py-2 text-right">List Price</th>
            <th className="px-2 py-2 text-right">Qty</th>
            {hasDiscount && <th className="px-2 py-2 text-right">Discount</th>}
            <th className="px-2 py-2 text-right">Amount</th>
          </tr></thead>
          <tbody>{items.map((item, index) => (
            <tr key={`${item.model}-${index}`} className="border-b border-slate-300">
              <td className="px-2 py-2"><span className="font-semibold">{index + 1}. {item.model}</span>{item.description && <div className="mt-1 text-slate-600">{item.description}</div>}</td>
              <td className="px-2 py-2 text-right">{formatINR(item.price)}</td>
              <td className="px-2 py-2 text-right">{item.qty} {item.unit}</td>
              {hasDiscount && <td className="px-2 py-2 text-right">{formatINR(item.discount ?? 0)}</td>}
              <td className="px-2 py-2 text-right">{formatINR(lineAmount(item))}</td>
            </tr>
          ))}</tbody>
        </table>
        </div>

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
            <div className="mt-1 grid grid-cols-[1fr_auto] gap-6 bg-slate-500 px-2 py-2 font-bold text-white"><span>Grand Total</span><span>{formatINR(t.subtotal)}</span></div>
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
