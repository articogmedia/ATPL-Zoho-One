// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadsClient } from "@/app/(app)/leads/LeadsClient";
import type { Lead, LeadTab, User } from "@/lib/domain";

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/lead-form-state", () => ({
  claimLeadSubmission: vi.fn(),
  shouldClearLeadDuplicate: vi.fn(() => false),
}));
vi.mock("@/app/actions/crm", () => ({
  addLeadAction: vi.fn(),
  deleteLeadAction: vi.fn(),
  fixAssignedLeadsAction: vi.fn(),
  getAssignableUsersAction: vi.fn(),
  getLeadTimelineAction: vi.fn(),
  listFixableAssignedLeadsAction: vi.fn(async () => ({ ok: true, data: [] })),
  logCallAction: vi.fn(),
  reassignLeadAction: vi.fn(),
  saveLeadUpdateAction: vi.fn(),
  scheduleVisitAction: vi.fn(),
  updateLeadAction: vi.fn(),
}));

const manager: User = { id: "manager-1", name: "Manager", role: "Manager" };
const leads: Lead[] = Array.from({ length: 6 }, (_, index) => ({
  id: `L${index + 1}`,
  name: `Lead ${index + 1}`,
  company: `Company ${index + 1}`,
  phone: `900000000${index + 1}`,
  area: "North",
  source: "Meta Ads",
  status: "Assigned to Sales",
  assignedTo: "Manager",
  assignedToId: manager.id,
  ownerId: manager.id,
  remarks: "",
  createdOn: `2026-11-0${6 - index}`,
  address: "",
  touchedBy: ["Manager"],
}));
const counts: Record<LeadTab, number> = { fresh: 1, assigned: 5, callback: 0, mine: 3, all: 6 };

describe("LeadsClient server paging", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.toastError.mockReset();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function renderClient(initialRows = leads.slice(0, 1), initialCount = 1, initialTab: LeadTab = "fresh") {
    return act(async () => {
      root.render(createElement(LeadsClient, {
        user: manager,
        leads: initialRows,
        executives: [],
        assignees: [],
        assigneesUnavailable: false,
        owners: [],
        canAssign: true,
        fixableLeads: [],
        initialTab,
        initialCount,
        tabCounts: counts,
        todaysFollowUps: 0,
        hasAnyLeads: true,
      }));
    });
  }

  async function clickAllLeads() {
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-tab="all"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("shows all already-loaded rows after selecting All Leads without a refetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await renderClient(leads, 6);
    await clickAllLeads();

    expect(host.querySelectorAll("#leads-list tbody tr")).toHaveLength(6);
    expect(host.textContent).toContain("Lead 6");
    expect(host.querySelector('[data-tab="all"]')?.textContent).toContain("(6)");
    expect(fetch).not.toHaveBeenCalled();
  });
});
