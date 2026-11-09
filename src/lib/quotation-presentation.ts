import { quoteTotals } from "@/lib/domain";

export function canCreateQuotationPdf(
  quotation: { offerNo: string; customer: string; leadId: string; items?: readonly { productId?: string }[] },
  savedQuote = false,
) {
  if (!quotation.offerNo.trim() || !quotation.items?.length) return false;
  if (savedQuote) return true;
  return !!quotation.customer.trim() && !!quotation.leadId.trim() &&
    quotation.items.every((item) => !!item.productId);
}

export type QuotationPresentationItem = {
  model: string;
  description?: string;
  unit: string;
  qty: number;
  price: number;
  discount?: number;
};

export function splitQuotationItems(items: readonly QuotationPresentationItem[]) {
  const ancillary = items.filter((item) => /^B\s*-\s*/i.test(item.model.trim()));
  const equipment = items.filter((item) => !/^B\s*-\s*/i.test(item.model.trim()));
  return {
    equipment: equipment.map((item) => ({ ...item })),
    ancillary: ancillary.map((item) => ({ ...item, model: item.model.trim().replace(/^B\s*-\s*/i, "").trim() })),
    hasDiscount: items.some((item) => (item.discount ?? 0) > 0),
  };
}

export function partTotal(items: readonly QuotationPresentationItem[]) {
  return quoteTotals([...items]).total;
}

export function quotationPresentation(items: readonly QuotationPresentationItem[]) {
  const parts = splitQuotationItems(items);
  const totalUnits = items.reduce((sum, item) => sum + item.qty, 0);
  const totals = quoteTotals([...items]);
  return { ...parts, totalUnits, totals, grandTotal: totals.total };
}

export function needsPdfTotalsPage(itemRows: number, remainingHeight: number, requiredHeight = 260) {
  return remainingHeight < requiredHeight + itemRows * 18;
}
