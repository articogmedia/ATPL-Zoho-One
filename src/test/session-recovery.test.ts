import { describe, expect, it } from "vitest";
import { isRetryableActionMessage, isSessionExpiredMessage } from "@/lib/session-recovery";

describe("action recovery classification", () => {
  it("recognizes expired sessions for a login redirect", () => {
    expect(isSessionExpiredMessage("Your session has expired. Please sign in again.")).toBe(true);
    expect(isSessionExpiredMessage("CRM rejected the request.")).toBe(false);
  });

  it("offers an in-place retry only for transient failures", () => {
    expect(isRetryableActionMessage("Could not connect to Zoho CRM. Please retry shortly.")).toBe(true);
    expect(isRetryableActionMessage("Mobile number already exists.")).toBe(false);
  });
});
