import { describe, expect, it } from "vitest";
import { zohoDateTime } from "@/lib/zoho/date-time";
import { leadSearchCriteria } from "@/lib/zoho/search";

describe("Zoho date/time formatting", () => {
  it("writes Asia/Kolkata ISO timestamps with an explicit offset and no milliseconds", () => {
    const formatted = zohoDateTime(new Date("2026-11-07T10:30:00.987Z"));
    expect(formatted).toBe("2026-11-07T16:00:00+05:30");
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
});

describe("Zoho lead search criteria", () => {
  it("uses supported text operators and never contains for phone fields", () => {
    const criteria = leadSearchCriteria("Rao");
    expect(criteria).toContain("(Last_Name:starts_with:Rao)");
    expect(criteria).toContain("(Company:starts_with:Rao)");
    expect(criteria).not.toContain("Mobile:");
    expect(criteria).not.toContain("Phone:");
    expect(criteria).not.toContain(":contains:");
  });

  it("normalizes phone searches to digits before adding phone starts_with criteria", () => {
    const criteria = leadSearchCriteria("+91 98765-43210");
    expect(criteria).toContain("(Mobile:starts_with:9876543210)");
    expect(criteria).toContain("(Phone:starts_with:9876543210)");
    expect(criteria.match(/\((?:Mobile|Phone):starts_with:[^)]*\)/g)).toEqual([
      "(Mobile:starts_with:9876543210)",
      "(Phone:starts_with:9876543210)",
    ]);
  });
});
