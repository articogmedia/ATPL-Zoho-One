import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify, SignJWT } from "jose";

/**
 * First line of defence: unauthenticated visitors never reach app pages.
 * (Pages and server actions re-check the user and role; this is not the only gate.)
 */
export async function middleware(req: NextRequest) {
  const isPrefetch = req.headers.has("next-router-prefetch") ||
    req.headers.get("purpose") === "prefetch" ||
    req.headers.get("sec-purpose")?.includes("prefetch");
  if (isPrefetch) return NextResponse.next();
  const token = req.cookies.get("atpl_session")?.value;
  const secret = process.env.SESSION_SECRET;
  if (token && secret) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
      const lastActivity = Number(payload.lastActivity ?? (Number(payload.iat ?? 0) * 1000));
      const inactivityMinutes = Number(process.env.SESSION_INACTIVITY_MINUTES ?? 30);
      if (!Number.isFinite(lastActivity) || Date.now() - lastActivity > inactivityMinutes * 60_000) {
        const response = req.nextUrl.pathname.startsWith("/api/")
          ? NextResponse.json({ error: "Session expired" }, { status: 401 })
          : NextResponse.redirect(new URL("/login?expired=1", req.url));
        response.cookies.delete({ name: "atpl_session", path: "/" });
        return response;
      }
      const response = NextResponse.next();
      response.headers.set("Cache-Control", "private, no-store, max-age=0");
      const issuedAt = Number(payload.iat ?? 0) * 1000;
      if (Date.now() - issuedAt >= 3 * 60_000) {
        const refreshed = await new SignJWT({
          username: payload.username, name: payload.name, role: payload.role,
          zohoUserId: payload.zohoUserId ?? payload.sub, lastActivity: Date.now(),
          sessionVersion: payload.sessionVersion ?? 0,
        }).setProtectedHeader({ alg: "HS256" })
          .setSubject(String(payload.sub))
          .setIssuedAt()
          .setExpirationTime("8h")
          .sign(new TextEncoder().encode(secret));
        response.cookies.set("atpl_session", refreshed, {
          httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/",
        });
      }
      return response;
    } catch {
      /* Fall through to the appropriate unauthenticated response below. */
    }
  }
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  matcher: [
    "/home/:path*", "/leads/:path*", "/quotations/:path*", "/visits/:path*", "/performance/:path*",
    "/api/admin/:path*", "/api/leads/:path*", "/api/quotations/:path*", "/api/warm",
  ],
};
