import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { hosts } from "@/lib/zoho/client";

export const dynamic = "force-dynamic";

/** Step 1 of "Sign in with Zoho": send the browser to Zoho with an anti-CSRF state value. */
export async function GET() {
  const e = env();
  if (e.AUTH_MODE !== "zoho") return NextResponse.redirect(new URL("/", e.ZOHO_LOGIN_REDIRECT_URI ?? "http://localhost:3000"));

  const state = randomBytes(24).toString("hex");
  const url = new URL(`${hosts().accounts}/oauth/v2/auth`);
  url.search = new URLSearchParams({
    scope: "AaaServer.profile.READ",
    client_id: e.ZOHO_LOGIN_CLIENT_ID!,
    response_type: "code",
    access_type: "online",
    redirect_uri: e.ZOHO_LOGIN_REDIRECT_URI!,
    state,
  }).toString();

  const res = NextResponse.redirect(url);
  res.cookies.set("atpl_oauth_state", state, {
    httpOnly: true, sameSite: "lax", path: "/api/auth/zoho", maxAge: 600, secure: process.env.NODE_ENV === "production",
  });
  return res;
}
