import { randomUUID } from "node:crypto";

export function newErrorReference(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
}

export function friendlyZohoError(
  status?: number,
  code?: string,
  message?: string,
  field?: string,
  reference = code || String(status || "CRM"),
): string {
  const suffix = ` (Ref: ${reference})`;
  if (code === "DUPLICATE_DATA" || code === "DUPLICATE_LEAD") {
    return `Mobile number already exists in Zoho CRM.${suffix}`;
  }
  if (code === "MANDATORY_NOT_FOUND") {
    return `${field ? `Field ${field}` : "A required field"} is required.${suffix}`;
  }
  if (code === "INVALID_DATA") {
    return field
      ? `Zoho rejected the value for field ${field}. Check its configured value.${suffix}`
      : `Some details are missing or invalid. Please check the form.${suffix}`;
  }
  if (status === 429) return `Too many requests. Please wait a few seconds and try again.${suffix}`;
  const usefulMessage = message?.trim();
  return `${usefulMessage || "Unable to complete the CRM request. Please contact support."}${suffix}`;
}
