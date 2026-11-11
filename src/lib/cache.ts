import "server-only";
import { createHash } from "node:crypto";
import { after } from "next/server";
import { revalidateTag } from "next/cache";
import { logPerf } from "@/lib/perf-log";

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
type IdempotencyEntry = { expiresAt: number; result: Promise<unknown> };

const STALE_TTL_MS = 60 * 60_000;
const g = globalThis as unknown as {
  __atplCache?: CacheStore;
  __atplCacheRedisWarningLogged?: boolean;
  __atplCacheRedisUnavailableUntil?: number;
  __atplCacheStats?: CacheStats;
  __atplMutationResults?: Map<string, IdempotencyEntry>;
};
const store = (g.__atplCache ??= { inflight: new Map(), values: new Map(), generations: new Map() });
const stats = (g.__atplCacheStats ??= { hits: 0, misses: 0, staleHits: 0 });
const mutationResults = (g.__atplMutationResults ??= new Map());
const IDEMPOTENCY_TTL_SECONDS = 600;

const tagFor = (key: string) => {
  const tag = ["leads", "users", "products", "quotes", "visits"].find((candidate) => key.startsWith(candidate));
  return tag ?? key;
};
const resourceFor = (key: string) => {
  const tag = ["leads", "users", "products", "quotes", "visits"].find((candidate) => key.startsWith(candidate));
  return tag ?? key.split(":", 1)[0] ?? "other";
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
  if (!config) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for shared production cache state.");
    }
    return undefined;
  }
  if ((g.__atplCacheRedisUnavailableUntil ?? 0) > Date.now()) {
    if (process.env.NODE_ENV === "production") throw new Error("Upstash Redis is temporarily unavailable; shared production cache state is required.");
    return undefined;
  }
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
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
      console.error("[cache] Upstash cache unavailable", {
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      });
      g.__atplCacheRedisWarningLogged = true;
    }
    if (process.env.NODE_ENV === "production") {
      throw new Error("Upstash Redis is unavailable; refusing to use process-local production cache state.", { cause: error });
    }
    return undefined;
  }
}

function idempotencyRedisKey(key: string) {
  return `atpl:mutation:${createHash("sha256").update(key).digest("hex")}`;
}

