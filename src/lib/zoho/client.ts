import "server-only";
import { randomUUID } from "node:crypto";
import { env, ZOHO_HOSTS } from "@/lib/env";
import { newErrorReference } from "@/lib/crm-action-errors";
import { logPerf } from "@/lib/perf-log";

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
export const ZOHO_CRM_API_VERSION = "v6";

function perfPath(path: string) {
  return path.replace(/\/(?:\d{6,}|[a-f0-9-]{20,})(?=\/|$)/gi, "/:id");
}

function missingFieldDetails(details?: Record<string, unknown>) {
  return {
    api_name: details?.api_name,
    json_path: details?.json_path,
    dependee: details?.dependee,
    expected_data_type: details?.expected_data_type,
  };
}

function writePayloadKeys(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  const record = Array.isArray(data) ? data[0] : undefined;
  return record && typeof record === "object" ? Object.keys(record) : [];
}

function writeModule(path: string): string | undefined {
  return /^\/(Calls|Leads)(?:\/|$)/.exec(path)?.[1];
}

const g = globalThis as unknown as {
  __atplZohoToken?: { value: string; exp: number };
  __atplZohoRefresh?: Promise<string>;
  __atplZohoRefreshBlocked?: { until: number; error: ZohoError };
  __atplZohoRedisWarningLogged?: boolean;
  __atplZohoRedisUnavailableUntil?: number;
  __atplZohoRequestCount?: number;
};

export function zohoRuntimeStatus() {
  const sharedTokenStoreConfigured = Boolean(redisConfig());
  const warning = process.env.NODE_ENV === "production" && !sharedTokenStoreConfigured
    ? "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not configured; Zoho token sharing and shared caching are unavailable."
    : undefined;
  if (warning && !g.__atplZohoRedisWarningLogged) {
    console.warn("[zoho] shared token store is not configured in production", {
      warning,
      retryTimeoutMs: 3_000,
    });
    g.__atplZohoRedisWarningLogged = true;
  }
  return { sharedTokenStoreConfigured, warning };
}

zohoRuntimeStatus();

function refreshFailure(error: unknown): { delay: number; message: string; code: string } | null {
  const zohoError = error instanceof ZohoError ? error : undefined;
  const code = zohoError?.code?.toLowerCase() ?? "";
  const message = error instanceof Error ? error.message : String(error);
  const reason = `${code} ${message}`.toLowerCase();
  if (zohoError && (zohoError.status === 429 || reason.includes("too many requests"))) {
    return {
      delay: 30_000,
      message: "Zoho is temporarily limiting token refresh. Please retry shortly.",
      code: "TOKEN_REFRESH_RATE_LIMITED",
    };
  }
  if (zohoError && (code === "invalid_client" || reason.includes("invalid_client") || reason.includes("access denied"))) {
    return {
      delay: 60_000,
      message: "Zoho token is blocked, retry in 1 minute.",
      code: code === "invalid_client" || reason.includes("invalid_client") ? "TOKEN_REFRESH_INVALID_CLIENT" : "TOKEN_REFRESH_ACCESS_DENIED",
    };
  }
  if (zohoError && (code === "invalid_token" || code === "invalid_oauthtoken" || reason.includes("invalid token"))) {
    return {
      delay: 60_000,
      message: "Zoho token is blocked, retry in 1 minute.",
      code: "TOKEN_REFRESH_INVALID_TOKEN",
    };
  }
  return null;
}

