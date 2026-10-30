import "server-only";
import { z } from "zod";

const schema = z
  .object({
    DATA_SOURCE: z.enum(["mock", "zoho"]).default("mock"),
    AUTH_MODE: z.enum(["demo", "zoho"]).default("demo"),
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    ALLOW_DEMO_LOGIN_IN_PRODUCTION: z.enum(["true", "false"]).default("false"),

    ZOHO_DC: z.enum(["in", "com", "eu", "au"]).default("in"),
    ZOHO_SANDBOX: z.enum(["true", "false"]).default("false"),
    ZOHO_API_BASE_URL: z.string().url().optional(),
    ZOHO_CLIENT_ID: z.string().optional(),
    ZOHO_CLIENT_SECRET: z.string().optional(),
    ZOHO_REFRESH_TOKEN: z.string().optional(),
    /** "Sign in with Zoho" uses its own Server-based client (separate from the data/self client above). */
    ZOHO_LOGIN_CLIENT_ID: z.string().optional(),
    ZOHO_LOGIN_CLIENT_SECRET: z.string().optional(),
    ZOHO_LOGIN_REDIRECT_URI: z.string().url().optional(),
    /** CRM user that owns unassigned (fresh) leads, e.g. the calling-team lead. */
    ZOHO_QUEUE_OWNER_ID: z.string().optional(),
    ZOHO_MAX_LEADS: z.coerce.number().int().min(200).max(5000).default(1000),
  })
  .superRefine((e, ctx) => {
    const need = (keys: (keyof typeof e)[], why: string) =>
      keys.forEach((k) => {
        if (!e[k]) ctx.addIssue({ code: "custom", path: [k], message: `${String(k)} is required when ${why}` });
      });
    if (e.DATA_SOURCE === "zoho") need(["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"], "DATA_SOURCE=zoho");
    if (e.DATA_SOURCE === "zoho" && process.env.NODE_ENV !== "production" && e.ZOHO_SANDBOX !== "true") {
      ctx.addIssue({
        code: "custom",
        path: ["ZOHO_SANDBOX"],
        message: "Refusing to connect to production Zoho CRM in development. Set ZOHO_SANDBOX=true.",
      });
    }
    if (e.AUTH_MODE === "zoho") need(["ZOHO_LOGIN_CLIENT_ID", "ZOHO_LOGIN_CLIENT_SECRET", "ZOHO_LOGIN_REDIRECT_URI"], "AUTH_MODE=zoho");
    if (
      e.AUTH_MODE === "demo" &&
      e.DATA_SOURCE === "zoho" &&
      process.env.NODE_ENV === "production" &&
      !(e.ALLOW_DEMO_LOGIN_IN_PRODUCTION === "true" && e.ZOHO_SANDBOX === "true")
    ) {
      ctx.addIssue({
        code: "custom", path: ["AUTH_MODE"],
        message: "Demo login with live Zoho data in production requires ALLOW_DEMO_LOGIN_IN_PRODUCTION=true and ZOHO_SANDBOX=true",
      });
    }
  });

let cached: z.infer<typeof schema> | undefined;

/** Validated environment. Fails fast with a readable message instead of a runtime surprise. */
export function env() {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${msg}`);
  }
  cached = parsed.data;
  return cached;
}

export const ZOHO_HOSTS = {
  in: { accounts: "https://accounts.zoho.in", api: "https://www.zohoapis.in" },
  com: { accounts: "https://accounts.zoho.com", api: "https://www.zohoapis.com" },
  eu: { accounts: "https://accounts.zoho.eu", api: "https://www.zohoapis.eu" },
  au: { accounts: "https://accounts.zoho.com.au", api: "https://www.zohoapis.com.au" },
} as const;
