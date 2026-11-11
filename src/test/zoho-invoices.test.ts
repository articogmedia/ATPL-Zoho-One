import { describe, expect, it } from "vitest";
import { invoiceSnapshot } from "@/lib/invoice-rules";
import { mapZohoInvoice } from "@/lib/invoice-mappers";
import { FIELD } from "@/lib/zoho/fields";
import type { Lead, Quotation, User } from "@/lib/domain";

const user: User = { id: "exec-1", name: "Pavan", role: "Sales Executive" };
const lead: Lead = {
  id: "lead-1", name: "Customer", company: "Customer Ltd", phone: "9999999999", area: "",
  source: "Direct Call", status: "Won", assignedTo: "Pavan", ownerId: "exec-1",
  remarks: "", createdOn: "2026-04-01", address: "", touchedBy: [],
};
const quote: Quotation = {
  id: "quote-1", offerNo: "301/26-27", leadId: lead.id, customer: lead.company,
  executive: user.name, ownerId: user.id, total: 118, date: "2026-04-01",
  items: [{ productId: "product-1", model: "Unit", unit: "Nos", qty: 1, price: 100, taxRate: 0.18 }],
};

describe("Zoho invoice mapper", () => {
  it("maps a Zoho invoice snapshot and custom fields", () => {
    const invoice = invoiceSnapshot(quote, lead, "INV/26-27/0001", user, "36ABCDE1234F1Z5", "2026-04-02");
    const mapped = mapZohoInvoice({
      id: "zoho-invoice-1",
      [FIELD.invoice.invoiceNo]: invoice.invoiceNo,
      [FIELD.invoice.customerGstin]: invoice.gstin,
      [FIELD.invoice.sourceQuoteId]: invoice.quoteId,
      [FIELD.invoice.snapshot]: JSON.stringify(invoice),
    });
    expect(mapped).toMatchObject({
      id: "zoho-invoice-1",
      invoiceNo: invoice.invoiceNo,
      quoteId: "quote-1",
      gstin: "36ABCDE1234F1Z5",
      total: 118,
    });
  });

  it("fails explicitly for malformed CRM snapshots", () => {
    expect(() => mapZohoInvoice({ id: "bad", [FIELD.invoice.snapshot]: "{" })).toThrow(/malformed/);
    expect(() => mapZohoInvoice({ id: "missing", [FIELD.invoice.snapshot]: "{}" })).toThrow(/snapshot/);
  });
});