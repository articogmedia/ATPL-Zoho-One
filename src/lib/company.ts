/** Company details printed on quotations. Change here, not in components. */
const configured = (value: string | undefined, fallback: string) => value?.trim() || fallback;
const configuredList = (value: string | undefined, fallback: readonly string[]) =>
  configured(value, fallback.join("|")).split("|").map((item) => item.trim()).filter(Boolean);

export const COMPANY = {
  name: configured(process.env.NEXT_PUBLIC_ATPL_COMPANY_NAME, "Air Trendz P Ltd"),
  address: configured(process.env.NEXT_PUBLIC_ATPL_COMPANY_ADDRESS, "ATPL House, Plot no. 33/C, B K Guda, S R Nagar, Hyderabad - 500038."),
  contact: configured(process.env.NEXT_PUBLIC_ATPL_COMPANY_CONTACT, "Ph: 9490172222 / 9989789222. Email: atpl.hyd@gmail.com"),
  signatory: configured(process.env.NEXT_PUBLIC_ATPL_COMPANY_SIGNATORY, "Reshma"),
  phones: configured(process.env.NEXT_PUBLIC_ATPL_COMPANY_PHONES, "9490172222 / 9989789222"),
  gstin: configured(process.env.NEXT_PUBLIC_ATPL_COMPANY_GSTIN, "36AANCA9304M2Z7"),
  subject: configured(process.env.NEXT_PUBLIC_ATPL_OFFER_SUBJECT, "Your requirement for Air Conditioners - reg."),
  gstRate: 0.18,
  partAGstMode: "extra" as const,
  terms:
    "NOTE: Quantities are tentative; final billing is based on actual measurements. Validity: 30 days from the date of this offer. Delivery: 1-2 weeks from the date of order. Payment: 100% advance for equipment; 60% advance for Part B and 40% on completion.",
} as const;

export const OFFER_TEXT = {
  enquiry: configured(process.env.NEXT_PUBLIC_ATPL_OFFER_ENQUIRY, "We thank you very much for your enquiry. In this connection, in subsequent discussions had with you, we are pleased to submit herewith our offer for the subject works. Our detailed Bill of quantities are as follows"),
  partA: configured(process.env.NEXT_PUBLIC_ATPL_OFFER_PART_A_TITLE, "BOQ - PART A - EQUIPMENT SUPPLY"),
  partB: configured(process.env.NEXT_PUBLIC_ATPL_OFFER_PART_B_TITLE, "BOQ - PART B - ANCILLARY WORKS"),
  partAGst: configured(process.env.NEXT_PUBLIC_ATPL_OFFER_PART_A_GST_TEXT, `GST @ ${Math.round(COMPANY.gstRate * 100)}% EXTRA`),
  partBGst: configured(process.env.NEXT_PUBLIC_ATPL_OFFER_PART_B_GST_TEXT, `GST @ ${Math.round(COMPANY.gstRate * 100)}% EXTRA`),
  note: configured(process.env.NEXT_PUBLIC_ATPL_OFFER_NOTE, "Pls note that the above quantities are tentative only, and final billing shall be based on actual measurements"),
  excluded: configuredList(process.env.NEXT_PUBLIC_ATPL_OFFER_EXCLUDED, [
    "In case of Cat walk requirement for outdoor unit, the same shall be in client scope",
    "Main incoming electrical cabling & civil works such as core cutting, wall chipping in client scope",
  ]),
  terms: [
    ["Validity", configured(process.env.NEXT_PUBLIC_ATPL_OFFER_VALIDITY, "30 days from the date of this offer")],
    ["Taxes", configured(process.env.NEXT_PUBLIC_ATPL_OFFER_TAXES, "GST at applicable line-item and extra-charge rates, as shown above")],
    ["Delivery", configured(process.env.NEXT_PUBLIC_ATPL_OFFER_DELIVERY, "1-2 weeks from the date of order")],
    ["Payment Terms", configured(process.env.NEXT_PUBLIC_ATPL_OFFER_PAYMENT_TERMS, "100% advance for equipment")],
  ] as const,
  paymentContinuation: configured(process.env.NEXT_PUBLIC_ATPL_OFFER_PAYMENT_CONTINUATION, "60% advance for Part B and 40% on completion"),
  closing: configured(process.env.NEXT_PUBLIC_ATPL_OFFER_CLOSING, "We hope our offer is inline with your requirement and look forward to receive your valued order."),
  thanks: configured(process.env.NEXT_PUBLIC_ATPL_OFFER_THANKS, "Thanking you and assuring you of our best attention at all times, we remain"),
  signing: configured(process.env.NEXT_PUBLIC_ATPL_OFFER_SIGNING, "very truly yours"),
} as const;

export function offerSubject(models: readonly string[]): string {
  const remaining = [...new Set(models
    .map((model) => model.trim())
    .filter((model) => model && !/^B\s*-\s*/i.test(model)))];

  const looksLikeAc = remaining.some((model) => {
    const normalized = model.toLowerCase();
    return /\bac\b|air conditioner|airconditioner|split|cassette|vrv|vrf|\btr\b/i.test(normalized);
  });
  if (looksLikeAc) return COMPANY.subject;
  if (!remaining.length) return COMPANY.subject;

  const shown = remaining.slice(0, 3).join(", ");
  return `Your requirement for ${shown}${remaining.length > 3 ? " and more" : ""} - reg.`;
}
