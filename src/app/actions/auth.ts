"use server";

import { redirect } from "next/navigation";
import { crm } from "@/lib/crm";
import { demoLoginAllowed } from "@/lib/auth/demo";
import { createSession, destroySession } from "@/lib/auth/session";

export async function demoLogin(userId: string) {
  if (!demoLoginAllowed()) redirect("/");
  const user = (await crm().listUsers()).find((u) => u.id === userId);
  if (!user) redirect("/");
  await createSession(user);
  redirect("/home");
}

export async function logout() {
  await destroySession();
  redirect("/");
}
