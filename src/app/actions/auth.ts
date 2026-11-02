"use server";

import { redirect } from "next/navigation";
import { crm } from "@/lib/crm";
import { demoLoginAllowed } from "@/lib/auth/demo";
import { createSession, destroySession } from "@/lib/auth/session";
import { staticUserAsPortalUser, verifyStaticCredentials } from "@/lib/auth/users";

export async function demoLogin(userId: string) {
  if (!demoLoginAllowed()) redirect("/login");
  const user = (await crm().listUsers()).find((u) => u.id === userId);
  if (!user) redirect("/login");
  await createSession(user);
  redirect("/home");
}

export async function loginAction(_: unknown, formData: FormData) {
  const user = verifyStaticCredentials(String(formData.get("username") ?? ""), String(formData.get("password") ?? ""));
  if (!user) return { error: "Invalid username or password" };
  await createSession(staticUserAsPortalUser(user), user.username);
  redirect("/leads");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export const logout = logoutAction;