function parseIdempotencyResult(value: unknown): { state: "pending" } | { state: "complete"; result: unknown } | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || !("state" in parsed)) return undefined;
    const record = parsed as { state?: unknown; result?: unknown };
    if (record.state === "pending") return { state: "pending" };
    if (record.state === "complete" && "result" in record) return { state: "complete", result: record.result };
    return undefined;
  } catch (error) {
    console.error("[mutation] idempotency result could not be decoded", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}

/** Replays completed mutation results for ten minutes and coalesces concurrent retries. */
export async function withIdempotency<T>(key: string, task: () => Promise<T>): Promise<T> {
  const normalizedKey = key.trim();
  if (!normalizedKey) return task();
  const current = mutationResults.get(normalizedKey);
  if (current && current.expiresAt > Date.now()) return current.result as Promise<T>;
  if (current) mutationResults.delete(normalizedKey);

  let resolveLocal!: (result: T) => void;
  let rejectLocal!: (error: unknown) => void;
  const localResult = new Promise<T>((resolve, reject) => {
    resolveLocal = resolve;
    rejectLocal = reject;
  });
  void localResult.catch(() => undefined);
  const entry: IdempotencyEntry = {
    expiresAt: Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000,
    result: localResult,
  };
  mutationResults.set(normalizedKey, entry);

  const redisKey = idempotencyRedisKey(normalizedKey);
  let useRedis = Boolean(redisConfig());
  try {
    if (useRedis) {
      const claim = await redisCommand([
        "SET", redisKey, JSON.stringify({ state: "pending" }), "EX", String(IDEMPOTENCY_TTL_SECONDS), "NX",
      ]);
      if (claim === undefined) {
        useRedis = false;
      } else if (claim !== "OK") {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const remote = await redisCommand(["GET", redisKey]);
          if (remote === undefined) {
            useRedis = false;
            break;
          }
          const cached = parseIdempotencyResult(remote);
          if (cached?.state === "complete") {
            resolveLocal(cached.result as T);
            return cached.result as T;
          }
          if (!cached) {
            useRedis = false;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (useRedis) throw new TypeError("Network error while waiting for the original change.");
      }
    }

    const value = await task();
    const serialized = JSON.stringify({ state: "complete", result: value });
    if (serialized === undefined) throw new TypeError("Mutation result is not JSON serializable.");
    if (useRedis) await redisCommand(["SET", redisKey, serialized, "EX", String(IDEMPOTENCY_TTL_SECONDS)]);
    resolveLocal(value);
    return value;
  } catch (error) {
    if (useRedis) await redisCommand(["DEL", redisKey]);
    rejectLocal(error);
    if (mutationResults.get(normalizedKey) === entry) mutationResults.delete(normalizedKey);
    throw error;
  }
}

async function redisPipeline(commands: string[][]): Promise<void> {
  const config = redisConfig();
  if (!config || (g.__atplCacheRedisUnavailableUntil ?? 0) > Date.now() || !commands.length) {
    if (process.env.NODE_ENV === "production" && commands.length) {
      throw new Error("Upstash Redis is required for shared production cache invalidation.");
    }
    return;
  }
  try {
    const response = await fetch(`${config.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
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
    if (process.env.NODE_ENV === "production") {
      throw new Error("Upstash Redis is unavailable; refusing to use process-local production cache state.", { cause: error });
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
  if (!redisConfig()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for shared production cache state.");
    }
    return;
  }
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
  const started = performance.now();
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
        logPerf("cache.read", performance.now() - started, { resource: resourceFor(key), result: "memory-stale" });
        return local.value as T;
      }
      store.values.delete(key);
    } else {
      stats.hits += 1;
      logPerf("cache.read", performance.now() - started, { resource: resourceFor(key), result: "memory-hit" });
      return local.value as T;
    }
  }

  const pending = store.inflight.get(key);
  if (pending) {
    stats.hits += 1;
    logPerf("cache.read", performance.now() - started, { resource: resourceFor(key), result: "inflight-hit" });
    return pending as Promise<T>;
  }

  const task: Promise<unknown> = (async () => {
    const generation = generationFor(key);
    const [remoteFresh, remoteStale] = await readRedisValues(key);
    if (generationFor(key) !== generation) {
      const value = await load();
      return value;
    }
    if (remoteFresh !== undefined) {
      stats.hits += 1;
      store.values.set(key, { value: remoteFresh, expiresAt: Date.now() + ttlMs, staleUntil: keepStale ? Number.POSITIVE_INFINITY : Date.now() + STALE_TTL_MS, ttlMs, keepStale, load });
      logPerf("cache.read", performance.now() - started, { resource: resourceFor(key), result: "redis-hit" });
      return remoteFresh as T;
    }
    if (remoteStale !== undefined) {
      stats.staleHits += 1;
      const entry: CacheEntry = {
        value: remoteStale, expiresAt: 0, staleUntil: keepStale ? Number.POSITIVE_INFINITY : Date.now() + STALE_TTL_MS, ttlMs, keepStale, load,
      };
      store.values.set(key, entry);
      refreshInBackground(key, entry);
      logPerf("cache.read", performance.now() - started, { resource: resourceFor(key), result: "redis-stale" });
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
    if (generationFor(key) !== generation) {
      if (store.values.get(key) === entry) {
        store.values.delete(key);
        await invalidateRedisPrefix(key);
      } else {
        const current = store.values.get(key);
        if (current) await writeRedisValue(key, current.value, current.ttlMs, current.keepStale);
      }
    }
    logPerf("cache.read", performance.now() - started, { resource: resourceFor(key), result: "miss" });
    return value;
  })().finally(() => {
    if (store.inflight.get(key) === task) store.inflight.delete(key);
  });
  store.inflight.set(key, task);
  return task as Promise<T>;
}

export async function setCachedValue<T>(
  key: string,
  ttlMs: number,
  value: T,
  options: { keepStale?: boolean } = {},
): Promise<void> {
  const keepStale = options.keepStale === true;
  store.generations.set(key, (store.generations.get(key) ?? 0) + 1);
  store.inflight.delete(key);
  const entry: CacheEntry = {
    value,
    expiresAt: Date.now() + ttlMs,
    staleUntil: keepStale ? Number.POSITIVE_INFINITY : Date.now() + STALE_TTL_MS,
    ttlMs,
    keepStale,
    load: async () => value,
  };
  store.values.set(key, entry);
  await writeRedisValue(key, value, ttlMs, keepStale);
}

export async function patchCachedValues(
  prefix: string,
  patch: (value: unknown) => unknown,
  ttlMs = 60_000,
): Promise<void> {
  const keys = new Set<string>();
  for (const key of store.values.keys()) {
    if (key === prefix || key.startsWith(`${prefix}:`)) keys.add(key);
  }
  const indexed = await redisCommand(["SMEMBERS", `atpl:cache:index:${tagFor(prefix)}`]);
  if (Array.isArray(indexed)) {
    for (const key of indexed) {
      if (typeof key === "string" && (key === prefix || key.startsWith(`${prefix}:`))) keys.add(key);
    }
  }
  for (const key of keys) {
    const entry = store.values.get(key);
    const remote = entry ? undefined : await readRedisValues(key);
    const current = entry?.value ?? remote?.[0] ?? remote?.[1];
    if (current === undefined) continue;
    const updated = patch(current);
    if (updated === undefined) continue;
    await setCachedValue(key, entry?.ttlMs ?? ttlMs, updated);
  }
}

export async function getCachedValue<T>(key: string): Promise<T | undefined> {
  const local = store.values.get(key);
  if (local && local.expiresAt > Date.now()) return local.value as T;
  const [fresh, stale] = await readRedisValues(key);
  if (fresh !== undefined) return fresh as T;
  if (stale !== undefined) return stale as T;
  return local?.value as T | undefined;
}

function refreshInBackground(key: string, entry: CacheEntry) {
  if (entry.refresh) return;
  const generation = generationFor(key);
  let releaseRefresh: () => void = () => undefined;
  entry.refresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  scheduleAfter(async () => {
    try {
      const value = await entry.load();
      if (generationFor(key) !== generation) return;
      await writeRedisValue(key, value, entry.ttlMs, entry.keepStale);
      if (generationFor(key) !== generation) {
        await invalidateRedisPrefix(key);
        return;
      }
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

async function staleRedisPrefix(prefix: string) {
  const index = `atpl:cache:index:${tagFor(prefix)}`;
  const keys = await redisCommand(["SMEMBERS", index]);
  if (!Array.isArray(keys)) return;
  const matching = keys.filter((item): item is string =>
    typeof item === "string" && (item === prefix || item.startsWith(`${prefix}:`)),
  );
  if (!matching.length) return;
  const freshKeys = matching.map((key) => redisKeys(key).fresh);
  const aggregateKeys = matching
    .filter((key) => key.endsWith(":aggregate"))
    .flatMap((key) => {
      const redis = redisKeys(key);
      return [redis.fresh, redis.stale];
    });
  const aggregateNames = matching.filter((key) => key.endsWith(":aggregate"));
  const commands: string[][] = [["DEL", ...freshKeys]];
  if (aggregateKeys.length) {
    commands.push(["DEL", ...aggregateKeys], ["SREM", index, ...aggregateNames]);
  }
  await redisPipeline(commands);
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

/** Expires fresh values but preserves stale copies for immediate reads while they refresh. */
export async function markStale(...prefixes: string[]): Promise<void> {
  const work: Promise<void>[] = [];
  for (const prefix of prefixes) {
    store.generations.set(prefix, (store.generations.get(prefix) ?? 0) + 1);
    for (const key of [...store.values.keys()]) {
      if (key !== prefix && !key.startsWith(`${prefix}:`)) continue;
      const entry = store.values.get(key);
      if (!entry) continue;
      if (key.endsWith(":aggregate")) {
        store.values.delete(key);
      } else {
        entry.expiresAt = 0;
      }
    }
    for (const key of store.inflight.keys()) {
      if (key === prefix || key.startsWith(`${prefix}:`)) store.inflight.delete(key);
    }
    work.push(staleRedisPrefix(prefix));
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
