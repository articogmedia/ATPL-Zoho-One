import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { canAccess, quotationGstBreakdown, type Lead, type Quotation, type User } from "@/lib/domain";
import { canConvertToInvoice, canViewInvoice, invoiceSnapshot } from "@/lib/invoice-rules";
import { financialYear } from "@/lib/invoice-number";

const lead: Lead = {
  id: "lead-1",
  name: "Customer",
  company: "Customer Ltd",
  phone: "9999999999",
  area: "Hyderabad",
  source: "Direct Call",
  status: "Won",
  assignedTo: "Pavan",
  assignedToId: "exec-1",
  ownerId: "exec-1",
  remarks: "",
  createdOn: "2026-04-01",
  address: "",
  touchedBy: [],
};
const quote: Quotation = {
  id: "quote-1",
  offerNo: "301/26-27",
  leadId: "lead-1",
  customer: "Customer Ltd",
  contactName: "Customer",
  company: "Customer Ltd",
  phone: lead.phone,
  executive: "Pavan",
  ownerId: "exec-1",
  total: 118,
  date: "2026-04-01",
  items: [{ productId: "product-1", model: "Unit", unit: "Nos", qty: 1, price: 100 }],
};
const manager: User = { id: "manager-1", name: "Manager", role: "Manager" };

describe("invoice conversion rules", () => {
  it("uses Indian financial-year boundaries", () => {
    expect(financialYear(new Date("2026-03-31T17:59:00Z"))).toBe("25-26");
    expect(financialYear(new Date("2026-03-31T18:30:00Z"))).toBe("26-27");
  });

  it("only allows Won leads or accepted/Won quotations", () => {
    expect(canConvertToInvoice(quote, lead)).toBe(true);
    expect(canConvertToInvoice({ ...quote, status: "Accepted" }, { ...lead, status: "Contacted" })).toBe(true);
    expect(canConvertToInvoice({ ...quote, status: "Draft" }, { ...lead, status: "Contacted" })).toBe(false);
    expect(canConvertToInvoice(quote, null)).toBe(false);
  });

  it("preserves line GST, extra charges, totals, and legacy defaults", () => {
    const breakdown = quotationGstBreakdown(
      [{ productId: "p1", model: "Unit", unit: "Nos", qty: 1, price: 100, taxRate: 0.05 }],
      [{ label: "Freight", amount: 10, taxRate: 0.12 }],
    );
    const saved: Quotation = {
      ...quote,
      total: breakdown.total,
      items: [{ productId: "p1", model: "Unit", unit: "Nos", qty: 1, price: 100, taxRate: 0.05 }],
      gstBreakdown: breakdown,
    };
    const invoice = invoiceSnapshot(saved, lead, "INV/26-27/0001", manager, "36ABCDE1234F1Z5", "2026-04-02");
    expect(invoice.gstin).toBe("36ABCDE1234F1Z5");
    expect(invoice.items[0]?.taxRate).toBe(0.05);
    expect(invoice.gstBreakdown.gstByRate).toEqual([
      { rate: 0.05, taxableAmount: 100, amount: 5 },
      { rate: 0.12, taxableAmount: 10, amount: 1.2 },
    ]);
    expect(invoice.total).toBe(116.2);

    const legacy = invoiceSnapshot({ ...quote, items: quote.items?.map((item) => ({ ...item, taxRate: undefined })) }, lead, "INV/26-27/0002", manager, "", "2026-04-02");
    expect(legacy.items[0]?.taxRate).toBe(0.18);
    expect(legacy.total).toBe(118);
  });

  it("limits executive invoice access to their own records", () => {
    const invoice = invoiceSnapshot(quote, lead, "INV/26-27/0001", manager, "", "2026-04-02");
    expect(canAccess("Manager", "invoices")).toBe(true);
    expect(canAccess("Sales Executive", "invoices")).toBe(true);
    expect(canAccess("Calling Team", "invoices")).toBe(false);
    expect(canViewInvoice({ id: "exec-1", name: "Pavan", role: "Sales Executive" }, invoice)).toBe(true);
    expect(canViewInvoice({ id: "exec-2", name: "Sai Kiran", role: "Sales Executive" }, invoice)).toBe(false);
    expect(canViewInvoice(manager, invoice)).toBe(true);
  });
});