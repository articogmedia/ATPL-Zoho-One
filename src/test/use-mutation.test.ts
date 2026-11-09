// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";
import { executeMutation, isTransientMutationFailure, notifyMutationFailure, RetryableMutationError } from "@/lib/use-mutation";

afterEach(() => {
  vi.useRealTimers();
});

describe("mutation retry helper", () => {
  it.each([
    new TypeError("Load failed"),
    new TypeError("Failed to fetch"),
    new Error("NetworkError when attempting to fetch resource"),
    Object.assign(new Error("Bad gateway"), { status: 502 }),
  ])("classifies transient failures", (error) => {
    expect(isTransientMutationFailure(error)).toBe(true);
  });

  it.each([
    new Error("You do not have permission to change this lead."),
    new Error("Customer already exists."),
    new Error("DEPENDENT_FIELD_MISSING"),
  ])("does not classify business failures as transient", (error) => {
    expect(isTransientMutationFailure(error)).toBe(false);
  });

  it("retries a dropped request with the same idempotency key", async () => {
    vi.useFakeTimers();
    const action = vi.fn()
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce({ ok: true, data: { id: "lead-1" } });
    const request = executeMutation(action, { name: "Test" }, { idempotencyKey: "test-key" });
    await vi.advanceTimersByTimeAsync(600);

    await expect(request).resolves.toMatchObject({ ok: true, data: { id: "lead-1" } });
    expect(action).toHaveBeenCalledTimes(2);
    expect(action.mock.calls.map(([input]) => input.idempotencyKey)).toEqual(["test-key", "test-key"]);
  });

  it("does not retry a returned Zoho business error", async () => {
    const action = vi.fn().mockResolvedValue({ ok: false, error: "DEPENDENT_FIELD_MISSING" });

    await expect(executeMutation(action, {}, { idempotencyKey: "business-error" }))
      .resolves.toMatchObject({ ok: false, error: "DEPENDENT_FIELD_MISSING" });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("retries a transient error returned by a server action", async () => {
    vi.useFakeTimers();
    const action = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "Zoho timed out, please try again." })
      .mockResolvedValueOnce({ ok: true, data: { id: "lead-2" } });
    const request = executeMutation(action, {}, { idempotencyKey: "server-timeout-key" });
    await vi.advanceTimersByTimeAsync(600);

    await expect(request).resolves.toMatchObject({ ok: true, data: { id: "lead-2" } });
    expect(action).toHaveBeenCalledTimes(2);
    expect(action.mock.calls.map(([input]) => input.idempotencyKey)).toEqual(["server-timeout-key", "server-timeout-key"]);
  });

  it("offers a manual Retry action after automatic retries are exhausted", async () => {
    const action = vi.fn()
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce({ ok: true, data: { id: "lead-3" } });
    const error = await executeMutation(action, {}, { idempotencyKey: "manual-retry-key", retries: 0 })
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(RetryableMutationError);
    notifyMutationFailure(error);
    const lastCall = vi.mocked(toast.error).mock.calls.at(-1);
    const actionOption = lastCall?.[1]?.action;
    expect(actionOption).toMatchObject({ label: "Retry" });
    if (!actionOption || typeof actionOption !== "object" || !("onClick" in actionOption) ||
      typeof actionOption.onClick !== "function") throw new Error("Retry action was not offered.");
    const retry = actionOption.onClick as () => void;
    retry();

    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(action.mock.calls.map(([input]) => input.idempotencyKey)).toEqual(["manual-retry-key", "manual-retry-key"]);
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Saved"));
  });

  it("retries immediately when a hidden-page request is resumed", async () => {
    vi.useFakeTimers();
    let firstRequest: (() => void) | undefined;
    const action = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { firstRequest = () => resolve("discarded"); }))
      .mockResolvedValueOnce("saved");
    const request = executeMutation(action, {}, { idempotencyKey: "resume-key", timeoutMs: 10_000 });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));

    await expect(request).resolves.toBe("saved");
    expect(action).toHaveBeenCalledTimes(2);
    firstRequest?.();
  });
});
