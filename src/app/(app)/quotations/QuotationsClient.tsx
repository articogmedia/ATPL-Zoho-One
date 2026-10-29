"use client";

import { useMemo, useState, useTransition } from "react";
import { ArrowLeft, Eye, MessageCircle, Plus, Printer, Search, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui-bits";
import { addLeadAction, createQuoteAction } from "@/app/actions/crm";
import { COMPANY } from "@/lib/company";
import { LEAD_SOURCES, formatINR, quoteTotals, type Lead, type LeadSource, type Product, type Quotation } from "@/lib/domain";

type Row = { productId: string; qty: number };
type Props = { leads: Lead[]; products: Product[]; quotes: Quotation[]; suggestedOfferNo: string; presetLeadId: string };

export function QuotationsClient({ leads, products, quotes, suggestedOfferNo, presetLeadId }: Props) {
  const [created, setCreated] = useState<Lead[]>([]);
  const myLeads = useMemo(() => [...created.filter((c) => !leads.some((l) => l.id === c.id)), ...leads], [created, leads]);
  const [q, setQ] = useState("");
  const [leadId, setLeadId] = useState(presetLeadId);
  const [adding, setAdding] = useState(false);
  const [nl, setNl] = useState({ name: "", company: "", phone: "", area: "", source: "Direct Call" as LeadSource });
  const [rows, setRows] = useState<Row[]>([{ productId: products[0]?.id ?? "", qty: 1 }]);
  const [offerNo, setOfferNo] = useState(suggestedOfferNo);
  const [preview, setPreview] = useState(false);
  const [pending, start] = useTransition();

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const items = rows.flatMap((r) => { const p = byId.get(r.productId); return p ? [{ model: p.model, unit: p.unit, price: p.price, qty: r.qty }] : []; });
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
    if (res.ok) { toast.success("Quotation saved"); setRows([{ productId: products[0]?.id ?? "", qty: 1 }]); setPreview(false); } else toast.error(res.error);
  });

  if (preview && lead) {
    return <Offer lead={lead} offerNo={offerNo} setOfferNo={setOfferNo} items={items} onBack={() => setPreview(false)} onSave={save} saving={pending} />;
  }

  const productSelect = (r: Row, i: number) => (
    <select aria-label="Product" className={fieldClass} value={r.productId} onChange={(e) => upd(i, { productId: e.target.value })}>
      {products.map((m) => <option key={m.id} value={m.id}>{m.model}</option>)}
    </select>
  );
  const setQty = (i: number, v: string) => upd(i, { qty: Math.min(10000, Math.max(1, Math.floor(Number(v)) || 1)) });
  const remove = (i: number) => setRows(rows.filter((_, j) => j !== i));

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-xl bg-card p-4 shadow-sm sm:p-6">
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

      <section className="space-y-4 rounded-xl bg-card p-4 shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold">Step 2 · Products</h2>
        {products.length === 0 && <p className="text-sm text-destructive">No products found in the catalogue. Ask an administrator to add products in Zoho CRM.</p>}
        <div className="hidden overflow-x-auto lg:block">
          <table className="w-full text-sm">
            <thead className="bg-secondary text-left text-secondary-foreground">
              <tr><th className="w-12 p-2">S.No</th><th className="p-2">Product</th><th className="w-20 p-2">Unit</th><th className="w-28 p-2">Quantity</th><th className="w-32 p-2 text-right">Rate</th><th className="w-36 p-2 text-right">Amount</th><th className="w-12" /></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => { const p = byId.get(r.productId); return (
                <tr key={i} className="border-b">
                  <td className="p-2">{i + 1}</td>
                  <td className="p-2">{productSelect(r, i)}</td>
                  <td className="p-2">{p?.unit}</td>
                  <td className="p-2"><input aria-label="Quantity" type="number" min={1} className={fieldClass} value={r.qty} onChange={(e) => setQty(i, e.target.value)} /></td>
                  <td className="p-2 text-right">{formatINR(p?.price ?? 0)}</td>
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
              <div className="grid grid-cols-2 gap-2 text-sm">
                <label className="space-y-1"><span>Quantity ({p?.unit})</span><input type="number" min={1} inputMode="numeric" className={fieldClass} value={r.qty} onChange={(e) => setQty(i, e.target.value)} /></label>
                <div className="space-y-1"><span>Rate</span><div className="flex h-12 items-center">{formatINR(p?.price ?? 0)}</div></div>
              </div>
              <div className="flex justify-between font-semibold"><span>Amount</span><span>{formatINR((p?.price ?? 0) * r.qty)}</span></div>
            </div>); })}
        </div>
        <Button variant="outline" size="lg" className="h-12 w-full sm:w-auto" disabled={rows.length >= 50 || !products.length}
          onClick={() => setRows([...rows, { productId: products[0]!.id, qty: 1 }])}><Plus className="h-5 w-5" /> Add Row</Button>
        <Totals t={t} />
        <Button size="lg" className="h-14 w-full text-base" disabled={!lead || !items.length} onClick={() => setPreview(true)}><Eye className="h-5 w-5" /> Preview Offer</Button>
        {!lead && <p className="text-center text-sm text-muted-foreground">Choose a customer first.</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Saved quotations</h2>
        {quotes.length === 0 && <p className="text-sm text-muted-foreground">No quotations yet.</p>}
        {quotes.map((x) => (
          <div key={x.id} className="rounded-xl bg-card p-4 shadow-sm">
            <div className="flex justify-between gap-2"><span className="font-semibold">{x.customer}</span><span className="font-bold text-primary">{formatINR(x.total)}</span></div>
            <div className="text-sm text-muted-foreground">Offer {x.offerNo} · {x.date} · {x.executive}</div>
          </div>
        ))}
      </section>
    </div>
  );
}

