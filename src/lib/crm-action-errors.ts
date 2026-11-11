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
  if (field === "Quoted_Items" || field === "Product_Details") {
    const detail = message?.trim().replace(/\s+/g, " ").slice(0, 180);
    const expected = typeof details?.expected_data_type === "string" ? ` Expected ${details.expected_data_type}.` : "";
    const path = typeof details?.json_path === "string" ? ` Path: ${details.json_path}.` : "";
    return `Zoho rejected Quotes line items in ${field}.${expected}${path}${detail ? ` ${detail}` : ""}${suffix}`;
  }
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
  if (code === "INVOICE_ACCOUNT_REQUIRED") {
    return `This customer is not linked to a Zoho Account. Open the customer/lead in Zoho CRM, link or create the Account, then retry invoice conversion.${suffix}`;
  }
  if (code === "INVOICE_PRODUCT_REQUIRED") {
    return `This quotation contains a line that is not linked to a Zoho Product. Update the quotation with an approved catalogue product, then retry.${suffix}`;
  }
  if (code === "INVALID_PICKLIST" || (field === "Lead_Source" && (code === "INVALID_DATA" || responseMessage.includes("picklist")))) {
    if (field === "Lead_Status") return `The lead status value is not configured in Zoho CRM. Add the required status value in the Leads module picklist, then retry.${suffix}`;
    if (field === "Lead_Source") {
      if (message?.startsWith('Lead source "') && message.includes("is not set up in Zoho.")) return `${message}${suffix}`;
      return `Lead source is not valid in CRM.${suffix}`;
    }
    return `${field ? `The selected value for ${field} is not configured in Zoho CRM.` : "A selected value is not configured in Zoho CRM."}${suffix}`;
  }
  if (code === "INVALID_DATA") {
    const errorPath = typeof details?.json_path === "string"
      ? details.json_path
      : typeof details?.api_name === "string"
        ? details.api_name
        : field;
    if (field === "Lead_Ref") {
      const expected = typeof details?.expected_data_type === "string" ? ` Zoho expects ${details.expected_data_type}.` : "";
      return `Zoho rejected the lead reference in Quotes field Lead_Ref.${expected} Check the field type and lookup target.${suffix}`;
    }
    if (field === "Mobile" || field === "Phone") return `Enter a valid 10-digit mobile number.${suffix}`;
    if (field === "Company") return `Required field missing: Company${suffix}`;
    return errorPath
      ? `Zoho rejected the value for field/path ${errorPath}. Check its configured value.${suffix}`
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
