import { describe, expect, it } from "vitest";
import { friendlyZohoError } from "@/lib/crm-action-errors";

describe("friendly Zoho action errors", () => {
  it("maps duplicate, validation and throttling errors", () => {
    expect(friendlyZohoError(400, "DUPLICATE_DATA")).toBe(
      "Customer already exists. Mobile number is already in use. (Ref: DUPLICATE_DATA)",
    );
    expect(friendlyZohoError(400, "INVALID_DATA")).toBe(
      "Some details are missing or invalid. Please check the form. (Ref: INVALID_DATA)",
    );
    expect(friendlyZohoError(400, "MANDATORY_NOT_FOUND")).toBe(
      "A required field is missing. (Ref: MANDATORY_NOT_FOUND)",
    );
    expect(friendlyZohoError(429)).toBe(
      "Too many requests. Please wait a few seconds and try again. (Ref: 429)",
    );
    expect(friendlyZohoError(400, "MANDATORY_NOT_FOUND", "Missing field", "Last_Name", "R1"))
      .toBe("Required field missing: Last_Name (Ref: R1)");
    expect(friendlyZohoError(400, "INVALID_DATA", "Invalid picklist", "Lead_Source", "R2"))
      .toBe("Lead source is not valid in CRM. (Ref: R2)");
    expect(friendlyZohoError(400, "MANDATORY_NOT_FOUND", "Missing field", "Company", "R3"))
      .toBe("Required field missing: Company (Ref: R3)");
    expect(friendlyZohoError(401, "OAUTH_SCOPE_MISMATCH", "invalid oauth scope to access this URL", undefined, "R4"))
      .toBe("Zoho permissions are insufficient. Reconnect with Leads create/read and field metadata read access. (Ref: R4)");
    expect(friendlyZohoError(401, "OAUTH_SCOPE_MISMATCH", "invalid oauth scope to access this URL", undefined, "R5", "GET /settings/fields"))
      .toBe("Zoho permission missing: ZohoCRM.settings.fields.READ (Ref: R5)");
    expect(friendlyZohoError(401, "OAUTH_SCOPE_MISMATCH", "invalid oauth scope to access this URL", undefined, "R6", "POST /Leads"))
      .toBe("Zoho permission missing: ZohoCRM.modules.leads.CREATE (Ref: R6)");
  });

  it("returns a short reference for unknown errors", () => {
    expect(friendlyZohoError(503, "SERVICE_UNAVAILABLE")).toBe(
      "CRM service is temporarily unavailable. Please try again. (Ref: SERVICE_UNAVAILABLE)",
    );
  });

  it("preserves the full list of missing mandatory fields", () => {
    expect(friendlyZohoError(
      400,
      "MANDATORY_FIELDS_MISSING",
      "Required fields missing: Account_Name, Contact_Name",
      "Account_Name",
      "QUOTE1234567",
    )).toBe("Required fields missing: Account_Name, Contact_Name (Ref: QUOTE1234567)");
  });

  it("shows a clear Zoho connection message for refresh back-off", () => {
    expect(friendlyZohoError(
      400,
      "TOKEN_REFRESH_RATE_LIMITED",
      "Zoho connection problem: Zoho is temporarily blocking token refresh. Retry in about 5 minutes.",
      undefined,
      "TOKENREF12345",
    )).toBe(
      "Zoho connection problem: Zoho is temporarily blocking token refresh. Retry in about 5 minutes. (Ref: TOKENREF12345)",
    );
  });
});
