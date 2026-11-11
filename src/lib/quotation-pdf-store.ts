import "server-only";
import { getCachedValue, invalidate, setCachedValue } from "@/lib/cache";

export type StoredQuotationPdf = { url: string; ownerId?: string; executive?: string };

const STORED_QUOTE_PDF_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const cacheKey = (quoteId: string) => `quotation-pdf:${quoteId}`;

export function getStoredQuotationPdf(quoteId: string) {
  return getCachedValue<StoredQuotationPdf>(cacheKey(quoteId));
}

export function saveStoredQuotationPdf(quoteId: string, value: StoredQuotationPdf) {
  return setCachedValue(cacheKey(quoteId), STORED_QUOTE_PDF_TTL_MS, value, { keepStale: true });
}

export function invalidateStoredQuotationPdf(quoteId: string) {
  return invalidate(cacheKey(quoteId));
}
