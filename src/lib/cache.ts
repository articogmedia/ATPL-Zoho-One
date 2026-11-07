import "server-only";
import { createHash } from "node:crypto";
import { after } from "next/server";
import { revalidateTag } from "next/cache";

type CacheEntry = {
  value: unknown;
  expiresAt: number;
  staleUntil: number;
  ttlMs: number;
  keepStale: boolean;
  load: () => Promise<unknown>;
  refresh?: Promise<unknown>;
};
type CacheStats = { hits: number; misses: number; staleHits: number };
type CacheStore = { inflight: Map<string, Promise<unknown>>; values: Map<string, CacheEntry>; generations: Map<string, number> };

const STALE_TTL_MS = 60 * 60_000;
const g = globalThis as unknown as {
  __atplCache?: CacheStore;
  __atplCacheRedisWarningLogged?: boolean;
  __atplCacheRedisUnavailableUntil?: number;
  __atplCacheStats?: CacheStats;
};
const store = (g.__atplCache ??= { inflight: new Map(), values: new Map(), generations: new Map() });
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

async function redisPipeline(commands: string[][]): Promise<void> {
  const config = redisConfig();
  if (!config || (g.__atplCacheRedisUnavailableUntil ?? 0) > Date.now() || !commands.length) return;
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      cache: "no-store",
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) throw new Error(`Upstash REST request returned ${response.status}`);
    const results = await response.json() as { result?: unknown; error?: string }[];
    const failure = results.find((result) => result.error);
    if (failure?.error) throw new Error(failure.error);
  } catch (error) {
    g.__atplCacheRedisUnavailableUntil = Date.now() + 60_000;
    if (!g.__atplCacheRedisWarningLogged) {
      console.error("[cache] Upstash cache unavailable; using process-local cache", {
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      });
      g.__atplCacheRedisWarningLogged = true;
    }
  }
}

function generationFor(key: string) {
  let generation = 0;
  for (const [prefix, version] of store.generations) {
    if (key === prefix || key.startsWith(`${prefix}:`)) generation += version;
  }
  return generation;
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

async function writeRedisValue(key: string, value: unknown, ttlMs: number, keepStale = false) {
  if (!redisConfig()) return;
  const keys = redisKeys(key);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`Cache value "${key}" is not JSON serializable.`);
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
  const staleSeconds = Math.ceil(STALE_TTL_MS / 1000);
  await redisCommand(["SET", keys.fresh, serialized, "EX", String(ttlSeconds)]);
  if (keepStale) await redisCommand(["SET", keys.stale, serialized]);
  else await redisCommand(["SET", keys.stale, serialized, "EX", String(staleSeconds)]);
  await redisCommand(["SADD", keys.index, key]);
  if (!keepStale) await redisCommand(["EXPIRE", keys.index, String(staleSeconds)]);
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
export async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  options: { keepStale?: boolean } = {},
): Promise<T> {
  const keepStale = options.keepStale === true;
  const local = store.values.get(key);
  if (local) {
    local.load = load;
    local.ttlMs = ttlMs;
    local.keepStale = keepStale;
    if (local.expiresAt <= Date.now()) {
      if (local.keepStale || local.staleUntil > Date.now()) {
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

  const task: Promise<unknown> = (async () => {
    const generation = generationFor(key);
    const [remoteFresh, remoteStale] = await readRedisValues(key);
    if (remoteFresh !== undefined) {
      stats.hits += 1;
      store.values.set(key, { value: remoteFresh, expiresAt: Date.now() + ttlMs, staleUntil: keepStale ? Number.POSITIVE_INFINITY : Date.now() + STALE_TTL_MS, ttlMs, keepStale, load });
      return remoteFresh as T;
    }
    if (remoteStale !== undefined) {
      stats.staleHits += 1;
      const entry: CacheEntry = {
        value: remoteStale, expiresAt: 0, staleUntil: keepStale ? Number.POSITIVE_INFINITY : Date.now() + STALE_TTL_MS, ttlMs, keepStale, load,
      };
      store.values.set(key, entry);
      refreshInBackground(key, entry);
      return remoteStale as T;
    }

    stats.misses += 1;
    const value = await load();
    if (generationFor(key) !== generation) return value;
    const entry: CacheEntry = {
      value, expiresAt: Date.now() + ttlMs, staleUntil: keepStale ? Number.POSITIVE_INFINITY : Date.now() + STALE_TTL_MS, ttlMs, keepStale, load,
    };
    store.values.set(key, entry);
    await writeRedisValue(key, value, ttlMs, keepStale);
    return value;
  })().finally(() => {
    if (store.inflight.get(key) === task) store.inflight.delete(key);
  });
  store.inflight.set(key, task);
  return task as Promise<T>;
}

export async function setCachedValue<T>(key: string, ttlMs: number, value: T): Promise<void> {
  const entry: CacheEntry = {
    value,
    expiresAt: Date.now() + ttlMs,
    staleUntil: Date.now() + STALE_TTL_MS,
    ttlMs,
    keepStale: false,
    load: async () => value,
  };
  store.values.set(key, entry);
  await writeRedisValue(key, value, ttlMs);
}

export async function getCachedValue<T>(key: string): Promise<T | undefined> {
  const [fresh] = await readRedisValues(key);
  if (fresh !== undefined) return fresh as T;
  return store.values.get(key)?.value as T | undefined;
}

function refreshInBackground(key: string, entry: CacheEntry) {
  if (entry.refresh) return;
  let releaseRefresh: () => void = () => undefined;
  entry.refresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  scheduleAfter(async () => {
    try {
      const value = await entry.load();
      await writeRedisValue(key, value, entry.ttlMs, entry.keepStale);
      entry.value = value;
      entry.expiresAt = Date.now() + entry.ttlMs;
      entry.staleUntil = entry.keepStale ? Number.POSITIVE_INFINITY : Date.now() + STALE_TTL_MS;
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
  const matching = keys.filter((item): item is string =>
    typeof item === "string" && (item === prefix || item.startsWith(`${prefix}:`)),
  );
  if (!matching.length) return;
  const redisEntryKeys = matching.flatMap((key) => {
    const redis = redisKeys(key);
    return [redis.fresh, redis.stale];
  });
  await redisPipeline([["DEL", ...redisEntryKeys], ["SREM", index, ...matching]]);
}

export async function invalidate(...prefixes: string[]): Promise<void> {
  const work: Promise<void>[] = [];
  for (const prefix of prefixes) {
    store.generations.set(prefix, (store.generations.get(prefix) ?? 0) + 1);
    for (const key of store.values.keys()) {
      if (key === prefix || key.startsWith(`${prefix}:`)) store.values.delete(key);
    }
    for (const key of store.inflight.keys()) {
      if (key === prefix || key.startsWith(`${prefix}:`)) store.inflight.delete(key);
    }
    work.push(invalidateRedisPrefix(prefix));
    revalidateTag(tagFor(prefix));
  }
  await Promise.all(work);
}

export function resetMemoryCache() {
  store.inflight.clear();
  store.values.clear();
  store.generations.clear();
}

export function cacheStats(): CacheStats {
  return { ...stats };
}
