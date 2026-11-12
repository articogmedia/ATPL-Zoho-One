import { quotationGstBreakdown, type QuoteExtraCharge } from "@/lib/domain";

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
  taxRate?: number;
};

export function displayProductUnit(unit: string) {
  const normalized = unit.trim();
  if (normalized.toLocaleLowerCase() === "rmt") return "Running Meter";
  if (normalized.toLocaleLowerCase() === "nos") return "Numbers";
  return normalized;
}

const OFFER_BRANDS = ["SAMSUNG", "DAIKIN", "GENERAL", "LG", "HITACHI", "VOLTAS", "PANASONIC", "MITSUBISHI", "CARRIER", "BLUE STAR", "TOSHIBA", "HAIER"];

export function formatOfferReference(offerNo: string, items: readonly Pick<QuotationPresentationItem, "model">[], revision = 0) {
  const brands = new Set(items.flatMap(({ model }) => OFFER_BRANDS.filter((brand) =>
    new RegExp(`\\b${brand.replace(" ", "\\s+")}\\b`, "i").test(model),
  )));
  const brand = brands.size === 1 ? [...brands][0] : brands.size > 1 ? "MULTI-BRAND" : "";
  return `${offerNo.trim()}${brand ? `/${brand}` : ""}${revision > 0 ? ` /R${revision}` : ""}`;
}

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

export function partTotal(items: readonly QuotationPresentationItem[], extraCharges: readonly QuoteExtraCharge[] = []) {
  return quotationGstBreakdown([...items], extraCharges).total;
}

export function quotationPresentation(items: readonly QuotationPresentationItem[], extraCharges: readonly QuoteExtraCharge[] = []) {
  const parts = splitQuotationItems(items);
  const totalUnits = parts.equipment.reduce((sum, item) => sum + item.qty, 0);
  const totals = quotationGstBreakdown([...items], extraCharges);
  return { ...parts, totalUnits, totals, grandTotal: totals.total };
}

export function needsPdfTotalsPage(itemRows: number, remainingHeight: number, requiredHeight = 260) {
  return remainingHeight < requiredHeight + itemRows * 18;
}
