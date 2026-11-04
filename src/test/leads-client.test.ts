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
  getLeadTimelineAction: vi.fn(),
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

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

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

  function renderClient() {
    return act(async () => {
      root.render(createElement(LeadsClient, {
        user: manager,
        leads: leads.slice(0, 1),
        executives: [],
        owners: [],
        canAssign: true,
        fixableLeads: [],
        initialTab: "fresh",
        initialCount: 1,
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

  it("shows all six rows after selecting All Leads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      leads,
      total: 6,
      tabCounts: counts,
      todaysFollowUps: 0,
      hasAnyLeads: true,
    })));

    await renderClient();
    await clickAllLeads();

    expect(host.querySelectorAll("#leads-list tbody tr")).toHaveLength(6);
    expect(host.textContent).toContain("Lead 6");
    expect(host.querySelector('[data-tab="all"]')?.textContent).toContain("(6)");
  });

  it("keeps the existing rows and counts on failure and offers a retry", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ error: "Unable to load leads right now." }, 500))
      .mockResolvedValueOnce(response({ leads, total: 6, tabCounts: counts, hasAnyLeads: true })));

    await renderClient();
    await clickAllLeads();

    expect(host.querySelectorAll("#leads-list tbody tr")).toHaveLength(1);
    expect(host.textContent).toContain("Lead 1");
    expect(host.textContent).not.toContain("No leads yet");
    expect(host.querySelector('[data-tab="all"]')?.textContent).toContain("(6)");

    const retry = mocks.toastError.mock.calls[0]?.[1]?.action;
    expect(retry?.label).toBe("Retry");
    await act(async () => {
      retry.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelectorAll("#leads-list tbody tr")).toHaveLength(6);
  });
});