async function requestAccessToken(timeoutMs = 15_000): Promise<{ value: string; exp: number }> {
  const started = Date.now();
  const e = env();
  const body = new URLSearchParams({
    refresh_token: e.ZOHO_REFRESH_TOKEN!, client_id: e.ZOHO_CLIENT_ID!,
    client_secret: e.ZOHO_CLIENT_SECRET!, grant_type: "refresh_token",
  });
  let res: Response;
  try {
    res = await fetch(`${hosts().accounts}/oauth/v2/token`, {
      method: "POST", body, cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    logPerf("token_refresh", Date.now() - started, { status: null });
    const reference = newErrorReference();
    const zohoHosts = hosts();
    console.error("[zoho] token refresh transport failed", {
      reference,
      operation: "POST /oauth/v2/token",
      elapsedMs: Date.now() - started,
      apiHost: zohoHosts.api,
      environment: e.ZOHO_SANDBOX === "true" ? "sandbox" : "live",
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      cause: error instanceof Error ? error.cause : undefined,
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw new ZohoError(
      /timeout|timed out|abort/i.test(error instanceof Error ? error.message : String(error))
        ? "Zoho timed out, please try again"
        : "Could not connect to the Zoho OAuth service.",
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
  logPerf("token_refresh", Date.now() - started, { status: res.status });
  console.info(`[zoho] token ${res.status} ${Date.now() - started}ms`);
  if (!res.ok || !json.access_token) {
    const message = json.error_description ?? json.message ?? json.error ?? `Zoho token refresh failed (${res.status})`;
    const reference = newErrorReference();
    const zohoHosts = hosts();
    console.error("[zoho] token refresh rejected", {
      reference,
      status: res.status,
      code: json.code ?? json.error,
      errorName: "ZohoOAuthError",
      message,
      cause: json.details,
      elapsedMs: Date.now() - started,
      apiHost: zohoHosts.api,
      environment: e.ZOHO_SANDBOX === "true" ? "sandbox" : "live",
      details: json.details,
      field: json.field,
    });
    throw new ZohoError(message, res.status, json.code ?? json.error, json.field, undefined, "POST /oauth/v2/token", json.details, reference);
  }
  const lifetimeMs = Math.max(60_000, ((json.expires_in ?? 3600) - 300) * 1000);
  return { value: json.access_token, exp: Date.now() + lifetimeMs };
}

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/$/, ""), token } : undefined;
}

function sharedTokenKeys() {
  const e = env();
  const key = `atpl:zoho:${e.ZOHO_CLIENT_ID}:${new URL(hosts().api).hostname}`;
  return { token: `${key}:access-token`, lock: `${key}:refresh-lock`, blocked: `${key}:refresh-blocked` };
}

async function redisCommand(args: string[]): Promise<unknown | undefined> {
  const config = redisConfig();
  if (!config || (g.__atplZohoRedisUnavailableUntil ?? 0) > Date.now()) return undefined;
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) throw new Error(`Upstash REST request returned ${response.status}`);
    const result = await response.json() as { result?: unknown; error?: string };
    if (result.error) throw new Error(result.error);
    return result.result;
  } catch (error) {
    g.__atplZohoRedisUnavailableUntil = Date.now() + 60_000;
    if (!g.__atplZohoRedisWarningLogged) {
      console.error("[zoho] shared token store unavailable; using instance-local token cache", {
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      });
      g.__atplZohoRedisWarningLogged = true;
    }
    return undefined;
  }
}

async function sharedToken(): Promise<{ value: string; exp: number } | undefined> {
  if (!redisConfig()) return undefined;
  const { token } = sharedTokenKeys();
  const result = await redisCommand(["GET", token]);
  if (typeof result !== "string") return undefined;
  try {
    const parsed = JSON.parse(result) as { value?: unknown; exp?: unknown };
    return typeof parsed.value === "string" && typeof parsed.exp === "number" && parsed.exp > Date.now()
      ? { value: parsed.value, exp: parsed.exp }
      : undefined;
  } catch {
    return undefined;
  }
}

async function sharedBlockedError(): Promise<ZohoError | undefined> {
  if (!redisConfig()) return undefined;
  const { blocked } = sharedTokenKeys();
  const result = await redisCommand(["GET", blocked]);
  if (typeof result !== "string") return undefined;
  try {
    const entry = JSON.parse(result) as { until?: unknown; message?: unknown; code?: unknown; status?: unknown; reference?: unknown };
    if (typeof entry.until !== "number" || entry.until <= Date.now() || typeof entry.message !== "string") return undefined;
    const message = entry.code === "TOKEN_REFRESH_RATE_LIMITED"
      ? "Zoho is temporarily limiting token refresh. Please retry shortly."
      : entry.message;
    return new ZohoError(
      message,
      typeof entry.status === "number" ? entry.status : undefined,
      typeof entry.code === "string" ? entry.code : "TOKEN_REFRESH_BLOCKED",
      undefined, undefined, "POST /oauth/v2/token", undefined,
      typeof entry.reference === "string" ? entry.reference : undefined,
    );
  } catch {
    return undefined;
  }
}

async function saveSharedToken(token: { value: string; exp: number }) {
  if (!redisConfig()) return;
  const { token: tokenKey, blocked } = sharedTokenKeys();
  const ttlSeconds = Math.max(60, Math.ceil((token.exp - Date.now()) / 1000));
  await redisCommand(["SET", tokenKey, JSON.stringify(token), "EX", String(ttlSeconds)]);
  await redisCommand(["DEL", blocked]);
}

async function releaseSharedLock(key: string, value: string) {
  await redisCommand([
    "EVAL",
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
    "1", key, value,
  ]);
}

async function requestSharedAccessToken(rejectedToken?: string): Promise<{ value: string; exp: number }> {
  if (process.env.NODE_ENV === "production" && !redisConfig()) {
    return requestAccessToken(3_000);
  }
  const refreshWithRateLimitRetry = async () => {
    try {
      return await requestAccessToken();
    } catch (error) {
      if (!(error instanceof ZohoError) || error.status !== 429) throw error;
      const anotherInstanceToken = await sharedToken();
      if (anotherInstanceToken && (!rejectedToken || anotherInstanceToken.value !== rejectedToken)) {
        return anotherInstanceToken;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000 + Math.floor(Math.random() * 2_001)));
      const token = await requestAccessToken();
      await saveSharedToken(token);
      return token;
    }
  };
  if (!redisConfig()) return refreshWithRateLimitRetry();
  const keys = sharedTokenKeys();
  const endAt = Date.now() + 12_000;
  while (Date.now() < endAt) {
    const cached = await sharedToken();
    if (cached && (!rejectedToken || cached.value !== rejectedToken)) return cached;
    const blocked = await sharedBlockedError();
    if (blocked) throw blocked;

    const lockValue = randomUUID();
    const acquired = await redisCommand(["SET", keys.lock, lockValue, "NX", "EX", "15"]);
    if (acquired === undefined) return requestAccessToken();
    if (acquired === "OK") {
      try {
        const latest = await sharedToken();
        if (latest && (!rejectedToken || latest.value !== rejectedToken)) return latest;
        const token = await refreshWithRateLimitRetry();
        await saveSharedToken(token);
        return token;
      } catch (error) {
        const policy = refreshFailure(error);
        if (policy) {
          const original = error instanceof ZohoError ? error : undefined;
          const reference = original?.reference ?? newErrorReference();
          await redisCommand(["SET", keys.blocked, JSON.stringify({
            until: Date.now() + policy.delay,
            message: policy.message,
            code: policy.code,
            status: original?.status,
            reference,
          }), "EX", String(Math.ceil(policy.delay / 1000))]);
        }
        throw error;
      } finally {
        await releaseSharedLock(keys.lock, lockValue);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new ZohoError(
    "Zoho token refresh is taking longer than expected. Please retry shortly.",
    undefined, "TOKEN_REFRESH_IN_PROGRESS", undefined, undefined, "POST /oauth/v2/token",
  );
}

async function accessToken(force = false, rejectedToken?: string): Promise<string> {
  const cached = g.__atplZohoToken;
  if (force && cached && cached.value !== rejectedToken && cached.exp > Date.now()) return cached.value;
  if (force && cached?.value === rejectedToken) g.__atplZohoToken = undefined;
  if (!force && cached && cached.exp > Date.now()) return cached.value;
  const shared = await sharedToken();
  if (shared && (!force || shared.value !== rejectedToken)) {
    g.__atplZohoToken = shared;
    return shared.value;
  }
  if (force && shared?.value === rejectedToken && redisConfig()) {
    await redisCommand(["DEL", sharedTokenKeys().token]);
  }
  const blocked = g.__atplZohoRefreshBlocked;
  if (blocked && blocked.until > Date.now()) {
    const message = blocked.error.code === "TOKEN_REFRESH_RATE_LIMITED"
      ? "Zoho is temporarily limiting token refresh. Please retry shortly."
      : blocked.error.message;
    throw new ZohoError(
      message,
      blocked.error.status, blocked.error.code, blocked.error.field, blocked.error.invalidValue,
      blocked.error.operation, blocked.error.details, blocked.error.reference,
    );
  }
  if (blocked) g.__atplZohoRefreshBlocked = undefined;
  const sharedBlock = await sharedBlockedError();
  if (sharedBlock) throw sharedBlock;
  if (!g.__atplZohoRefresh) {
    const refreshPromise = (async () => {
      try {
        const fresh = await requestSharedAccessToken(force ? rejectedToken : undefined);
        g.__atplZohoToken = fresh;
        g.__atplZohoRefreshBlocked = undefined;
        return fresh.value;
      } catch (error) {
        const policy = refreshFailure(error);
        if (!policy) throw error;
        const original = error instanceof ZohoError ? error : undefined;
        const reference = original?.reference ?? newErrorReference();
        const blockedError = new ZohoError(
          policy.message,
          original?.status, policy.code, original?.field, original?.invalidValue,
          "POST /oauth/v2/token", original?.details, reference,
        );
        g.__atplZohoToken = undefined;
        g.__atplZohoRefreshBlocked = { until: Date.now() + policy.delay, error: blockedError };
        console.error("[zoho] token refresh blocked", {
          reference,
          code: policy.code,
          blockedForMs: policy.delay,
          message: policy.message,
        });
        throw blockedError;
      }
    })();
    g.__atplZohoRefresh = refreshPromise;
    void refreshPromise.then(
      () => {
        if (g.__atplZohoRefresh === refreshPromise) g.__atplZohoRefresh = undefined;
      },
      () => {
        if (g.__atplZohoRefresh === refreshPromise) g.__atplZohoRefresh = undefined;
      },
    );
  }
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
  networkRetryAttempt = 0,
  rejectedToken?: string,
): Promise<T | null> {
  const started = Date.now();
  const url = new URL(`${hosts().api}/crm/${ZOHO_CRM_API_VERSION}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const requestPath = `${path}${url.search}`;
  const operation = `${method} ${requestPath}`;
  const timingPath = perfPath(path);

  let token: string;
  try {
    token = await accessToken(retried, rejectedToken);
  } catch (error) {
    logPerf("zoho.request", Date.now() - started, { method, path: timingPath, status: null, retry: networkRetryAttempt });
    throw error;
  }
  let res: Response;
  const isLargeListGet = method === "GET" && /^\/(?:Products|Quotes|Leads)(?:\/search)?$/.test(path);
  const requestTimeoutMs = isLargeListGet ? 25_000 : method === "GET" ? 8_000 : 20_000;
  try {
    g.__atplZohoRequestCount = (g.__atplZohoRequestCount ?? 0) + 1;
    res = await fetch(url, {
      method, cache: "no-store", signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (error) {
    const reference = correlationReference ?? newErrorReference();
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error.cause : undefined;
    const causeCode = cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code ?? "")
      : undefined;
    const causeMessage = cause instanceof Error ? cause.message : "";
    const transportReason = `${message} ${causeCode ?? ""} ${causeMessage}`;
    const zohoHosts = hosts();
    const retryableNetworkError = /ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timeout|timed out|fetch failed|aborted/i.test(transportReason);
    const canRetryRequest = networkRetryAttempt < 1 && retryableNetworkError;
    console.error("[zoho] request transport failed", {
      reference, method, path: requestPath, status: undefined,
      elapsedMs: Date.now() - started,
      apiHost: zohoHosts.api,
      environment: env().ZOHO_SANDBOX === "true" ? "sandbox" : "live",
      errorName: error instanceof Error ? error.name : typeof error,
      message, cause, causeCode,
      retrying: canRetryRequest,
      stack: error instanceof Error ? error.stack : undefined,
      payload: redactWritePayload(opts.body),
    });
    if (canRetryRequest) {
      return zoho<T>(method, path, opts, retried, rateLimitAttempt, reference, networkRetryAttempt + 1, rejectedToken);
    }

    const timedOut = /timeout|timed out|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|aborted/i.test(transportReason);
    throw new ZohoError(
      timedOut ? "Zoho timed out, please try again" : "Could not connect to the Zoho CRM API.",
      undefined, timedOut ? "NETWORK_TIMEOUT" : "NETWORK_ERROR", undefined, undefined, operation,
      { cause: message }, reference,
    );
  }
  if (res.status === 204) {
    logPerf("zoho.request", Date.now() - started, { method, path: timingPath, status: res.status, retry: networkRetryAttempt });
    return null;
  }
  const rawBody = await res.text();
  logPerf("zoho.request", Date.now() - started, { method, path: timingPath, status: res.status, retry: networkRetryAttempt });
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
    return zoho<T>(method, path, opts, retried, rateLimitAttempt + 1, correlationReference, networkRetryAttempt, rejectedToken);
  }
  const responseCode = json?.data?.[0]?.code ?? json?.code;
  const tokenExpired = responseCode === "INVALID_TOKEN" || responseCode === "INVALID_OAUTHTOKEN";
  const shouldRetryToken = !retried && (tokenExpired || (res.status === 401 && responseCode !== "OAUTH_SCOPE_MISMATCH" && responseCode !== "NO_PERMISSION"));
  const rawResponseBody = parsedBody ? redactWritePayload(parsedBody) : rawBody;
  if (method === "GET" && res.status >= 500 && networkRetryAttempt < 1) {
    const reference = correlationReference ?? newErrorReference();
    console.warn("[zoho] retrying transient read response", {
      reference, method, path: requestPath, status: res.status, retrying: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    return zoho<T>(method, path, opts, retried, rateLimitAttempt, reference, networkRetryAttempt + 1, rejectedToken);
  }
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
    return zoho<T>(method, path, opts, true, rateLimitAttempt, reference, networkRetryAttempt, token);
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
    if (code === "DEPENDENT_FIELD_MISSING" || code === "REQUIRED_FIELD_MISSING") {
      console.error("[zoho] request rejected", {
        reference, method, path: requestPath, status: res.status,
        code, module: writeModule(path), payloadKeys: writePayloadKeys(opts.body),
        ...missingFieldDetails(detail),
      });
    } else {
      console.error("[zoho] request rejected", {
        reference, method, path: requestPath, status: res.status,
        code, message, details: responseDetails, field,
        api_name: detail?.api_name,
        json_path: detail?.json_path,
        param_name: detail?.param_name,
        expected_data_type: detail?.expected_data_type,
        rawResponseBody,
        payload: redactWritePayload(opts.body),
      });
    }
    throw new ZohoError(
      res.status === 429 ? "Zoho API rate limit reached. Please retry shortly." : message ?? `Zoho request failed (${res.status})`,
      res.status, code, field, detail?.value, operation, responseDetails, reference,
    );
  }
  return json;
}

export function zohoRequestCount(): number {
  return g.__atplZohoRequestCount ?? 0;
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
    if (error instanceof ZohoError && (error.code === "DEPENDENT_FIELD_MISSING" || error.code === "REQUIRED_FIELD_MISSING")) {
      console.error("[zoho] write request failed", {
        reference, method, path, status: error.status, code: error.code,
        module: writeModule(path), payloadKeys: writePayloadKeys(payload),
        ...missingFieldDetails(details),
      });
    } else {
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
    }
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
    if (first?.code === "DEPENDENT_FIELD_MISSING" || first?.code === "REQUIRED_FIELD_MISSING") {
      console.error("[zoho] write rejected", {
        reference, method, path, status: 200, recordStatus: first?.status,
        code: first?.code, module: writeModule(path), payloadKeys: writePayloadKeys(payload),
        ...missingFieldDetails(first?.details),
      });
    } else {
      console.error("[zoho] write rejected", {
        reference, method, path, status: 200, recordStatus: first?.status,
        code: first?.code, message, details: first?.details,
        api_name: apiName, param_name: first?.details?.param_name,
        json_path: first?.details?.json_path,
        expected_data_type: first?.details?.expected_data_type,
        rawResponseBody: redactWritePayload(json),
        response: redactWritePayload(json),
        payload: redactWritePayload(payload),
      });
    }
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
  console.info("[zoho] write confirmed", {
    method,
    path,
    status: 200,
    recordStatus: first.status,
    code: first.code,
    message: first.message,
    details: first.details,
    rawResponseBody: redactWritePayload(json),
    payload: redactWritePayload(payload),
  });
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
