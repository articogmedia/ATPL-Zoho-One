import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireActionUser: vi.fn(),
  getLead: vi.fn(),
  updateLead: vi.fn(),
  markStale: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  requireActionUser: mocks.requireActionUser,
}));
vi.mock("@/lib/crm", () => ({ crm: () => ({ getLead: mocks.getLead, updateLead: mocks.updateLead }) }));
vi.mock("@/lib/cache", () => ({
  getCachedValue: vi.fn(),
  invalidate: vi.fn(),
  markStale: mocks.markStale,
  setCachedValue: vi.fn(),
  withIdempotency: vi.fn(),
}));

const lead = {
  id: "lead-1",
  name: "Customer",
  company: "",
  phone: "9876543210",
  area: "",
  source: "Direct Call" as const,
  status: "Quotation Sent" as const,
  assignedTo: "Pavan",
  assignedToId: "exec-1",
  ownerId: "exec-1",
  remarks: "",
  createdOn: "2026-10-01",
  address: "",
  touchedBy: [],
};
const executive = { id: "exec-1", name: "Pavan", role: "Sales Executive" as const };

describe("setLeadOutcomeAction", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.requireActionUser.mockReset().mockResolvedValue(executive);
    mocks.getLead.mockReset().mockResolvedValue(lead);
    mocks.updateLead.mockReset().mockImplementation(async (_id, patch) => ({ ...lead, ...patch }));
    mocks.markStale.mockReset().mockResolvedValue(undefined);
  });

  it("requires a lost reason and saves the outcome for the lead's owner", async () => {
    const { setLeadOutcomeAction } = await import("@/app/actions/crm");

    await expect(setLeadOutcomeAction({ leadId: "lead-1", outcome: "Lost Lead" }))
      .resolves.toMatchObject({ ok: false, error: "Choose a reason before marking this lead lost." });
    expect(mocks.updateLead).not.toHaveBeenCalled();

    await expect(setLeadOutcomeAction({
      leadId: "lead-1", outcome: "Lost Lead", lostReason: "Chose competitor",
    })).resolves.toMatchObject({ ok: true, data: { lead: { status: "Lost Lead", lostReason: "Chose competitor" } } });
    expect(mocks.updateLead).toHaveBeenCalledWith(
      "lead-1",
      { status: "Lost Lead", lostReason: "Chose competitor" },
      executive,
      lead,
    );
  });

  it("denies an executive access to another executive's lead", async () => {
    mocks.getLead.mockResolvedValue({ ...lead, ownerId: "exec-2", assignedToId: "exec-2", assignedTo: "Sai Kiran" });
    const { setLeadOutcomeAction } = await import("@/app/actions/crm");

    await expect(setLeadOutcomeAction({ leadId: "lead-1", outcome: "Won" }))
      .resolves.toMatchObject({ ok: false, error: "You can only work on your own leads." });
    expect(mocks.updateLead).not.toHaveBeenCalled();
  });
});
