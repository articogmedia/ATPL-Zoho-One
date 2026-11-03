"use server";

import { redirect } from "next/navigation";
import { demoLoginAllowed } from "@/lib/auth/demo";
import { createSession, destroySession } from "@/lib/auth/session";
import { STATIC_USERS, staticUserAsPortalUser, verifyStaticCredentials } from "@/lib/auth/users";

const LOCKOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = globalThis as typeof globalThis & { __atplLoginAttempts?: Map<string, { count: number; lockedUntil: number }> };

export async function demoLogin(userId: string) {
  if (!demoLoginAllowed()) redirect("/login");
  const user = STATIC_USERS.find((candidate) => candidate.zohoUserId === userId);
  if (!user) redirect("/login");
  await createSession(staticUserAsPortalUser(user), user.username);
  redirect("/home");
}

export async function loginAction(_: unknown, formData: FormData) {
  const started = Date.now();
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const now = Date.now();
  const state = (attempts.__atplLoginAttempts ??= new Map()).get(username);
  const user = verifyStaticCredentials(username, String(formData.get("password") ?? ""));
  if (!user) {
    if (state?.lockedUntil && state.lockedUntil > now) {
      console.info(`[auth] login failed: locked ${Date.now() - started}ms`);
      return { error: "Too many attempts, try again in a few minutes" };
    }
    const next = state && state.lockedUntil > 0 && state.lockedUntil <= now
      ? { count: 0, lockedUntil: 0 }
      : (state ?? { count: 0, lockedUntil: 0 });
    next.count += 1;
    if (next.count >= MAX_ATTEMPTS) {
      next.count = 0;
      next.lockedUntil = now + LOCKOUT_MS;
      (attempts.__atplLoginAttempts ??= new Map()).set(username, next);
      console.info(`[auth] login failed: locked ${Date.now() - started}ms`);
      return { error: "Too many attempts, try again in a few minutes" };
    }
    (attempts.__atplLoginAttempts ??= new Map()).set(username, next);
    console.info(`[auth] login failed ${Date.now() - started}ms`);
    return { error: "Invalid username or password" };
  }
  (attempts.__atplLoginAttempts ??= new Map()).delete(username);
  await createSession(staticUserAsPortalUser(user), user.username);
  console.info(`[auth] login success ${Date.now() - started}ms`);
  redirect("/leads");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export const logout = logoutAction;
