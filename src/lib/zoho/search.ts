const escapeCriteria = (value: string) => value.replace(/[\\(),:]/g, "\\$&");

export function leadSearchCriteria(query: string): string {
  const normalized = query.trim().replace(/\s+/g, " ");
  const escapedText = escapeCriteria(normalized);
  const fields = ["Last_Name", "First_Name", "Company", "City"]
    .map((field) => `(${field}:starts_with:${escapedText})`);
  const digits = normalized.replace(/\D/g, "");
  if (digits) {
    const phoneDigits = digits.length > 10 && digits.startsWith("91") ? digits.slice(2) : digits;
    fields.push(`(Mobile:starts_with:${phoneDigits})`, `(Phone:starts_with:${phoneDigits})`);
  }
  return `(${fields.join("or")})`;
}
