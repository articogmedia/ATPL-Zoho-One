import "server-only";
import { redirect } from "next/navigation";
import { canAccess, type Section, type User } from "@/lib/domain";
import { passwordStore } from "@/lib/auth/password-store";
import { readSession } from "./session";
import { STATIC_USERS, portalRole, staticUserAsPortalUser } from "./users";

export class ForbiddenError extends Error {
  constructor(message = "You are not allowed to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export async function currentUser(): Promise<User | null> {
  const s = await readSession();
  if (!s) return null;
  const staticUser = STATIC_USERS.find((u) =>
    portalRole(u.role) === s.role &&
    (u.username === s.username || u.name.toLowerCase() === s.name.toLowerCase()));
  const sessionUsername = staticUser?.username ?? s.username;
  if (s.sessionVersion !== await passwordStore.getSessionVersion(sessionUsername)) return null;
  return staticUser
    ? staticUserAsPortalUser(staticUser, s.zohoUserId || staticUser.zohoUserId || s.uid)
    : { id: s.zohoUserId || s.uid, name: s.name, role: s.role };
}

/** For pages: redirect to login if signed out. */
export async function requireUser(): Promise<User> {
  const started = Date.now();
  const user = await currentUser();
  console.info(`[auth] requireUser ${user ? "authenticated" : "anonymous"} ${Date.now() - started}ms`);
  if (!user) redirect("/login");
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
