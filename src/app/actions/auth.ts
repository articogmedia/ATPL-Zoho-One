"use server";

import { redirect } from "next/navigation";
import { demoLoginAllowed } from "@/lib/auth/demo";
import { createSession, destroySession } from "@/lib/auth/session";
import { STATIC_USERS, staticUserAsPortalUser, verifyStaticCredentials } from "@/lib/auth/users";
import { loginAttemptStore } from "@/lib/auth/login-attempt-store";

const LOCKOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export async function demoLogin(userId: string) {
  if (!demoLoginAllowed()) redirect("/login");
  const user = STATIC_USERS.find((candidate) =>
    candidate.username === userId || candidate.zohoUserId === userId);
  if (!user) redirect("/login");
  await createSession(staticUserAsPortalUser(user), user.username);
  redirect("/home");
}

export async function loginAction(_: unknown, formData: FormData) {
  const started = Date.now();
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const now = Date.now();
  const state = await loginAttemptStore.get(username);
  if (state?.lockedUntil && state.lockedUntil > now) {
    console.info(`[auth] login failed: locked ${Date.now() - started}ms`);
    return { error: "Too many attempts, try again in a few minutes" };
  }
  const user = verifyStaticCredentials(username, String(formData.get("password") ?? ""));
  if (!user) {
    const next = state && state.lockedUntil > 0 && state.lockedUntil <= now
      ? { count: 0, lockedUntil: 0 }
      : (state ?? { count: 0, lockedUntil: 0 });
    next.count += 1;
    if (next.count >= MAX_ATTEMPTS) {
      next.count = 0;
      next.lockedUntil = now + LOCKOUT_MS;
      await loginAttemptStore.set(username, next);
      console.info(`[auth] login failed: locked ${Date.now() - started}ms`);
      return { error: "Too many attempts, try again in a few minutes" };
    }
    await loginAttemptStore.set(username, next);
    console.info(`[auth] login failed ${Date.now() - started}ms`);
    return { error: "Invalid username or password" };
  }
  await loginAttemptStore.delete(username);
  await createSession(staticUserAsPortalUser(user), user.username);
  console.info(`[auth] login success ${Date.now() - started}ms`);
  redirect("/leads");
}

export async function logoutAction(expired = false) {
  await destroySession();
  redirect(expired ? "/login?expired=1" : "/login");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

export async function logoutExpired() {
  await destroySession();
  redirect("/login?expired=1");
}
