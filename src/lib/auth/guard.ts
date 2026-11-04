import "server-only";
import { redirect } from "next/navigation";
import { canAccess, type Section, type User } from "@/lib/domain";
import { crm } from "@/lib/crm";
import { readSession } from "./session";
import { STATIC_USERS, portalRole, resolvePortalUserZohoId, staticUserAsPortalUser } from "./users";

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
  const staticUser = STATIC_USERS.find((u) => u.username === s.username && portalRole(u.role) === s.role);
  if (staticUser) {
    let zohoUserId = staticUser.zohoUserId?.trim() ?? "";
    try {
      const users = await crm().listUsers();
      zohoUserId = resolvePortalUserZohoId(staticUser, users);
    } catch (error) {
      console.error("[auth] Could not resolve sandbox CRM user; using configured user id", {
        username: staticUser.username,
        configuredId: zohoUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return staticUserAsPortalUser(staticUser, zohoUserId);
  }
  let liveUsers;
  try {
    liveUsers = await crm().listUsers();
  } catch (error) {
    console.error("[auth] Could not validate live Zoho user", {
      uid: s.uid,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const live = liveUsers.find((u) => u.id === s.uid);
  return live ?? null;
}

/** For pages: redirect to login if signed out. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
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
