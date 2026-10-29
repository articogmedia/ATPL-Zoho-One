import "server-only";
import { redirect } from "next/navigation";
import { canAccess, type Section, type User } from "@/lib/domain";
import { crm } from "@/lib/crm";
import { readSession } from "./session";

export class ForbiddenError extends Error {
  constructor(message = "You are not allowed to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Resolves the signed-in user from the cookie AND re-checks them against the CRM user list,
 * so a user deactivated or re-roled in Zoho loses access without waiting for the cookie to expire.
 */
export async function currentUser(): Promise<User | null> {
  const s = await readSession();
  if (!s) return null;
  const live = (await crm().listUsers()).find((u) => u.id === s.uid);
  return live ?? null;
}

/** For pages: redirect to login if signed out. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/");
  return user;
}

/** For pages: also redirect to Home if the role may not open this section. */
export async function requireSection(section: Section): Promise<User> {
  const user = await requireUser();
  if (!canAccess(user.role, section)) redirect("/home");
  return user;
}

/** For server actions: throw (never redirect) so the client gets a clean error. */
export async function requireActionUser(section: Section): Promise<User> {
  const user = await currentUser();
  if (!user) throw new ForbiddenError("Your session has expired. Please sign in again.");
  if (!canAccess(user.role, section)) throw new ForbiddenError();
  return user;
}
