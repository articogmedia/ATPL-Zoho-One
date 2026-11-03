import "server-only";
import { env, ZOHO_HOSTS } from "@/lib/env";
import { revalidateTag, unstable_cache } from "next/cache";

/** Server-side Zoho CRM client. Tokens never leave the server. */
export class ZohoError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "ZohoError";
  }
}

const hostLog = globalThis as unknown as { __atplZohoHostLogged?: boolean };

export const hosts = () => {
  const e = env();
  const api = e.ZOHO_API_BASE_URL ?? ZOHO_HOSTS[e.ZOHO_DC].api;
  const resolved = {
    ...ZOHO_HOSTS[e.ZOHO_DC],
    api: e.ZOHO_SANDBOX === "true" ? api.replace("://www.", "://sandbox.") : api,
  };
  if (!hostLog.__atplZohoHostLogged) {
    console.info(e.ZOHO_SANDBOX === "true" ? `[zoho] using SANDBOX host: ${resolved.api}` : "[zoho] using PRODUCTION host");
    hostLog.__atplZohoHostLogged = true;
  }
  return resolved;
};
const API_VERSION = "v6";

const g = globalThis as unknown as {
  __atplZohoToken?: { value: string; exp: number };
  __atplZohoRefresh?: Promise<string>;
};

async function requestAccessToken(): Promise<{ value: string; exp: number }> {
  const started = Date.now();
  const e = env();
  const body = new URLSearchParams({
    refresh_token: e.ZOHO_REFRESH_TOKEN!, client_id: e.ZOHO_CLIENT_ID!,
    client_secret: e.ZOHO_CLIENT_SECRET!, grant_type: "refresh_token",
  });
  const res = await fetch(`${hosts().accounts}/oauth/v2/token`, {
    method: "POST", body, cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  console.info(`[zoho] token ${res.status} ${Date.now() - started}ms`);
  if (!res.ok || !json.access_token) throw new ZohoError(`Zoho token refresh failed: ${json.error ?? res.status}`, res.status);
  const lifetimeMs = Math.max(60_000, ((json.expires_in ?? 3600) - 120) * 1000);
  return { value: json.access_token, exp: Date.now() + lifetimeMs };
}

const cachedAccessToken = unstable_cache(
  requestAccessToken,
  ["atpl", "zoho-access-token"],
  { revalidate: 3_480, tags: ["zoho-access-token"] },
);

async function refreshAccessToken(): Promise<string> {
  const token = await cachedAccessToken();
  g.__atplZohoToken = token;
  return token.value;
}

async function accessToken(force = false): Promise<string> {
  const t = g.__atplZohoToken;
  if (!force && t && t.exp > Date.now()) return t.value;
  if (force) revalidateTag("zoho-access-token");
  // De-duplicate concurrent refreshes.
  g.__atplZohoRefresh ??= (async () => {
    const cached = await cachedAccessToken();
    if (cached.exp > Date.now() + 1_000) {
      g.__atplZohoToken = cached;
      return cached.value;
    }
    revalidateTag("zoho-access-token");
    return refreshAccessToken();
  })().finally(() => { g.__atplZohoRefresh = undefined; });
  return g.__atplZohoRefresh;
}

export async function warmZohoToken(): Promise<void> {
  await accessToken();
}

type Query = Record<string, string | number | undefined>;

export async function zoho<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { query?: Query; body?: unknown } = {},
  retried = false,
  rateLimitAttempt = 0,
): Promise<T | null> {
  const started = Date.now();
  const url = new URL(`${hosts().api}/crm/${API_VERSION}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

  const res = await fetch(url, {
    method, cache: "no-store", signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Zoho-oauthtoken ${await accessToken(retried)}`,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  console.info(`[zoho] ${method} ${path} ${res.status} ${Date.now() - started}ms`);

  if (res.status === 204) return null;
  if (res.status === 401 && !retried) return zoho<T>(method, path, opts, true);

  const json = (await res.json().catch(() => null)) as (T & { code?: string; message?: string }) | null;
  if (res.status === 429 && rateLimitAttempt < 2) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 4000) : 250 * 2 ** rateLimitAttempt;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return zoho<T>(method, path, opts, retried, rateLimitAttempt + 1);
  }
  if (!res.ok) {
    throw new ZohoError(
      res.status === 429 ? "Zoho API rate limit reached. Please retry shortly." : json?.message ?? `Zoho request failed (${res.status})`,
      res.status, json?.code,
    );
  }
  return json;
}

type WriteResult = {
  data: { code: string; message?: string; details?: { id?: string; api_name?: string } }[];
};

/** POST/PUT wrapper that fails if ANY record in the response is not SUCCESS, and returns the first id. */
export async function zohoWrite(
  method: "POST" | "PUT",
  path: string,
  record: unknown,
  opts: { trigger?: string[] } = {},
): Promise<string> {
  const json = await zoho<WriteResult>(method, path, {
    body: { data: [record], ...(opts.trigger ? { trigger: opts.trigger } : {}) },
  });
  const first = json?.data?.[0];
  if (!first || first.code !== "SUCCESS") {
    const message = first?.message ?? "Zoho rejected the change";
    const apiName = first?.details?.api_name;
    throw new ZohoError(apiName ? `${message} (field: ${apiName})` : message, undefined, first?.code);
  }
  return first.details?.id ?? "";
}

type Page<R> = { data?: R[]; info?: { more_records?: boolean } };

/** Fetch up to `max` records of a module, 200 per page, newest first. */
export async function zohoList<R>(module: string, fields: string[], max: number, extra: Query = {}): Promise<R[]> {
  const out: R[] = [];
  if (max <= 0) return out;

  const fetchPage = (page: number) => zoho<Page<R>>("GET", `/${module}`, {
      query: { fields: fields.join(","), per_page: 200, page, sort_by: "Created_Time", sort_order: "desc", ...extra },
    });

  const first = await fetchPage(1);
  out.push(...(first?.data ?? []));
  let moreRecords = first?.info?.more_records === true;
  let page = 2;
  while (moreRecords && out.length < max) {
    const batchSize = Math.min(3, Math.ceil((max - out.length) / 200));
    const pages = await Promise.all(
      Array.from({ length: batchSize }, (_, index) => fetchPage(page + index)),
    );
    for (const json of pages) {
      out.push(...(json?.data ?? []));
      if (json?.info?.more_records !== true) {
        moreRecords = false;
        break;
      }
    }
    page += batchSize;
  }
  return out.slice(0, max);
}
