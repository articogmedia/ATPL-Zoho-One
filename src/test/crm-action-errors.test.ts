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
    expect(friendlyZohoError(400, "INVALID_PICKLIST", "Invalid value", "Lead_Status", "R9"))
      .toBe("The lead status value is not configured in Zoho CRM. Add the required status value in the Leads module picklist, then retry. (Ref: R9)");
    expect(friendlyZohoError(400, "INVOICE_ACCOUNT_REQUIRED", "Missing account", "Account_Name", "R10"))
      .toBe("This customer is not linked to a Zoho Account. Open the customer/lead in Zoho CRM, link or create the Account, then retry invoice conversion. (Ref: R10)");
    expect(friendlyZohoError(
      400,
      "INVALID_PICKLIST",
      'Lead source "Walk-in" is not set up in Zoho. Add it under Setup → Modules and Fields → Leads → Lead Source.',
      "Lead_Source",
      "R2",
    )).toBe('Lead source "Walk-in" is not set up in Zoho. Add it under Setup → Modules and Fields → Leads → Lead Source. (Ref: R2)');
    expect(friendlyZohoError(400, "MANDATORY_NOT_FOUND", "Missing field", "Company", "R3"))
      .toBe("Required field missing: Company (Ref: R3)");
    expect(friendlyZohoError(400, "INVALID_DATA", "Invalid lookup", "Lead_Ref", "R7", "POST /Quotes", { expected_data_type: "lookup" }))
      .toBe("Zoho rejected the lead reference in Quotes field Lead_Ref. Zoho expects lookup. Check the field type and lookup target. (Ref: R7)");
    expect(friendlyZohoError(400, "REQUIRED_FIELD_MISSING", "Required field missing", "Quoted_Items", "R8", "POST /Quotes", {
      expected_data_type: "subform",
      json_path: "$.data[0].Quoted_Items",
    })).toBe("Zoho rejected Quotes line items in Quoted_Items. Expected subform. Path: $.data[0].Quoted_Items. Required field missing (Ref: R8)");
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

  it("shows a clear Zoho token blocked message for refresh back-off", () => {
    expect(friendlyZohoError(
      400,
      "TOKEN_REFRESH_RATE_LIMITED",
      "Zoho token is blocked, retry in 5 minutes.",
      undefined,
      "TOKENREF12345",
    )).toBe(
      "Zoho token is blocked, retry in 5 minutes. (Ref: TOKENREF12345)",
    );
  });

  it("maps timeout and connection errors to actionable messages", () => {
    expect(friendlyZohoError(0, "NETWORK_TIMEOUT", "Zoho timed out, please try again", undefined, "TIMEOUT12345"))
      .toBe("Zoho timed out, please try again. (Ref: TIMEOUT12345)");
    expect(friendlyZohoError(0, "NETWORK_ERROR", "Could not connect to the Zoho CRM API", undefined, "NETWORK12345"))
      .toBe("Could not connect to Zoho CRM. Please retry shortly. (Ref: NETWORK12345)");
  });

  it("reports a missing work item as not found rather than an ownership denial", () => {
    expect(friendlyZohoError(404, "NOT_FOUND", "This task no longer exists, refreshing…", undefined, "TASK404", "GET /Tasks/task-1"))
      .toBe("This task no longer exists, refreshing… (Ref: TASK404)");
  });
});
