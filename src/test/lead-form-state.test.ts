import { describe, expect, it } from "vitest";
import { claimLeadSubmission, shouldClearLeadDuplicate } from "@/lib/lead-form-state";

describe("add lead form state", () => {
  it("clears a duplicate when the phone changes", () => {
    expect(shouldClearLeadDuplicate("9999999999", "8888888888")).toBe(true);
    expect(shouldClearLeadDuplicate("9999999999", "9999999999")).toBe(false);
  });

  it("allows only one submission for a double-tap", () => {
    const submitted = { current: false };
    expect(claimLeadSubmission(submitted)).toBe(true);
    expect(claimLeadSubmission(submitted)).toBe(false);
  });
});
