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
