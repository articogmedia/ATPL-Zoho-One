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
  operation?: string,
  details?: Record<string, unknown>,
): string {
  const suffix = ` (Ref: ${reference})`;
  const responseMessage = message?.trim().toLowerCase() ?? "";
  if (status === 404 && /task|visit/.test(responseMessage)) {
    return `This task no longer exists, refreshing…${suffix}`;
  }
  if (code?.startsWith("TOKEN_REFRESH_")) {
    const reason = message?.replace(/^Zoho connection problem:\s*/i, "").trim()
      || "Zoho token is blocked, retry in 1 minute.";
    return `${reason}${suffix}`;
  }
  if (code === "MANDATORY_FIELDS_MISSING" && message?.startsWith("Required fields missing:")) {
    return `${message}${suffix}`;
  }
  if (code === "DUPLICATE_DATA" || code === "DUPLICATE_LEAD") {
    return `Customer already exists. Mobile number is already in use.${suffix}`;
  }
  if (code === "MANDATORY_NOT_FOUND") {
    if (field === "Lead_Ref") {
      const expected = typeof details?.expected_data_type === "string" ? ` Zoho expects ${details.expected_data_type}.` : "";
      return `Zoho Quotes requires field Lead_Ref.${expected} Check its field type and layout configuration.${suffix}`;
    }
    return `${field ? `Required field missing: ${field}` : "A required field is missing."}${suffix}`;
  }
  if (code === "INVALID_PICKLIST" || (field === "Lead_Source" && (code === "INVALID_DATA" || responseMessage.includes("picklist")))) {
    return `Lead source is not valid in CRM.${suffix}`;
  }
  if (code === "INVALID_DATA") {
    if (field === "Lead_Ref") {
      const expected = typeof details?.expected_data_type === "string" ? ` Zoho expects ${details.expected_data_type}.` : "";
      return `Zoho rejected the lead reference in Quotes field Lead_Ref.${expected} Check the field type and lookup target.${suffix}`;
    }
    if (field === "Mobile" || field === "Phone") return `Enter a valid 10-digit mobile number.${suffix}`;
    if (field === "Company") return `Required field missing: Company${suffix}`;
    return field
      ? `Zoho rejected the value for field ${field}. Check its configured value.${suffix}`
      : `Some details are missing or invalid. Please check the form.${suffix}`;
  }
  if (code === "INVALID_TOKEN" || code === "INVALID_OAUTHTOKEN") {
    return `CRM authentication failed after retry. Check the Zoho refresh-token permissions.${suffix}`;
  }
  if (code === "NETWORK_TIMEOUT" || (code === "TOKEN_REFRESH_NETWORK_ERROR" && /timeout|timed out|abort/i.test(responseMessage))) {
    return `Zoho timed out, please try again.${suffix}`;
  }
  if (code === "NETWORK_ERROR" || code === "TOKEN_REFRESH_NETWORK_ERROR") {
    return `Could not connect to Zoho CRM. Please retry shortly.${suffix}`;
  }
  if (code === "NO_PERMISSION" || code === "OAUTH_SCOPE_MISMATCH") {
    const operationPath = operation?.toUpperCase() ?? "";
    const requiredScope = operationPath.includes("/SETTINGS/FIELDS")
      ? "ZohoCRM.settings.fields.READ"
      : operationPath.includes("/SETTINGS/MODULES")
        ? "ZohoCRM.settings.modules.READ"
        : operationPath.startsWith("POST /LEADS")
          ? "ZohoCRM.modules.leads.CREATE"
          : operationPath.startsWith("GET /LEADS")
            ? "ZohoCRM.modules.leads.READ"
            : operationPath.startsWith("PUT /LEADS") || operationPath.startsWith("PATCH /LEADS")
              ? "ZohoCRM.modules.leads.UPDATE"
              : operationPath.startsWith("DELETE /LEADS")
                ? "ZohoCRM.modules.leads.DELETE"
                : operationPath.startsWith("POST /QUOTES")
                  ? "ZohoCRM.modules.quotes.CREATE"
                  : operationPath.startsWith("GET /QUOTES")
                    ? "ZohoCRM.modules.quotes.READ"
                : null;
    if (requiredScope) return `Zoho permission missing: ${requiredScope}${suffix}`;
    return `Zoho permissions are insufficient. Reconnect with Leads create/read and field metadata read access.${suffix}`;
  }
  if (status === 429) return `Too many requests. Please wait a few seconds and try again.${suffix}`;
  if (status !== undefined && status >= 500) return `CRM service is temporarily unavailable. Please try again.${suffix}`;
  const reason = code || (status ? `HTTP ${status}` : "unexpected server error");
  return `CRM rejected the request (${reason}). Please contact support.${suffix}`;
}
