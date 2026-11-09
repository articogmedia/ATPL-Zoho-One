"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export const MUTATION_RETRY_DELAYS_MS = [600, 1500] as const;
export const MUTATION_SOFT_TIMEOUT_MS = 12_000;

export type MutationAction<TInput extends object, TResult> = (
  input: TInput & { idempotencyKey: string },
) => Promise<TResult>;

export type MutationRetryOptions = {
  timeoutMs?: number;
  retries?: number;
  onRetry?: () => void;
  idempotencyKey?: string;
};

export class MutationTimeoutError extends Error {
  constructor() {
    super("The request timed out.");
    this.name = "MutationTimeoutError";
  }
}

export class RetryableMutationError extends Error {
  constructor(readonly retry: () => Promise<unknown>, cause: unknown) {
    super("The change could not be saved.", { cause });
    this.name = "RetryableMutationError";
  }
}

export function isTransientMutationFailure(error: unknown): boolean {
  if (error instanceof MutationTimeoutError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown; status?: unknown };
  if (candidate.name === "AbortError" || candidate.name === "TimeoutError") return true;
  const status = candidate.status;
  if (typeof status === "number" && [502, 503, 504].includes(status)) return true;
  return /load failed|failed to fetch|networkerror|network error|timed?\s*out|timeout|server.action.*fetch|fetch.*server.action|\b(?:502|503|504)\b/i
    .test(`${String(candidate.name ?? "")}: ${String(candidate.message ?? "")}`);
}

export function friendlyMutationError(error: unknown): string {
  if (isTransientMutationFailure(error)) return "Couldn't save. Tap Retry.";
  if (error instanceof RetryableMutationError) return "Couldn't save. Tap Retry.";
  return "Couldn't complete that change. Please try again.";
}

export function notifyMutationFailure(error: unknown): void {
  if (!(error instanceof RetryableMutationError)) {
    toast.error(friendlyMutationError(error));
    return;
  }
  toast.error("Couldn't save. Tap Retry.", {
    action: {
      label: "Retry",
      onClick: () => {
        void error.retry().then((result) => {
          if (result && typeof result === "object" && "ok" in result && result.ok === false &&
            "error" in result && typeof result.error === "string") {
            if (isTransientMutationFailure(new Error(result.error))) notifyMutationFailure(new Error(result.error));
            else toast.error(result.error);
            return;
          }
          toast.success("Saved");
          window.dispatchEvent(new Event("atpl:mutation-recovered"));
        }).catch(notifyMutationFailure);
      },
    },
  });
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = window.setTimeout(done, delay);
    function cleanup() {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    }
    function done() {
      cleanup();
      resolve();
    }
    function aborted() {
      cleanup();
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export async function executeMutation<TInput extends object, TResult>(
  action: MutationAction<TInput, TResult>,
  input: TInput,
  options: MutationRetryOptions = {},
): Promise<TResult> {
  const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
  const retries = options.retries ?? MUTATION_RETRY_DELAYS_MS.length;
  const timeoutMs = options.timeoutMs ?? MUTATION_SOFT_TIMEOUT_MS;
  let activeController: AbortController | undefined;
  let wasHidden = document.visibilityState === "hidden";
  let resumedDuringRequest = false;

  const resume = () => {
    if (document.visibilityState === "hidden") {
      wasHidden = true;
      return;
    }
    if (!wasHidden) return;
    wasHidden = false;
    resumedDuringRequest = true;
    activeController?.abort(new DOMException("Retrying after returning to the page.", "AbortError"));
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pageshow", resume);
  window.addEventListener("online", resume);

  try {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      activeController = controller;
      let timeout: number | undefined;
      const timedRequest = new Promise<TResult>((resolve, reject) => {
        timeout = window.setTimeout(() => {
          controller.abort(new MutationTimeoutError());
          reject(new MutationTimeoutError());
        }, timeoutMs);
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        void action({ ...input, idempotencyKey }).then(resolve, reject);
      });

      try {
        const result = await timedRequest;
        if (result && typeof result === "object" && "ok" in result && result.ok === false &&
          "error" in result && typeof result.error === "string" &&
          isTransientMutationFailure(new Error(result.error))) {
          throw new Error(result.error);
        }
        return result;
      } catch (error) {
        if (!isTransientMutationFailure(error)) {
          throw new Error(friendlyMutationError(error), { cause: error });
        }
        if (attempt >= retries) {
          throw new RetryableMutationError(
            () => executeMutation(action, input, { ...options, idempotencyKey, retries: 0 }),
            error,
          );
        }
        if (options.onRetry) options.onRetry();
        else toast.info("Connection interrupted. Retrying…");
        const retryImmediately = resumedDuringRequest;
        resumedDuringRequest = false;
        if (retryImmediately) continue;
        const delay = MUTATION_RETRY_DELAYS_MS[Math.min(attempt, MUTATION_RETRY_DELAYS_MS.length - 1)]!;
        const waitController = new AbortController();
        const onResume = () => {
          if (document.visibilityState === "visible") waitController.abort();
        };
        document.addEventListener("visibilitychange", onResume);
        window.addEventListener("pageshow", onResume);
        window.addEventListener("online", onResume);
        try {
          await waitForRetry(delay, waitController.signal).catch((waitError: unknown) => {
            if (!(waitError instanceof DOMException) || waitError.name !== "AbortError") throw waitError;
          });
        } finally {
          document.removeEventListener("visibilitychange", onResume);
          window.removeEventListener("pageshow", onResume);
          window.removeEventListener("online", onResume);
        }
      } finally {
        if (timeout !== undefined) window.clearTimeout(timeout);
        if (activeController === controller) activeController = undefined;
      }
    }
  } finally {
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("pageshow", resume);
    window.removeEventListener("online", resume);
  }
}

export function useMutation() {
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const pendingRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async <TInput extends object, TResult>(
    action: MutationAction<TInput, TResult>,
    input: TInput,
    options?: MutationRetryOptions,
  ) => {
    if (pendingRef.current) throw new Error("A change is already being saved.");
    pendingRef.current = true;
    setPending(true);
    try {
      return await executeMutation(action, input, options);
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  return { pending, run };
}
