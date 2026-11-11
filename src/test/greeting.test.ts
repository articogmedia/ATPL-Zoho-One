import { describe, expect, it } from "vitest";
import { greetingPartAt } from "@/lib/greeting";

describe("greetingPartAt", () => {
  it.each([
    ["Good morning", "2026-11-11T11:59:00+05:30"],
    ["Good afternoon", "2026-11-11T12:00:00+05:30"],
    ["Good afternoon", "2026-11-11T16:59:00+05:30"],
    ["Good evening", "2026-11-11T17:00:00+05:30"],
  ])("returns %s at %s Asia/Kolkata time", (greeting, localTime) => {
    expect(greetingPartAt(new Date(localTime))).toBe(greeting);
  });
});
