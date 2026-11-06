import "server-only";
import { env, ZOHO_HOSTS } from "@/lib/env";
import { newErrorReference } from "@/lib/crm-action-errors";

/** Server-side Zoho CRM client. Tokens never leave the server. */
export class ZohoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly field?: string,
    readonly invalidValue?: unknown,
    readonly operation?: string,
    readonly details?: Record<string, unknown>,
    readonly reference?: string,
  ) {
    super(message);
    this.name = "ZohoError";
  }
}

const hostLog = globalThis as unknown as { __atplZohoHostLogged?: boolean };

export const hosts = () => {
  const e = env();
  const configuredDomain = e.ZOHO_API_DOMAIN
    ? e.ZOHO_API_DOMAIN.includes("://") ? e.ZOHO_API_DOMAIN : `https://${e.ZOHO_API_DOMAIN}`
    : undefined;
  const configuredApi = configuredDomain ?? e.ZOHO_API_BASE_URL ?? ZOHO_HOSTS[e.ZOHO_DC].api;
  const api = e.ZOHO_SANDBOX === "true"
    ? configuredApi.replace("://www.zohoapis.", "://sandbox.zohoapis.").replace("://zohoapis.", "://sandbox.zohoapis.")
    : configuredApi;
  const resolved = {
    ...ZOHO_HOSTS[e.ZOHO_DC],
    accounts: e.ZOHO_ACCOUNTS_URL ?? ZOHO_HOSTS[e.ZOHO_DC].accounts,
    api,
  };
  if (!hostLog.__atplZohoHostLogged) {
    console.info(`[zoho] ${e.ZOHO_SANDBOX === "true" ? "using SANDBOX" : "using PRODUCTION"} hosts`, {
      dataCenter: e.ZOHO_DC,
      api: resolved.api,
      accounts: resolved.accounts,
    });
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
  let res: Response;
  try {
    res = await fetch(`${hosts().accounts}/oauth/v2/token`, {
      method: "POST", body, cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const reference = newErrorReference();
    console.error("[zoho] token refresh transport failed", {
      reference,
      operation: "POST /oauth/v2/token",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw new ZohoError(
      "Could not connect to the Zoho OAuth service.",
      undefined, "TOKEN_REFRESH_NETWORK_ERROR", undefined, undefined,
      "POST /oauth/v2/token",
      { cause: error instanceof Error ? error.message : String(error) },
      reference,
    );
  }
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string; expires_in?: number; error?: string; error_description?: string;
    code?: string; message?: string; details?: Record<string, unknown>; field?: string;
  };
  console.info(`[zoho] token ${res.status} ${Date.now() - started}ms`);
  if (!res.ok || !json.access_token) {
    const message = json.error_description ?? json.message ?? json.error ?? `Zoho token refresh failed (${res.status})`;
    console.error("[zoho] token refresh rejected", {
      status: res.status, code: json.code ?? json.error,
      message, details: json.details, field: json.field,
    });
    throw new ZohoError(message, res.status, json.code ?? json.error, json.field, undefined, "POST /oauth/v2/token", json.details);
  }
  const lifetimeMs = Math.max(60_000, ((json.expires_in ?? 3600) - 120) * 1000);
  return { value: json.access_token, exp: Date.now() + lifetimeMs };
}

async function accessToken(force = false): Promise<string> {
  if (force) g.__atplZohoToken = undefined;
  const cached = g.__atplZohoToken;
  if (!force && cached && cached.exp > Date.now()) return cached.value;
  // De-duplicate concurrent refreshes.
  g.__atplZohoRefresh ??= (async () => {
    const fresh = await requestAccessToken();
    g.__atplZohoToken = fresh;
    return fresh.value;
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
  correlationReference?: string,
): Promise<T | null> {
  const started = Date.now();
  const url = new URL(`${hosts().api}/crm/${API_VERSION}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const requestPath = `${path}${url.search}`;
  const operation = `${method} ${requestPath}`;

  const token = await accessToken(retried);
  let res: Response;
  try {
    res = await fetch(url, {
      method, cache: "no-store", signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (error) {
    const reference = correlationReference ?? newErrorReference();
    const message = error instanceof Error ? error.message : String(error);
    console.error("[zoho] request transport failed", {
      reference, method, path: requestPath, status: undefined,
      message, stack: error instanceof Error ? error.stack : undefined,
      payload: redactWritePayload(opts.body),
    });
    throw new ZohoError(
      "Could not connect to the Zoho CRM API.",
      undefined, "NETWORK_ERROR", undefined, undefined, operation,
      { cause: message }, reference,
    );
  }
  console.info(`[zoho] ${method} ${path} ${res.status} ${Date.now() - started}ms`);

  if (res.status === 204) return null;
  const rawBody = await res.text();
  let parsedBody: unknown = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsedBody = null;
  }
  const json = parsedBody as (T & {
    code?: string;
    message?: string;
    details?: Record<string, unknown> & { api_name?: string; field?: string; param_name?: string; expected_data_type?: string; value?: unknown };
    data?: { status?: string; code?: string; message?: string; details?: Record<string, unknown> & { api_name?: string; field?: string; param_name?: string; expected_data_type?: string; value?: unknown } }[];
  }) | null;
  if (res.status === 429 && rateLimitAttempt < 2) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 4000) : 250 * 2 ** rateLimitAttempt;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return zoho<T>(method, path, opts, retried, rateLimitAttempt + 1, correlationReference);
  }
  const responseCode = json?.data?.[0]?.code ?? json?.code;
  const tokenExpired = responseCode === "INVALID_TOKEN" || responseCode === "INVALID_OAUTHTOKEN";
  const shouldRetryToken = !retried && (tokenExpired || (res.status === 401 && responseCode !== "OAUTH_SCOPE_MISMATCH" && responseCode !== "NO_PERMISSION"));
  const rawResponseBody = parsedBody ? redactWritePayload(parsedBody) : rawBody;
  if (shouldRetryToken) {
    const reference = correlationReference ?? newErrorReference();
    const recordError = json?.data?.[0];
    const detail = recordError?.details ?? json?.details;
    console.error("[zoho] token rejected; retrying request once", {
      reference, method, path: requestPath, status: res.status,
      code: recordError?.code ?? json?.code,
      message: recordError?.message ?? json?.message,
      details: detail,
      api_name: detail?.api_name,
      param_name: detail?.param_name,
      expected_data_type: detail?.expected_data_type,
      rawResponseBody,
      payload: redactWritePayload(opts.body),
    });
    return zoho<T>(method, path, opts, true, rateLimitAttempt, reference);
  }
  if (!res.ok || tokenExpired) {
    const reference = correlationReference ?? newErrorReference();
    const recordError = json?.data?.[0];
    const detail = recordError?.details ?? json?.details;
    const field = detail?.api_name ?? detail?.field ?? detail?.param_name;
    const code = recordError?.code ?? json?.code;
    const message = recordError?.message ?? json?.message;
    const responseDetails = {
      ...detail,
      rawResponseBody,
      expected_data_type: detail?.expected_data_type,
    };
    console.error("[zoho] request rejected", {
      reference, method, path: requestPath, status: res.status,
      code, message, details: responseDetails, field,
      param_name: detail?.param_name,
      expected_data_type: detail?.expected_data_type,
      rawResponseBody,
      payload: redactWritePayload(opts.body),
    });
    throw new ZohoError(
      res.status === 429 ? "Zoho API rate limit reached. Please retry shortly." : message ?? `Zoho request failed (${res.status})`,
      res.status, code, field, detail?.value, operation, responseDetails, reference,
    );
  }
  return json;
}

type WriteResult = {
  data: { status?: string; code: string; message?: string; details?: Record<string, unknown> & { id?: string; api_name?: string; param_name?: string; expected_data_type?: string; value?: unknown } }[];
};

function redactWritePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactWritePayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /^(mobile|phone)$/i.test(key) && item != null
        ? `******${String(item).replace(/\D/g, "").slice(-2)}`
        : redactWritePayload(item),
    ]));
  }
  return value;
}

/** POST/PUT wrapper that fails if ANY record in the response is not SUCCESS, and returns the first id. */
export async function zohoWrite(
  method: "POST" | "PUT",
  path: string,
  record: unknown,
  opts: { trigger?: string[] } = {},
): Promise<string> {
  const payload = { data: [record], ...(opts.trigger ? { trigger: opts.trigger } : {}) };
  let json: WriteResult | null;
  try {
    json = await zoho<WriteResult>(method, path, { body: payload });
  } catch (error) {
    const reference = error instanceof ZohoError && error.reference
      ? error.reference
      : newErrorReference();
    const details = error instanceof ZohoError ? error.details : undefined;
    console.error("[zoho] write request failed", {
      reference, method, path,
      status: error instanceof ZohoError ? error.status : undefined,
      code: error instanceof ZohoError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
      details,
      api_name: details?.api_name ?? (error instanceof ZohoError ? error.field : undefined),
      expected_data_type: details?.expected_data_type,
      payload: redactWritePayload(payload),
    });
    if (error instanceof ZohoError) {
      throw new ZohoError(error.message, error.status, error.code, error.field, error.invalidValue, error.operation, error.details, reference);
    }
    throw new ZohoError(
      error instanceof Error ? error.message : "Zoho write request failed",
      undefined, undefined, undefined, undefined, `${method} ${path}`, undefined, reference,
    );
  }
  const first = json?.data?.[0];
  if (!first || first.status === "error" || first.code !== "SUCCESS") {
    const message = first?.message ?? "Zoho rejected the change";
    const apiName = first?.details?.api_name;
    const reference = newErrorReference();
    console.error("[zoho] write rejected", {
      reference, method, path, status: 200, recordStatus: first?.status,
      code: first?.code, message, details: first?.details,
      api_name: apiName, param_name: first?.details?.param_name,
      expected_data_type: first?.details?.expected_data_type,
      rawResponseBody: redactWritePayload(json),
      response: redactWritePayload(json),
      payload: redactWritePayload(payload),
    });
    throw new ZohoError(
      apiName ? `${message} (field: ${apiName})` : message,
      200,
      first?.code,
      apiName,
      first?.details?.value,
      `${method} ${path}`,
      first?.details,
      reference,
    );
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
