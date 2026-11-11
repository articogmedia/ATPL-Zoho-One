"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Download, ExternalLink, ReceiptText } from "lucide-react";
import { convertQuoteToInvoiceAction, sendInvoiceEmailAction } from "@/app/actions/crm";
import { EmptyState, PageHeader, StatusBadge } from "@/components/ui-bits";
import { formatINR, type Invoice } from "@/lib/domain";

type ConvertibleQuote = {
  id: string;
  offerNo: string;
  customer: string;
  leadId: string;
  status: string;
  total: number;
};

export function InvoiceClient({ invoices, convertibleQuotes, loadError }: { invoices: Invoice[]; convertibleQuotes: ConvertibleQuote[]; loadError?: string }) {
  const [gstins, setGstins] = useState<Record<string, string>>({});
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  // Show a newly created invoice immediately; the server cache refreshes in the background.
  const [created, setCreated] = useState<Invoice[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  const serverIds = new Set(invoices.map((invoice) => invoice.id));
  const shownInvoices = [...created.filter((invoice) => !serverIds.has(invoice.id)), ...invoices];
  const invoicedQuoteIds = new Set(shownInvoices.map((invoice) => invoice.quoteId));
  const shownQuotes = convertibleQuotes.filter((quote) => !invoicedQuoteIds.has(quote.id));

  const convert = (quoteId: string) => startTransition(async () => {
    setMessage("");
    const result = await convertQuoteToInvoiceAction({ quoteId, gstin: gstins[quoteId] ?? "" });
    if (result.ok && result.data) {
      setCreated((current) => [result.data as Invoice, ...current]);
      setMessage(`Invoice ${result.data.invoiceNo} created.`);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => router.refresh(), 1500);
    } else if (!result.ok) {
      setMessage(result.error);
    }
  });

  const emailInvoice = (invoiceId: string) => startTransition(async () => {
    setMessage("");
    const invoice = invoices.find((item) => item.id === invoiceId);
    const result = await sendInvoiceEmailAction({ invoiceId, to: emails[invoiceId] ?? invoice?.email ?? "" });
    setMessage(result.ok ? "Invoice email sent." : result.error);
  });

  return <section className="space-y-6">
    <PageHeader title="Invoices" subtitle="Convert accepted or Won quotations, then view, download, or email the invoice." />
    {loadError && <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">{loadError}</p>}
    {message && <p role="status" className="rounded-lg border bg-card p-3 text-sm">{message}</p>}

    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Saved invoices ({shownInvoices.length})</h2>
      {!loadError && shownInvoices.length === 0 && <EmptyState icon={<ReceiptText className="h-5 w-5" />} message="No invoices have been created yet." />}
      {shownInvoices.map((invoice) => (
        <details key={invoice.id} className="group rounded-xl border bg-card p-4">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words font-semibold">{invoice.invoiceNo} · {invoice.customer}</p>
                <p className="mt-1 text-sm text-muted-foreground">{invoice.date} · <StatusBadge status={invoice.status} /></p>
              </div>
              <p className="font-semibold">{formatINR(invoice.total)}</p>
            </div>
            <ChevronDown aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-4 space-y-3 border-t pt-4">
            <p className="text-sm">Quotation: {invoice.quoteId} · Customer GSTIN: {invoice.gstin || "Not provided"}</p>
            <ul className="space-y-1 text-sm">
              {invoice.items.map((item, index) => (
                <li key={`${invoice.id}-${index}`} className="flex justify-between gap-3">
                  <span className="min-w-0 break-words">{item.model} · {item.qty} {item.unit} · GST {((item.taxRate ?? 0.18) * 100).toFixed(2)}%</span>
                  <span>{formatINR(item.qty * item.price - (item.discount ?? 0))}</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <a className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted sm:flex-none" href={`/api/invoices/${encodeURIComponent(invoice.id)}/pdf?inline=1`} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" />View PDF</a>
              <a className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted sm:flex-none" href={`/api/invoices/${encodeURIComponent(invoice.id)}/pdf?download=1`}><Download className="h-4 w-4" />Download PDF</a>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                type="email"
                aria-label={`Email recipient for ${invoice.invoiceNo}`}
                placeholder="Recipient email"
                value={emails[invoice.id] ?? invoice.email ?? ""}
                onChange={(event) => setEmails((current) => ({ ...current, [invoice.id]: event.target.value }))}
                className="min-h-11 min-w-0 flex-1 basis-48 rounded-md border bg-background px-3 text-base sm:text-sm"
              />
              <button type="button" disabled={pending} onClick={() => emailInvoice(invoice.id)} className="min-h-11 w-full rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:w-auto">{pending ? "Working…" : "Email invoice"}</button>
            </div>
          </div>
        </details>
      ))}
    </div>

    {shownQuotes.length > 0 && <div className="space-y-3">
      <h2 className="text-lg font-semibold">Accepted / Won quotations</h2>
      {shownQuotes.map((quote) => (
        <div key={quote.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <p className="break-words font-semibold">{quote.offerNo} · {quote.customer}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><StatusBadge status={quote.status || "Won lead"} />{formatINR(quote.total)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              aria-label={`Customer GSTIN for ${quote.offerNo}`}
              placeholder="Customer GSTIN (optional)"
              value={gstins[quote.id] ?? ""}
              onChange={(event) => setGstins((current) => ({ ...current, [quote.id]: event.target.value.toUpperCase() }))}
              maxLength={15}
              autoCapitalize="characters"
              className="min-h-11 min-w-0 flex-1 basis-48 rounded-md border bg-background px-3 text-base sm:text-sm md:w-56 md:flex-none"
            />
            <button type="button" disabled={pending} onClick={() => convert(quote.id)} className="min-h-11 w-full rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:w-auto">{pending ? "Working…" : "Convert to Invoice"}</button>
          </div>
        </div>
      ))}
    </div>}
  </section>;
}