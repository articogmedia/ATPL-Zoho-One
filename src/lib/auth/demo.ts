import "server-only";
import { env } from "@/lib/env";
import { productionDemoLoginAllowed } from "./demo-policy";

/** Demo login is for development and client demos only; it is off in production unless explicitly allowed. */
export function demoLoginAllowed() {
  const e = env();
  return productionDemoLoginAllowed(
    process.env.NODE_ENV ?? "development",
    e.AUTH_MODE,
    e.ALLOW_DEMO_LOGIN === "true",
    e.ALLOW_DEMO_LOGIN_IN_PRODUCTION === "true",
  );
}