function Totals({ t }: { t: { subtotal: number; gst: number; total: number } }) {
  return (
    <dl className="ml-auto max-w-sm space-y-1 rounded-lg bg-secondary p-4 text-secondary-foreground">
      <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatINR(t.subtotal)}</dd></div>
      <div className="flex justify-between"><dt>GST</dt><dd>{formatINR(t.gst)}</dd></div>
      <div className="flex justify-between text-lg font-bold"><dt>Grand Total</dt><dd>{formatINR(t.total)}</dd></div>
    </dl>
  );
}

type Item = { model: string; unit: string; qty: number; price: number };

function Offer({ lead, offerNo, setOfferNo, items, onBack, onSave, saving }: {
  lead: Lead; offerNo: string; setOfferNo: (s: string) => void; items: Item[]; onBack: () => void; onSave: () => void; saving: boolean;
}) {
  const t = quoteTotals(items);
  const customer = lead.company || lead.name;
  const date = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  const msg = [
    `Dear Sir, please find our offer ${offerNo} dated ${date} for ${customer}.`,
    `Sub: ${COMPANY.subject}`, "",
    ...items.map((it, i) => `${i + 1}. ${it.model} - ${it.qty} ${it.unit} x ${formatINR(it.price)} = ${formatINR(it.qty * it.price)}`),
    "", `Grand Total: ${formatINR(t.total)}`, "", `for ${COMPANY.name}, ${COMPANY.signatory}, ${COMPANY.phones}`,
  ].join("\n");
  const wa = `https://wa.me/91${lead.phone.replace(/\D/g, "").slice(-10)}?text=${encodeURIComponent(msg)}`;

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap gap-2">
        <Button variant="outline" className="h-12" onClick={onBack}><ArrowLeft className="h-5 w-5" /> Edit</Button>
        <Button className="h-12" onClick={() => window.print()}><Printer className="h-5 w-5" /> Download PDF</Button>
        <Button asChild variant="secondary" className="h-12"><a href={wa} target="_blank" rel="noreferrer"><MessageCircle className="h-5 w-5" /> Share on WhatsApp</a></Button>
        <Button variant="outline" className="h-12" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save Quotation"}</Button>
      </div>
      <article className="print-area mx-auto max-w-3xl space-y-4 rounded-xl bg-card p-5 text-sm shadow-sm sm:p-8">
        <h1 className="text-center text-2xl font-bold tracking-widest">OFFER</h1>
        <div className="flex flex-wrap justify-between gap-2">
          <label className="flex items-center gap-2"><span className="font-semibold">Offer No:</span>
            <input className="w-32 rounded border border-input bg-card px-2 py-1" value={offerNo} onChange={(e) => setOfferNo(e.target.value)} maxLength={30} /></label>
          <span><span className="font-semibold">Date:</span> {date}</span>
        </div>
        <div><div className="font-semibold">To,</div><div>{customer}</div>{lead.company && <div>Attn: {lead.name}</div>}<div>{[lead.address, lead.area].filter(Boolean).join(", ")}{lead.area ? ", Hyderabad" : ""}</div></div>
        <p>Dear Sir,</p>
        <p className="font-semibold">Sub: {COMPANY.subject}</p>
        <div className="overflow-x-auto">
          <table className="w-full border text-left">
            <thead className="bg-secondary"><tr><th className="border p-2">S.No</th><th className="border p-2">Product</th><th className="border p-2">Unit</th><th className="border p-2 text-right">Qty</th><th className="border p-2 text-right">Rate</th><th className="border p-2 text-right">Amount</th></tr></thead>
            <tbody>{items.map((it, i) => (
              <tr key={i}><td className="border p-2">{i + 1}</td><td className="border p-2">{it.model}</td><td className="border p-2">{it.unit}</td><td className="border p-2 text-right">{it.qty}</td><td className="border p-2 text-right">{formatINR(it.price)}</td><td className="border p-2 text-right">{formatINR(it.qty * it.price)}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <Totals t={t} />
        <p className="whitespace-pre-line">{COMPANY.terms.replace(/\. /g, ".\n")}</p>
        <div className="pt-6"><div>for {COMPANY.name}</div><div className="mt-8 font-semibold">{COMPANY.signatory}</div><div>{COMPANY.phones}</div></div>
      </article>
    </div>
  );
}
