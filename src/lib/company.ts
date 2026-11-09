import { GST_RATE } from "./domain";

/** Company details printed on quotations. Change here, not in components. */
export const COMPANY = {
  name: "Air Trendz P Ltd",
  address: "ATPL House, Plot no. 33/C, B K Guda, S R Nagar, Hyderabad - 500038.",
  contact: "Ph: 9490172222 / 9989789222. Email: atpl.hyd@gmail.com",
  signatory: "Reshma",
  phones: "9490172222 / 9989789222",
  gstin: "36AANCA9304M2Z7",
  subject: "Your requirement for SAMSUNG MAKE INVERTOR Air Conditioners - reg.",
  terms:
    "NOTE: Quantities are tentative; final billing is based on actual measurements. Validity: 30 days from the date of this offer. Delivery: 1-2 weeks from the date of order. Payment: 100% advance for equipment; 60% advance for Part B and 40% on completion.",
} as const;

export const OFFER_TEXT = {
  enquiry:
    "We thank you very much for your enquiry. In this connection, in subsequent discussions had with you, we are pleased to submit herewith our offer for the subject works. Our detailed Bill of quantities are as follows",
  partA: "BOQ - PART A - EQUIPMENT SUPPLY",
  partB: "BOQ - PART B - ANCILLARY WORKS",
  partAGst: `GST @ ${Math.round(GST_RATE * 100)}% included`,
  partBGst: `GST @ ${Math.round(GST_RATE * 100)}% EXTRA`,
  note: "Pls note that the above quantities are tentative only, and final billing shall be based on actual measurements",
  excluded: [
    "In case of Cat walk requirement for outdoor unit, the same shall be in client scope",
    "Main incoming electrical cabling & civil works such as core cutting, wall chipping in client scope",
  ],
  terms: [
    ["Validity", "30 days from the date of this offer"],
    ["Taxes", `GST @ ${Math.round(GST_RATE * 100)}% extra, as shown above`],
    ["Delivery", "1-2 weeks from the date of order"],
    ["Payment Terms", "100% advance for equipment"],
  ] as const,
  paymentContinuation: "60% advance for Part B and 40% on completion",
  closing: "We hope our offer is inline with your requirement and look forward to receive your valued order.",
  thanks: "Thanking you and assuring you of our best attention at all times, we remain",
  signing: "very truly yours",
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
