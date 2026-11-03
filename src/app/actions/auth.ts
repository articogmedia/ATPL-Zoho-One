"use server";

import { redirect } from "next/navigation";
import { crm } from "@/lib/crm";
import { demoLoginAllowed } from "@/lib/auth/demo";
import { createSession, destroySession } from "@/lib/auth/session";
import { staticUserAsPortalUser, verifyStaticCredentials } from "@/lib/auth/users";

const LOCKOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = globalThis as typeof globalThis & { __atplLoginAttempts?: Map<string, { count: number; lockedUntil: number }> };

export async function demoLogin(userId: string) {
  if (!demoLoginAllowed()) redirect("/login");
  const user = (await crm().listUsers()).find((u) => u.id === userId);
  if (!user) redirect("/login");
  await createSession(user);
  redirect("/home");
}

export async function loginAction(_: unknown, formData: FormData) {
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const now = Date.now();
  const state = (attempts.__atplLoginAttempts ??= new Map()).get(username);
  if (state?.lockedUntil && state.lockedUntil > now) return { error: "Too many attempts, try again in a few minutes" };
  const user = verifyStaticCredentials(username, String(formData.get("password") ?? ""));
  if (!user) {
    const next = state && state.lockedUntil > 0 && state.lockedUntil <= now
      ? { count: 0, lockedUntil: 0 }
      : (state ?? { count: 0, lockedUntil: 0 });
    next.count += 1;
    if (next.count >= MAX_ATTEMPTS) {
      next.count = 0;
      next.lockedUntil = now + LOCKOUT_MS;
      (attempts.__atplLoginAttempts ??= new Map()).set(username, next);
      return { error: "Too many attempts, try again in a few minutes" };
    }
    (attempts.__atplLoginAttempts ??= new Map()).set(username, next);
    return { error: "Invalid username or password" };
  }
  (attempts.__atplLoginAttempts ??= new Map()).delete(username);
  await createSession(staticUserAsPortalUser(user), user.username);
  redirect("/leads");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export const logout = logoutAction;
