import "server-only";
import { env, ZOHO_HOSTS } from "@/lib/env";

/** Server-side Zoho CRM client. Tokens never leave the server. */
export class ZohoError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "ZohoError";
  }
}

const hosts = () => {
  const e = env();
  return { ...ZOHO_HOSTS[e.ZOHO_DC], api: e.ZOHO_API_BASE_URL ?? ZOHO_HOSTS[e.ZOHO_DC].api };
};
const API_VERSION = "v6";

const g = globalThis as unknown as { __atplZohoToken?: { value: string; exp: number }; __atplZohoRefresh?: Promise<string> };

async function refreshAccessToken(): Promise<string> {
  const e = env();
  const body = new URLSearchParams({
    refresh_token: e.ZOHO_REFRESH_TOKEN!, client_id: e.ZOHO_CLIENT_ID!,
    client_secret: e.ZOHO_CLIENT_SECRET!, grant_type: "refresh_token",
  });
  const res = await fetch(`${hosts().accounts}/oauth/v2/token`, {
    method: "POST", body, cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) throw new ZohoError(`Zoho token refresh failed: ${json.error ?? res.status}`, res.status);
  // Zoho limits how many access tokens can be minted, so cache until shortly before expiry.
  g.__atplZohoToken = { value: json.access_token, exp: Date.now() + ((json.expires_in ?? 3600) - 120) * 1000 };
  return json.access_token;
}

async function accessToken(force = false): Promise<string> {
  const t = g.__atplZohoToken;
  if (!force && t && t.exp > Date.now()) return t.value;
  // De-duplicate concurrent refreshes.
  g.__atplZohoRefresh ??= refreshAccessToken().finally(() => { g.__atplZohoRefresh = undefined; });
  return g.__atplZohoRefresh;
}

type Query = Record<string, string | number | undefined>;

export async function zoho<T = unknown>(
  method: "GET" | "POST" | "PUT",
  path: string,
  opts: { query?: Query; body?: unknown } = {},
  retried = false,
): Promise<T | null> {
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

  if (res.status === 204) return null;
  if (res.status === 401 && !retried) return zoho<T>(method, path, opts, true);

  const json = (await res.json().catch(() => null)) as (T & { code?: string; message?: string }) | null;
  if (!res.ok) {
    throw new ZohoError(
      res.status === 429 ? "Zoho API rate limit reached. Please retry shortly." : json?.message ?? `Zoho request failed (${res.status})`,
      res.status, json?.code,
    );
  }
  return json;
}

type WriteResult = { data: { code: string; message?: string; details?: { id?: string } }[] };

/** POST/PUT wrapper that fails if ANY record in the response is not SUCCESS, and returns the first id. */
export async function zohoWrite(method: "POST" | "PUT", path: string, record: unknown): Promise<string> {
  const json = await zoho<WriteResult>(method, path, { body: { data: [record] } });
  const first = json?.data?.[0];
  if (!first || first.code !== "SUCCESS") {
    throw new ZohoError(first?.message ?? "Zoho rejected the change", undefined, first?.code);
  }
  return first.details?.id ?? "";
}

type Page<R> = { data?: R[]; info?: { more_records?: boolean } };

/** Fetch up to `max` records of a module, 200 per page, newest first. */
export async function zohoList<R>(module: string, fields: string[], max: number, extra: Query = {}): Promise<R[]> {
  const out: R[] = [];
  for (let page = 1; out.length < max; page++) {
    const json = await zoho<Page<R>>("GET", `/${module}`, {
      query: { fields: fields.join(","), per_page: 200, page, sort_by: "Created_Time", sort_order: "desc", ...extra },
    });
    out.push(...(json?.data ?? []));
    if (!json?.info?.more_records) break;
  }
  return out.slice(0, max);
}
