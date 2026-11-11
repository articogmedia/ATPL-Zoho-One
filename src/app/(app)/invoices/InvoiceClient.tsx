"use client";

import { useState, useTransition } from "react";
import { convertQuoteToInvoiceAction, sendInvoiceEmailAction } from "@/app/actions/crm";
import { formatINR, type Invoice } from "@/lib/domain";

type ConvertibleQuote = {
  id: string;
  offerNo: string;
  customer: string;
  leadId: string;
  status: string;
  total: number;
};

export function InvoiceClient({ invoices, convertibleQuotes }: { invoices: Invoice[]; convertibleQuotes: ConvertibleQuote[] }) {
  const [gstins, setGstins] = useState<Record<string, string>>({});
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  const convert = (quoteId: string) => startTransition(async () => {
    setMessage("");
    const result = await convertQuoteToInvoiceAction({ quoteId, gstin: gstins[quoteId] ?? "" });
    setMessage(result.ok ? `Invoice ${result.data?.invoiceNo} created.` : result.error);
  });

  const emailInvoice = (invoiceId: string) => startTransition(async () => {
    setMessage("");
    const invoice = invoices.find((item) => item.id === invoiceId);
    const result = await sendInvoiceEmailAction({ invoiceId, to: emails[invoiceId] ?? invoice?.email ?? "" });
    setMessage(result.ok ? "Invoice email sent." : result.error);
  });

  return <section className="space-y-6">
    <header>
      <h1 className="text-2xl font-bold">Invoices</h1>
      <p className="mt-1 text-sm text-muted-foreground">Convert accepted or Won quotations, then view, download, or email the invoice.</p>
    </header>
    {message && <p role="status" className="rounded-lg border bg-card p-3 text-sm">{message}</p>}

    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Saved invoices ({invoices.length})</h2>
      {invoices.length === 0 && <p className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">No invoices have been created yet.</p>}
      {invoices.map((invoice) => (
        <details key={invoice.id} className="rounded-xl border bg-card p-4">
          <summary className="cursor-pointer list-none">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">{invoice.invoiceNo} · {invoice.customer}</p>
                <p className="mt-1 text-sm text-muted-foreground">{invoice.date} · {invoice.status}</p>
              </div>
              <p className="font-semibold">{formatINR(invoice.total)}</p>
            </div>
          </summary>
          <div className="mt-4 space-y-3 border-t pt-4">
            <p className="text-sm">Quotation: {invoice.quoteId} · Customer GSTIN: {invoice.gstin || "Not provided"}</p>
            <ul className="space-y-1 text-sm">
              {invoice.items.map((item, index) => (
                <li key={`${invoice.id}-${index}`} className="flex justify-between gap-3">
                  <span>{item.model} · {item.qty} {item.unit} · GST {((item.taxRate ?? 0.18) * 100).toFixed(2)}%</span>
                  <span>{formatINR(item.qty * item.price - (item.discount ?? 0))}</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <a className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted" href={`/api/invoices/${encodeURIComponent(invoice.id)}/pdf?inline=1`} target="_blank" rel="noreferrer">View PDF</a>
              <a className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted" href={`/api/invoices/${encodeURIComponent(invoice.id)}/pdf?download=1`}>Download PDF</a>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                type="email"
                aria-label={`Email recipient for ${invoice.invoiceNo}`}
                placeholder="Recipient email"
                value={emails[invoice.id] ?? invoice.email ?? ""}
                onChange={(event) => setEmails((current) => ({ ...current, [invoice.id]: event.target.value }))}
                className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
              />
              <button type="button" disabled={pending} onClick={() => emailInvoice(invoice.id)} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Email invoice</button>
            </div>
          </div>
        </details>
      ))}
    </div>

    {convertibleQuotes.length > 0 && <div className="space-y-3">
      <h2 className="text-lg font-semibold">Accepted / Won quotations</h2>
      {convertibleQuotes.map((quote) => (
        <div key={quote.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="font-semibold">{quote.offerNo} · {quote.customer}</p>
            <p className="mt-1 text-sm text-muted-foreground">{quote.status || "Won lead"} · {formatINR(quote.total)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              aria-label={`Customer GSTIN for ${quote.offerNo}`}
              placeholder="Customer GSTIN (optional)"
              value={gstins[quote.id] ?? ""}
              onChange={(event) => setGstins((current) => ({ ...current, [quote.id]: event.target.value.toUpperCase() }))}
              className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm md:w-56"
            />
            <button type="button" disabled={pending} onClick={() => convert(quote.id)} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Convert to Invoice</button>
          </div>
        </div>
      ))}
    </div>}
  </section>;
}