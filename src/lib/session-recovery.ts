"use client";

export function isSessionExpiredMessage(message: string): boolean {
  return /session has expired/i.test(message);
}

export function isRetryableActionMessage(message: string): boolean {
  return /network|timed out|temporar|token refresh|retry/i.test(message);
}

export function redirectForExpiredSession(draft?: { type: string; payload: unknown }): boolean {
  try {
    if (draft) sessionStorage.setItem("atpl:expired-action", JSON.stringify(draft));
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login?expired=1&returnTo=${encodeURIComponent(returnTo)}`);
    return true;
  } catch (error) {
    console.warn("[auth] could not preserve form draft before sign-in", error);
    window.location.assign("/login?expired=1");
    return true;
  }
}

export function readExpiredAction<T extends { type: string; payload: unknown }>(): T | null {
  try {
    const value = sessionStorage.getItem("atpl:expired-action");
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || !("type" in parsed) || !("payload" in parsed)) return null;
    return parsed as T;
  } catch (error) {
    console.warn("[auth] could not restore saved form draft", error);
    return null;
  }
}

export function clearExpiredAction() {
  try {
    sessionStorage.removeItem("atpl:expired-action");
  } catch (error) {
    console.warn("[auth] could not clear saved form draft", error);
  }
}
