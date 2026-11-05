import { describe, expect, it } from "vitest";
import { friendlyZohoError } from "@/lib/crm-action-errors";

describe("friendly Zoho action errors", () => {
  it("maps duplicate, validation and throttling errors", () => {
    expect(friendlyZohoError(400, "DUPLICATE_DATA")).toBe(
      "Mobile number already exists in Zoho CRM. (Ref: DUPLICATE_DATA)",
    );
    expect(friendlyZohoError(400, "INVALID_DATA")).toBe(
      "Some details are missing or invalid. Please check the form. (Ref: INVALID_DATA)",
    );
    expect(friendlyZohoError(400, "MANDATORY_NOT_FOUND")).toBe(
      "A required field is required. (Ref: MANDATORY_NOT_FOUND)",
    );
    expect(friendlyZohoError(429)).toBe(
      "Too many requests. Please wait a few seconds and try again. (Ref: 429)",
    );
    expect(friendlyZohoError(400, "MANDATORY_NOT_FOUND", "Missing field", "Last_Name", "R1"))
      .toBe("Field Last_Name is required. (Ref: R1)");
    expect(friendlyZohoError(400, "INVALID_DATA", "Invalid picklist", "Lead_Source", "R2"))
      .toBe("Zoho rejected the value for field Lead_Source. Check its configured value. (Ref: R2)");
  });

  it("returns a short reference for unknown errors", () => {
    expect(friendlyZohoError(503, "SERVICE_UNAVAILABLE")).toBe(
      "Unable to complete the CRM request. Please contact support. (Ref: SERVICE_UNAVAILABLE)",
    );
  });
});
