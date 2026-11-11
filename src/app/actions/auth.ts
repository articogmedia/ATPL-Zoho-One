"use server";

import { redirect } from "next/navigation";
import { demoLoginAllowed } from "@/lib/auth/demo";
import { createSession, destroySession } from "@/lib/auth/session";
import { STATIC_USERS, resolvePortalUserZohoId, staticUserAsPortalUser } from "@/lib/auth/users";
import { authenticateStaticCredentials } from "@/lib/auth/password-store";
import { loginAttemptStore } from "@/lib/auth/login-attempt-store";
import { crm } from "@/lib/crm";
import { ZohoError } from "@/lib/zoho/client";
import { newErrorReference } from "@/lib/crm-action-errors";
import { canAccess, type User } from "@/lib/domain";

const LOCKOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function firstAllowedPage() {
  return "/home";
}

function allowedReturnPath(value: string, user: User, fallback: string): string {
  const allowed: Record<string, Parameters<typeof canAccess>[1]> = {
    "/home": "home",
    "/leads": "leads",
    "/quotations": "quotations",
    "/visits": "visits",
    "/performance": "performance",
  };
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (!Object.hasOwn(allowed, path) || !canAccess(user.role, allowed[path]!)) return fallback;
  return value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

async function prefetchLandingData(user: User, path: string) {
  const logFailure = (resource: string, error: unknown) => console.error("[auth] landing data prefetch failed", {
    reference: newErrorReference(),
    path,
    resource,
    message: error instanceof Error ? error.message : String(error),
    status: error instanceof ZohoError ? error.status : undefined,
    code: error instanceof ZohoError ? error.code : undefined,
    field: error instanceof ZohoError ? error.field : undefined,
    details: error instanceof ZohoError ? error.details : undefined,
    operation: error instanceof ZohoError ? error.operation : undefined,
  });
  try {
    const repo = crm();
    const tasks: [string, Promise<unknown>][] = path === "/home"
      ? [["leads", repo.listLeads()], ["products", repo.listProducts()]]
      : path === "/leads"
      ? [
        ["leads", repo.listLeads()],
        ["assignable users", repo.listAssignableUsers()],
        ...(user.role === "Manager" ? [["fixable leads", repo.listFixableAssignedLeads(user)] as [string, Promise<unknown>]] : []),
        ]
      : path === "/quotations"
        ? [["leads", repo.listLeads()], ["quotes", repo.listQuotes()], ["products", repo.listProducts()]]
        : path === "/visits"
          ? [["visits", repo.listVisits()], ["assignable users", repo.listAssignableUsers()]]
          : path === "/performance"
            ? [["performance data", Promise.all([repo.listLeads(), repo.listQuotes(), repo.listVisits(), repo.listUsers()])]]
            : [];
    await Promise.all(tasks.map(async ([name, task]) => {
      try {
        await task;
      } catch (error) {
        logFailure(name, error);
      }
    }));
  } catch (error) {
    logFailure("setup", error);
  }
}

export async function demoLogin(userId: string) {
  if (!demoLoginAllowed()) redirect("/login");
  const user = STATIC_USERS.find((candidate) =>
    candidate.username === userId || candidate.zohoUserId === userId);
  if (!user) redirect("/login");
  const staticPortalUser = staticUserAsPortalUser(user);
  const portalUser = process.env.DATA_SOURCE === "mock"
    ? { ...staticPortalUser, id: (await crm().listUsers()).find((candidate) => candidate.name === user.name)?.id ?? staticPortalUser.id }
    : staticPortalUser;
  const destination = firstAllowedPage();
  await createSession(portalUser, user.username);
  void prefetchLandingData(portalUser, destination);
  redirect(destination);
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
  let user;
  try {
    user = await authenticateStaticCredentials(username, String(formData.get("password") ?? ""));
  } catch (error) {
    console.error("[auth] password verification failed", {
      username,
      message: error instanceof Error ? error.message : String(error),
    });
    return { error: "Sign-in is temporarily unavailable. Please try again." };
  }
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
  let portalUser = staticUserAsPortalUser(user);
  if (process.env.DATA_SOURCE === "zoho") {
    const zohoUserId = resolvePortalUserZohoId(user, await crm().listUsers());
    if (!zohoUserId) {
      console.error("[auth] login failed: static account has no active Zoho user mapping", { username: user.username });
      return { error: "Your account is not mapped to an active Zoho CRM user. Please ask an administrator to update your user mapping." };
    }
    portalUser = { ...portalUser, id: zohoUserId };
  }
  const fallback = firstAllowedPage();
  const destination = allowedReturnPath(String(formData.get("returnTo") ?? ""), portalUser, fallback);
  await createSession(portalUser, user.username);
  console.info(`[auth] login success ${Date.now() - started}ms`);
  void prefetchLandingData(portalUser, destination);
  redirect(destination);
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
