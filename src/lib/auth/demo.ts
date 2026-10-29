import "server-only";
import { env } from "@/lib/env";

/** Demo login is for development and client demos only; it is off in production unless explicitly allowed. */
export function demoLoginAllowed() {
  const e = env();
  return e.AUTH_MODE === "demo" && (process.env.NODE_ENV !== "production" || e.ALLOW_DEMO_LOGIN_IN_PRODUCTION === "true");
}
