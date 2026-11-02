import { timingSafeEqual } from "node:crypto";
import type { Role, User } from "@/lib/domain";

export type StaticRole = "Manager" | "Sales" | "Caller";
export type StaticUser = {
  username: string;
  name: string;
  role: StaticRole;
  zohoUserId: string;
  passwordEnv: string;
};

export const STATIC_USERS: readonly StaticUser[] = [
  { username: "reshma", name: "Reshma", role: "Manager", zohoUserId: "REPLACE_RESHMA_ZOHO_USER_ID", passwordEnv: "ATPL_RESHMA_PASSWORD" },
  { username: "pavan", name: "Pavan", role: "Sales", zohoUserId: "REPLACE_PAVAN_ZOHO_USER_ID", passwordEnv: "ATPL_PAVAN_PASSWORD" },
  { username: "saikiran", name: "Saikiran", role: "Sales", zohoUserId: "REPLACE_SAIKIRAN_ZOHO_USER_ID", passwordEnv: "ATPL_SAIKIRAN_PASSWORD" },
];

export function portalRole(role: StaticRole): Role {
  return role === "Manager" ? "Manager" : role === "Sales" ? "Sales Executive" : "Calling Team";
}

export function staticUserAsPortalUser(user: StaticUser): User {
  return { id: user.zohoUserId, name: user.name, role: portalRole(user.role) };
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
