import { NextResponse, type NextRequest } from "next/server";
import { crm } from "@/lib/crm";
import { env } from "@/lib/env";
import { createSession } from "@/lib/auth/session";
import { hosts, ZohoError } from "@/lib/zoho/client";

export const dynamic = "force-dynamic";

/**
 * Step 2: verify state, exchange the code, read the person's Zoho email, and only let them in
 * if that email belongs to an ACTIVE Zoho CRM user with a role the portal recognises.
 * No passwords are stored anywhere in this app.
 */
export async function GET(req: NextRequest) {
  const e = env();
  const home = new URL(e.ZOHO_LOGIN_REDIRECT_URI ?? req.url).origin;
  const fail = (reason: string) => NextResponse.redirect(`${home}/login?error=${reason}`);

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expected = req.cookies.get("atpl_oauth_state")?.value;
  if (e.AUTH_MODE !== "zoho" || !code || !state || !expected || state !== expected) return fail("state");

  try {
    const accounts = hosts().accounts;
    const tokenRes = await fetch(`${accounts}/oauth/v2/token`, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({
        grant_type: "authorization_code", code, client_id: e.ZOHO_LOGIN_CLIENT_ID!,
        client_secret: e.ZOHO_LOGIN_CLIENT_SECRET!, redirect_uri: e.ZOHO_LOGIN_REDIRECT_URI!,
      }),
    });
    const token = (await tokenRes.json()) as {
      access_token?: string; error?: string; error_description?: string; code?: string;
      message?: string; details?: Record<string, unknown>; field?: string;
    };
    if (!tokenRes.ok || !token.access_token) {
      console.error("[auth] Zoho authorization-code exchange rejected", {
        status: tokenRes.status, code: token.code ?? token.error,
        message: token.error_description ?? token.message ?? token.error,
        details: token.details, field: token.field,
      });
      return fail("token");
    }

    const infoRes = await fetch(`${accounts}/oauth/user/info`, {
      headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    const info = (await infoRes.json()) as {
      Email?: string; error?: string; error_description?: string; code?: string;
      message?: string; details?: Record<string, unknown>; field?: string;
    };
    if (!infoRes.ok || !info.Email) {
      console.error("[auth] Zoho user-info request rejected", {
        status: infoRes.status, code: info.code ?? info.error,
        message: info.error_description ?? info.message ?? info.error,
        details: info.details, field: info.field,
      });
      return fail("profile");
    }

    const user = await crm().findUserByEmail(info.Email);
    if (!user) return fail("no_access");

    await createSession(user);
    const res = NextResponse.redirect(`${home}/home`);
    res.cookies.delete({ name: "atpl_oauth_state", path: "/api/auth/zoho" });
    return res;
  } catch (err) {
    console.error("Zoho sign-in failed", {
      message: err instanceof Error ? err.message : String(err),
      status: err instanceof ZohoError ? err.status : undefined,
      code: err instanceof ZohoError ? err.code : undefined,
      field: err instanceof ZohoError ? err.field : undefined,
      details: err instanceof ZohoError ? err.details : undefined,
      operation: err instanceof ZohoError ? err.operation : undefined,
    });
    return fail("server");
  }
}
