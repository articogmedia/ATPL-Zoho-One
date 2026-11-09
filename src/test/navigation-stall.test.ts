import { afterEach, describe, expect, it, vi } from "vitest";
import { NAVIGATION_WATCHDOG_MS, startNavigationWatchdog, trackableNavigation } from "@/lib/navigation-stall";

afterEach(() => {
  vi.useRealTimers();
});

const currentHref = "https://portal.example/leads?tab=mine";
const click = (href: string, overrides: Partial<Parameters<typeof trackableNavigation>[0]> = {}) =>
  trackableNavigation({
    defaultPrevented: true,
    button: 0,
    modified: false,
    href,
    target: "",
    download: false,
    ...overrides,
  }, currentHref);

describe("stalled-navigation eligibility", () => {
  it("tracks same-origin route and search-param navigation", () => {
    expect(click("/quotations?lead=123")).toEqual({
      href: "https://portal.example/quotations?lead=123",
      routeKey: "/quotations?lead=123",
    });
  });

  describe("navigation watchdog", () => {
    it("falls back to the requested URL after four seconds", () => {
      vi.useFakeTimers();
      const onStall = vi.fn();
      startNavigationWatchdog("/quotations", onStall);

      vi.advanceTimersByTime(NAVIGATION_WATCHDOG_MS - 1);
      expect(onStall).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onStall).toHaveBeenCalledOnce();
      expect(onStall).toHaveBeenCalledWith("/quotations");
    });

    it("does not fall back after navigation completes", () => {
      vi.useFakeTimers();
      const onStall = vi.fn();
      const cancel = startNavigationWatchdog("/quotations", onStall);
      cancel();
      vi.advanceTimersByTime(NAVIGATION_WATCHDOG_MS);
      expect(onStall).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["external link", "https://wa.me/919876543210", {}],
    ["telephone link", "tel:+919876543210", {}],
    ["email link", "mailto:sales@example.com", {}],
    ["new tab", "/quotations", { target: "_blank" }],
    ["download", "/offer.pdf", { download: true }],
    ["same route", "/leads?tab=mine", {}],
    ["unhandled click", "/quotations", { defaultPrevented: false }],
    ["modified click", "/quotations", { modified: true }],
  ] as const)("does not track %s", (_description, href, overrides) => {
    expect(click(href, overrides)).toBeNull();
  });
});
