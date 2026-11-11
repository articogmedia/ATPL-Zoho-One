import { describe, expect, it, vi } from "vitest";
import { mockRepository } from "@/lib/crm/mock";

vi.mock("server-only", () => ({}));

describe("lead timeline", () => {
  it("combines calls, notes, quotations, and visits", async () => {
    const actor = { id: "manager", name: "Manager", role: "Manager" as const };
    await mockRepository.addLeadNote("L101", "Timeline test", "Added note");
    await mockRepository.logCall({
      leadId: "L101",
      outcome: "Connected",
      remarks: "Call recorded",
    }, actor);

    const timeline = await mockRepository.getLeadTimeline("L101");
    const kinds = timeline.map((item) => item.kind);

    expect(kinds).toEqual(expect.arrayContaining(["Call", "Note", "Quote", "Visit"]));
  });
});
