import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { renderInvoicePdf, sanitizeInvoicePdfText } from "@/lib/invoice-pdf";
import type { Invoice } from "@/lib/domain";

const invoice: Invoice = {
  id: "invoice-1",
  invoiceNo: "INV/26-27/0001",
  quoteId: "quote-1",
  leadId: "lead-1",
  ownerId: "exec-1",
  executive: "Executive",
  customer: "Customer",
  contactName: "Customer",
  company: "Customer Ltd",
  email: "customer@example.com",
  phone: "9999999999",
  date: "2026-04-02",
  status: "Created",
  total: 118,
  items: [{
    productId: "product-1",
    model: "Pump\nModel 😀",
    description: "Heavy\tDuty",
    unit: "Nos",
    qty: 1,
    price: 100,
    taxRate: 0.18,
  }],
  gstBreakdown: {
    subtotal: 100,
    discount: 0,
    gst: 18,
    total: 118,
    rate: 0.18,
    partA: { subtotal: 100, discount: 0, gst: 18, total: 118 },
    partB: { subtotal: 0, discount: 0, gst: 0, total: 0 },
  },
};

describe("invoice PDF text encoding", () => {
  it("replaces line breaks and tabs and removes characters Helvetica cannot encode", async () => {
    const document = await PDFDocument.create();
    const helvetica = await document.embedFont(StandardFonts.Helvetica);

    expect(sanitizeInvoicePdfText("Pump\nModel\t€ 😀", helvetica)).toBe("Pump Model € ");
  });

  it("renders product text containing line breaks, tabs, and unsupported characters", async () => {
    const bytes = await renderInvoicePdf(invoice);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
