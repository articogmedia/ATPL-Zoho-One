import { describe, expect, it } from "vitest";
import { friendlyZohoError } from "@/lib/crm-action-errors";

describe("friendly Zoho action errors", () => {
  it("maps duplicate, validation and throttling errors", () => {
    expect(friendlyZohoError(400, "DUPLICATE_DATA")).toBe(
      "Zoho already has a lead with this mobile number. Open the existing lead instead.",
    );
    expect(friendlyZohoError(400, "INVALID_DATA")).toBe(
      "Some details are missing or invalid. Please check the form.",
    );
    expect(friendlyZohoError(400, "MANDATORY_NOT_FOUND")).toBe(
      "Some details are missing or invalid. Please check the form.",
    );
    expect(friendlyZohoError(429)).toBe(
      "Too many requests. Please wait a few seconds and try again.",
    );
  });

  it("returns a short reference for unknown errors", () => {
    expect(friendlyZohoError(503, "SERVICE_UNAVAILABLE")).toBe(
      "Something went wrong. Please try again. (Ref: SERVICE_UNAVAILABLE)",
    );
  });
});
