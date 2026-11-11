import { z } from "zod";
import type { Invoice } from "@/lib/domain";
import { FIELD } from "@/lib/zoho/fields";

const invoiceSnapshotSchema = z.object({
  quoteId: z.string(),
  leadId: z.string(),
  ownerId: z.string().optional(),
  executive: z.string(),
  customer: z.string(),
  contactName: z.string(),
  company: z.string(),
  email: z.string().optional(),
  phone: z.string(),
  gstin: z.string().optional(),
  date: z.string(),
  status: z.string(),
  total: z.number(),
  items: z.array(z.object({
    productId: z.string().optional(),
    model: z.string(),
    description: z.string().optional(),
    unit: z.string(),
    qty: z.number(),
    price: z.number(),
    discount: z.number().optional(),
    taxRate: z.number().optional(),
  })),
  gstBreakdown: z.object({
    subtotal: z.number(),
    discount: z.number(),
    gst: z.number(),
    total: z.number(),
    rate: z.number(),
    partA: z.object({ subtotal: z.number(), discount: z.number(), gst: z.number(), total: z.number() }),
    partB: z.object({ subtotal: z.number(), discount: z.number(), gst: z.number(), total: z.number() }),
    gstByRate: z.array(z.object({ rate: z.number(), taxableAmount: z.number(), amount: z.number() })).optional(),
    extraCharges: z.array(z.object({ label: z.string(), amount: z.number(), taxRate: z.number().optional() })).optional(),
  }),
}).passthrough();

export type ZohoInvoiceRecord = {
  id: string | number;
  [key: string]: unknown;
};

export function mapZohoInvoice(record: ZohoInvoiceRecord): Invoice {
  let raw = record[FIELD.invoice.snapshot];
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Zoho invoice ${record.id} has malformed ${FIELD.invoice.snapshot} JSON.`, { cause: error });
    }
  }
  const parsed = invoiceSnapshotSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Zoho invoice ${record.id} has a missing or invalid ${FIELD.invoice.snapshot} snapshot.`);
  const data = parsed.data;
  return {
    ...data,
    id: String(record.id),
    invoiceNo: String(record[FIELD.invoice.invoiceNo] ?? ""),
    gstin: String(record[FIELD.invoice.customerGstin] ?? data.gstin ?? ""),
  };
}