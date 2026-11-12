import "server-only";
import { getCachedValue, invalidate, setCachedValue } from "@/lib/cache";

export type StoredQuotationPdf = { url: string; ownerId?: string; executive?: string };

const STORED_QUOTE_PDF_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const cacheKey = (quoteId: string) => `quotation-pdf:${quoteId}`;

export function getStoredQuotationPdf(quoteId: string) {
  return getCachedValue<StoredQuotationPdf>(cacheKey(quoteId)).catch((error: unknown) => {
    console.warn("[quotation-pdf] stored PDF lookup failed; treating as a cache miss", {
      quoteId,
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  });
}

export async function saveStoredQuotationPdf(quoteId: string, value: StoredQuotationPdf) {
  try {
    await setCachedValue(cacheKey(quoteId), STORED_QUOTE_PDF_TTL_MS, value, { keepStale: true });
  } catch (error) {
    console.warn("[quotation-pdf] stored PDF URL could not be cached", {
      quoteId,
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function invalidateStoredQuotationPdf(quoteId: string) {
  return invalidate(cacheKey(quoteId));
}
