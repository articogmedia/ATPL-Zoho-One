import "server-only";
import { createHash } from "node:crypto";
import { after } from "next/server";
import { revalidateTag } from "next/cache";

type CacheEntry = {
  value: unknown;
  expiresAt: number;
  staleUntil: number;
  ttlMs: number;
  load: () => Promise<unknown>;
  refresh?: Promise<unknown>;
};
type CacheStats = { hits: number; misses: number; staleHits: number };

const STALE_TTL_MS = 60 * 60_000;
const g = globalThis as unknown as {
  __atplCache?: { inflight: Map<string, Promise<unknown>>; values: Map<string, CacheEntry> };
  __atplCacheRedisWarningLogged?: boolean;
  __atplCacheRedisUnavailableUntil?: number;
  __atplCacheStats?: CacheStats;
};
const store = (g.__atplCache ??= { inflight: new Map(), values: new Map() });
const stats = (g.__atplCacheStats ??= { hits: 0, misses: 0, staleHits: 0 });

const tagFor = (key: string) => {
  const tag = ["leads", "users", "products", "quotes", "visits"].find((candidate) => key.startsWith(candidate));
  return tag ?? key;
};

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/$/, ""), token } : undefined;
}

function redisKeys(key: string) {
  const digest = createHash("sha256").update(key).digest("hex");
  return {
    fresh: `atpl:cache:fresh:${digest}`,
    stale: `atpl:cache:stale:${digest}`,
    index: `atpl:cache:index:${tagFor(key)}`,
  };
}

async function redisCommand(args: string[]): Promise<unknown | undefined> {
  const config = redisConfig();
  if (!config || (g.__atplCacheRedisUnavailableUntil ?? 0) > Date.now()) return undefined;
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) throw new Error(`Upstash REST request returned ${response.status}`);
    const result = await response.json() as { result?: unknown; error?: string };
    if (result.error) throw new Error(result.error);
    return result.result;
  } catch (error) {
    g.__atplCacheRedisUnavailableUntil = Date.now() + 60_000;
    if (!g.__atplCacheRedisWarningLogged) {
      console.error("[cache] Upstash cache unavailable; using process-local cache", {
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      });
      g.__atplCacheRedisWarningLogged = true;
    }
    return undefined;
  }
}

function parseCachedValue(value: unknown): unknown | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    console.error("[cache] Could not deserialize cached value", {
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function writeRedisValue(key: string, value: unknown, ttlMs: number) {
  if (!redisConfig()) return;
  const keys = redisKeys(key);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`Cache value "${key}" is not JSON serializable.`);
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
  const staleSeconds = Math.ceil(STALE_TTL_MS / 1000);
  await redisCommand(["SET", keys.fresh, serialized, "EX", String(ttlSeconds)]);
  await redisCommand(["SET", keys.stale, serialized, "EX", String(staleSeconds)]);
  await redisCommand(["SADD", keys.index, key]);
  await redisCommand(["EXPIRE", keys.index, String(staleSeconds)]);
}

async function readRedisValues(key: string) {
  const keys = redisKeys(key);
  const result = await redisCommand(["MGET", keys.fresh, keys.stale]);
  return Array.isArray(result)
    ? [parseCachedValue(result[0]), parseCachedValue(result[1])] as const
    : [undefined, undefined] as const;
}

function scheduleAfter(work: () => Promise<unknown>) {
  try {
    after(async () => { await work(); });
  } catch {
    void work();
  }
}

/** JSON cache with shared Redis storage, a one-hour stale copy, and request de-duplication. */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const local = store.values.get(key);
  if (local) {
    local.load = load;
    local.ttlMs = ttlMs;
    if (local.expiresAt <= Date.now()) {
      if (local.staleUntil > Date.now()) {
        stats.staleHits += 1;
        refreshInBackground(key, local);
        return local.value as T;
      }
      store.values.delete(key);
    } else {
      stats.hits += 1;
      return local.value as T;
    }
  }

  const pending = store.inflight.get(key);
  if (pending) {
    stats.hits += 1;
    return pending as Promise<T>;
  }

  const task = (async () => {
    const [remoteFresh, remoteStale] = await readRedisValues(key);
    if (remoteFresh !== undefined) {
      stats.hits += 1;
      store.values.set(key, { value: remoteFresh, expiresAt: Date.now() + ttlMs, staleUntil: Date.now() + STALE_TTL_MS, ttlMs, load });
      return remoteFresh as T;
    }
    if (remoteStale !== undefined) {
      stats.staleHits += 1;
      const entry: CacheEntry = {
        value: remoteStale, expiresAt: 0, staleUntil: Date.now() + STALE_TTL_MS, ttlMs, load,
      };
      store.values.set(key, entry);
      refreshInBackground(key, entry);
      return remoteStale as T;
    }

    stats.misses += 1;
    const value = await load();
    const entry: CacheEntry = {
      value, expiresAt: Date.now() + ttlMs, staleUntil: Date.now() + STALE_TTL_MS, ttlMs, load,
    };
    store.values.set(key, entry);
    await writeRedisValue(key, value, ttlMs);
    return value;
  })().finally(() => store.inflight.delete(key));
  store.inflight.set(key, task);
  return task as Promise<T>;
}

export async function setCachedValue<T>(key: string, ttlMs: number, value: T): Promise<void> {
  const entry: CacheEntry = {
    value,
    expiresAt: Date.now() + ttlMs,
    staleUntil: Date.now() + STALE_TTL_MS,
    ttlMs,
    load: async () => value,
  };
  store.values.set(key, entry);
  await writeRedisValue(key, value, ttlMs);
}

function refreshInBackground(key: string, entry: CacheEntry) {
  if (entry.refresh) return;
  let releaseRefresh: () => void = () => undefined;
  entry.refresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  scheduleAfter(async () => {
    try {
      const value = await entry.load();
      await writeRedisValue(key, value, entry.ttlMs);
      entry.value = value;
      entry.expiresAt = Date.now() + entry.ttlMs;
      entry.staleUntil = Date.now() + STALE_TTL_MS;
    } catch (error: unknown) {
      console.error("[cache] background refresh failed", {
        key,
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      entry.refresh = undefined;
      releaseRefresh();
    }
  });
}

async function invalidateRedisPrefix(prefix: string) {
  const index = `atpl:cache:index:${tagFor(prefix)}`;
  const keys = await redisCommand(["SMEMBERS", index]);
  if (!Array.isArray(keys)) return;
  for (const key of keys.filter((item): item is string => typeof item === "string")) {
    if (key !== prefix && !key.startsWith(`${prefix}:`)) continue;
    const redis = redisKeys(key);
    await redisCommand(["DEL", redis.fresh, redis.stale]);
    await redisCommand(["SREM", index, key]);
  }
}

export function invalidate(...prefixes: string[]) {
  for (const prefix of prefixes) {
    for (const key of store.values.keys()) {
      if (key === prefix || key.startsWith(`${prefix}:`)) store.values.delete(key);
    }
    scheduleAfter(() => invalidateRedisPrefix(prefix));
    revalidateTag(tagFor(prefix));
  }
}

export function resetMemoryCache() {
  store.inflight.clear();
  store.values.clear();
}

export function cacheStats(): CacheStats {
  return { ...stats };
}
