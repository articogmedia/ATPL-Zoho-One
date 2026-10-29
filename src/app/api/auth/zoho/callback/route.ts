import { NextResponse, type NextRequest } from "next/server";
import { crm } from "@/lib/crm";
import { env, ZOHO_HOSTS } from "@/lib/env";
import { createSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Step 2: verify state, exchange the code, read the person's Zoho email, and only let them in
 * if that email belongs to an ACTIVE Zoho CRM user with a role the portal recognises.
 * No passwords are stored anywhere in this app.
 */
export async function GET(req: NextRequest) {
  const e = env();
  const home = new URL(e.ZOHO_LOGIN_REDIRECT_URI ?? req.url).origin;
  const fail = (reason: string) => NextResponse.redirect(`${home}/?error=${reason}`);

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expected = req.cookies.get("atpl_oauth_state")?.value;
  if (e.AUTH_MODE !== "zoho" || !code || !state || !expected || state !== expected) return fail("state");

  try {
    const accounts = ZOHO_HOSTS[e.ZOHO_DC].accounts;
    const tokenRes = await fetch(`${accounts}/oauth/v2/token`, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({
        grant_type: "authorization_code", code, client_id: e.ZOHO_LOGIN_CLIENT_ID!,
        client_secret: e.ZOHO_LOGIN_CLIENT_SECRET!, redirect_uri: e.ZOHO_LOGIN_REDIRECT_URI!,
      }),
    });
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) return fail("token");

    const infoRes = await fetch(`${accounts}/oauth/user/info`, {
      headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    const info = (await infoRes.json()) as { Email?: string };
    if (!info.Email) return fail("profile");

    const user = await crm().findUserByEmail(info.Email);
    if (!user) return fail("no_access");

    await createSession(user);
    const res = NextResponse.redirect(`${home}/home`);
    res.cookies.delete({ name: "atpl_oauth_state", path: "/api/auth/zoho" });
    return res;
  } catch (err) {
    console.error("Zoho sign-in failed", err);
    return fail("server");
  }
}
