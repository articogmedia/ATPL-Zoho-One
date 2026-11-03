import { timingSafeEqual } from "node:crypto";
import type { Role, User } from "@/lib/domain";

export type StaticRole = "Manager" | "Sales" | "Caller";
export type StaticUser = {
  username: string;
  name: string;
  role: StaticRole;
  email?: string;
  zohoUserId?: string;
  passwordEnv: string;
};

export const STATIC_USERS: readonly StaticUser[] = [
  { username: "reshma", name: "Reshma", role: "Manager", email: process.env.ATPL_RESHMA_EMAIL, zohoUserId: "1394515000000464001", passwordEnv: "ATPL_RESHMA_PASSWORD" },
  { username: "pavan", name: "Pavan", role: "Sales", email: process.env.ATPL_PAVAN_EMAIL, zohoUserId: "1394515000001147001", passwordEnv: "ATPL_PAVAN_PASSWORD" },
  { username: "saikiran", name: "Sai Kiran", role: "Sales", email: process.env.ATPL_SAIKIRAN_EMAIL, zohoUserId: "1394515000001126001", passwordEnv: "ATPL_SAIKIRAN_PASSWORD" },
  ...(process.env.ATPL_CALLING_USERNAME ? [{ username: process.env.ATPL_CALLING_USERNAME, name: process.env.ATPL_CALLING_NAME ?? "Calling Team", role: "Caller" as const, email: process.env.ATPL_CALLING_EMAIL, zohoUserId: process.env.ATPL_CALLING_ZOHO_USER_ID, passwordEnv: "ATPL_CALLING_PASSWORD" }] : []),
];

export function portalRole(role: StaticRole): Role {
  return role === "Manager" ? "Manager" : role === "Sales" ? "Sales Executive" : "Calling Team";
}

export function staticUserAsPortalUser(user: StaticUser, zohoUserId = user.zohoUserId ?? ""): User {
  return { id: zohoUserId.trim(), name: user.name, role: portalRole(user.role), email: user.email };
}

export function matchPortalUserToZohoUser(portalUser: StaticUser, zohoUsers: readonly User[]): User | null {
  const email = portalUser.email?.trim().toLowerCase();
  if (!email) return null;
  return zohoUsers.find((user) => user.email?.trim().toLowerCase() === email) ?? null;
}

export function missingPortalUsers(portalUsers: readonly StaticUser[], zohoUsers: readonly User[]): StaticUser[] {
  return portalUsers.filter((portalUser) => !matchPortalUserToZohoUser(portalUser, zohoUsers));
}

function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyStaticCredentials(username: string, password: string): StaticUser | null {
  const user = STATIC_USERS.find((candidate) => candidate.username === username.trim().toLowerCase());
  if (!user) {
    for (const candidate of STATIC_USERS) constantTimeEqual(password, process.env[candidate.passwordEnv] ?? "");
    return null;
  }
  return constantTimeEqual(password, process.env[user.passwordEnv] ?? "") ? user : null;
}
