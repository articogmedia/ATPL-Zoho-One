import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import type { Role, User } from "@/lib/domain";
import { env } from "@/lib/env";

export const SESSION_COOKIE = "atpl_session";
const MAX_AGE_SECONDS = 8 * 60 * 60; // one working day

export type SessionClaims = { uid: string; username: string; name: string; role: Role; zohoUserId: string; lastActivity: number };

const key = () => new TextEncoder().encode(env().SESSION_SECRET);

export async function createSession(user: User, username = user.name.toLowerCase()) {
  const now = Date.now();
  const token = await new SignJWT({ username, name: user.name, role: user.role, zohoUserId: user.id, lastActivity: now } satisfies Omit<SessionClaims, "uid">)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(key());

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export async function readSession(): Promise<SessionClaims | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    const role = payload.role;
    if (role !== "Manager" && role !== "Sales Executive" && role !== "Calling Team") return null;
    const zohoUserId = String(payload.zohoUserId ?? payload.sub);
    const lastActivity = Number(payload.lastActivity ?? (Number(payload.iat ?? 0) * 1000));
    const inactivityMs = env().SESSION_INACTIVITY_MINUTES * 60_000;
    if (!Number.isFinite(lastActivity) || Date.now() - lastActivity > inactivityMs) return null;
    return { uid: String(payload.sub), username: String(payload.username ?? ""), name: String(payload.name), role, zohoUserId, lastActivity };
  } catch {
    return null;
  }
}

export async function destroySession() {
  (await cookies()).delete(SESSION_COOKIE);
}
