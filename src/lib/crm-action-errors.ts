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
  const responseMessage = message?.trim().toLowerCase() ?? "";
  if (code === "DUPLICATE_DATA" || code === "DUPLICATE_LEAD") {
    return `Customer already exists. Mobile number is already in use.${suffix}`;
  }
  if (code === "MANDATORY_NOT_FOUND") {
    return `${field ? `Required field missing: ${field}` : "A required field is missing."}${suffix}`;
  }
  if (code === "INVALID_PICKLIST" || (field === "Lead_Source" && (code === "INVALID_DATA" || responseMessage.includes("picklist")))) {
    return `Lead source is not valid in CRM.${suffix}`;
  }
  if (code === "INVALID_DATA") {
    if (field === "Mobile" || field === "Phone") return `Enter a valid 10-digit mobile number.${suffix}`;
    if (field === "Company") return `Required field missing: Company${suffix}`;
    return field
      ? `Zoho rejected the value for field ${field}. Check its configured value.${suffix}`
      : `Some details are missing or invalid. Please check the form.${suffix}`;
  }
  if (code === "INVALID_TOKEN" || code === "INVALID_OAUTHTOKEN") {
    return `CRM authentication failed after retry. Check the Zoho refresh-token permissions.${suffix}`;
  }
  if (code === "NO_PERMISSION" || code === "OAUTH_SCOPE_MISMATCH") {
    return `Zoho permissions are insufficient. Reconnect with Leads create/read and field metadata read access.${suffix}`;
  }
  if (status === 429) return `Too many requests. Please wait a few seconds and try again.${suffix}`;
  if (status !== undefined && status >= 500) return `CRM service is temporarily unavailable. Please try again.${suffix}`;
  const reason = code || (status ? `HTTP ${status}` : "unexpected server error");
  return `CRM rejected the request (${reason}). Please contact support.${suffix}`;
}
