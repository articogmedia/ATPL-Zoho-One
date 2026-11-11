import "server-only";
import { getCachedValue, invalidate, setCachedValue } from "@/lib/cache";

export type StoredInvoicePdf = { url: string; ownerId?: string; executive?: string };

const STORED_INVOICE_PDF_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const cacheKey = (invoiceId: string) => `invoice-pdf:${invoiceId}`;

export function getStoredInvoicePdf(invoiceId: string) {
  return getCachedValue<StoredInvoicePdf>(cacheKey(invoiceId));
}

export function saveStoredInvoicePdf(invoiceId: string, value: StoredInvoicePdf) {
  return setCachedValue(cacheKey(invoiceId), STORED_INVOICE_PDF_TTL_MS, value, { keepStale: true });
}

export function invalidateStoredInvoicePdf(invoiceId: string) {
  return invalidate(cacheKey(invoiceId));
}