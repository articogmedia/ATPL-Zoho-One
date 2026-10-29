import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

/**
 * First line of defence: unauthenticated visitors never reach app pages.
 * (Pages and server actions re-check the user and role; this is not the only gate.)
 */
export async function middleware(req: NextRequest) {
  const token = req.cookies.get("atpl_session")?.value;
  const secret = process.env.SESSION_SECRET;
  if (token && secret) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
      return NextResponse.next();
    } catch {
      /* fall through to redirect */
    }
  }
  return NextResponse.redirect(new URL("/", req.url));
}

export const config = {
  matcher: ["/home/:path*", "/leads/:path*", "/quotations/:path*", "/visits/:path*", "/performance/:path*"],
};
