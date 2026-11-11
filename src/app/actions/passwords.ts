"use server";

import { z } from "zod";
import { requireActionUser } from "@/lib/auth/guard";
import { STATIC_USERS } from "@/lib/auth/users";
import { setStaticUserPassword } from "@/lib/auth/password-store";

const managerResetSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(10).max(128),
});

export async function managerResetPassword(input: unknown) {
  const user = await requireActionUser("home");
  if (user.role !== "Manager") return { error: "Only a Manager can reset another user's password." };
  const parsed = managerResetSchema.safeParse(input);
  if (!parsed.success) return { error: "Choose a user and enter a password between 10 and 128 characters." };
  if (!STATIC_USERS.some((candidate) => candidate.username === parsed.data.username)) {
    return { error: "That portal user could not be found." };
  }
  try {
    await setStaticUserPassword(parsed.data.username, parsed.data.password);
    return { success: true };
  } catch (error) {
    console.error("[auth] manager password reset failed", {
      username: parsed.data.username,
      message: error instanceof Error ? error.message : String(error),
    });
    return { error: "Password reset is temporarily unavailable. Please try again." };
  }
}
