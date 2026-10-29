import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import type { Role, User } from "@/lib/domain";
import { env } from "@/lib/env";

export const SESSION_COOKIE = "atpl_session";
const MAX_AGE_SECONDS = 8 * 60 * 60; // one working day

export type SessionClaims = { uid: string; name: string; role: Role };

const key = () => new TextEncoder().encode(env().SESSION_SECRET);

export async function createSession(user: User) {
  const token = await new SignJWT({ name: user.name, role: user.role } satisfies Omit<SessionClaims, "uid">)
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
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function readSession(): Promise<SessionClaims | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return { uid: String(payload.sub), name: String(payload.name), role: payload.role as Role };
  } catch {
    return null;
  }
}

export async function destroySession() {
  (await cookies()).delete(SESSION_COOKIE);
}
