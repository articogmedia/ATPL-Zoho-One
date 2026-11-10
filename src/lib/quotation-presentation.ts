import { quotationGstBreakdown } from "@/lib/domain";

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

const internalText = /\b(?:selling\s+price\s+(?:excl(?:usive)?\.?\s*|excluding\s*)?gst|price\s+(?:list|circular))\b/i;

function stripInternalProductText(value: string) {
  const marker = internalText.exec(value);
  return (marker ? value.slice(0, marker.index) : value).trim().replace(/[\s;,|]+$/, "");
}

export function customerProductDescription(model: string, description = "") {
  let cleaned = stripInternalProductText(description);
  const productName = stripInternalProductText(model).replace(/^B\s*-\s*/i, "");
  if (productName && cleaned.toLocaleLowerCase().startsWith(productName.toLocaleLowerCase())) {
    cleaned = cleaned.slice(productName.length).replace(/^[\s/|,:;–—-]+/, "");
  }
  return cleaned.trim();
}

export function formatQuotationMoney(value: number) {
  return `Rs. ${value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function splitQuotationItems(items: readonly QuotationPresentationItem[]) {
  const ancillary = items.filter((item) => /^B\s*-\s*/i.test(item.model.trim()));
  const equipment = items.filter((item) => !/^B\s*-\s*/i.test(item.model.trim()));
  const present = (item: QuotationPresentationItem, model: string): QuotationPresentationItem => ({
    ...item,
    model: stripInternalProductText(model),
    description: customerProductDescription(model, item.description),
  });
  return {
    equipment: equipment.map((item) => present(item, item.model.trim())),
    ancillary: ancillary.map((item) => present(item, item.model.trim().replace(/^B\s*-\s*/i, "").trim())),
    hasDiscount: items.some((item) => (item.discount ?? 0) > 0),
  };
}

export function partTotal(items: readonly QuotationPresentationItem[]) {
  return quotationGstBreakdown([...items]).total;
}

export function quotationPresentation(items: readonly QuotationPresentationItem[]) {
  const parts = splitQuotationItems(items);
  const totalUnits = parts.equipment.reduce((sum, item) => sum + item.qty, 0);
  const totals = quotationGstBreakdown([...items]);
  return { ...parts, totalUnits, totals, grandTotal: totals.total };
}

export function needsPdfTotalsPage(itemRows: number, remainingHeight: number, requiredHeight = 260) {
  return remainingHeight < requiredHeight + itemRows * 18;
}
