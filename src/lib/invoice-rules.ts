import {
  GST_RATE,
  quotationGstBreakdown,
  type Invoice,
  type Lead,
  type Quotation,
  type User,
  visibleFor,
} from "@/lib/domain";

export function canConvertToInvoice(quote: Quotation, lead: Lead | null) {
  return Boolean(lead && (lead.status === "Won" || ["accepted", "won"].includes((quote.status ?? "").trim().toLowerCase())));
}

export function canViewInvoice(user: User, invoice: Invoice) {
  return visibleFor(user, [invoice]).length > 0;
}

export function invoiceSnapshot(
  quote: Quotation,
  lead: Lead,
  invoiceNo: string,
  actor: User,
  gstin: string,
  date: string,
): Invoice {
  const items = (quote.items ?? []).map((item) => ({
    ...item,
    taxRate: item.taxRate ?? GST_RATE,
  }));
  const breakdown = quote.gstBreakdown ?? quotationGstBreakdown(items);
  return {
    id: "",
    invoiceNo,
    quoteId: quote.id,
    leadId: lead.id,
    ownerId: quote.ownerId ?? actor.id,
    executive: quote.executive || actor.name,
    customer: quote.customer || lead.company || lead.name,
    contactName: quote.contactName || lead.name,
    company: quote.company || lead.company,
    email: quote.email || lead.email,
    phone: quote.phone || lead.phone,
    gstin,
    date,
    status: "Created",
    total: breakdown.total,
    items,
    gstBreakdown: breakdown,
  };
}