import "server-only";
import { revalidateTag, unstable_cache } from "next/cache";

type CacheEntry = {
  value: unknown;
  expiresAt: number;
  ttlMs: number;
  load: () => Promise<unknown>;
  refresh?: Promise<unknown>;
};

const g = globalThis as unknown as {
  __atplCache?: { inflight: Map<string, Promise<unknown>>; values: Map<string, CacheEntry> };
};
const store = (g.__atplCache ??= { inflight: new Map(), values: new Map() });

const tagFor = (key: string) => {
  const tag = ["leads", "users", "products", "quotes", "visits"].find((candidate) => key.startsWith(candidate));
  return tag ?? key;
};

/**
 * Tiny TTL cache with in-flight de-duplication. It protects the Zoho API credit budget:
 * many staff opening the same screen produce one Zoho call, not one each.
 * Per-process only; if you scale to several server instances, swap for Redis/Upstash.
 */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const cachedValue = store.values.get(key) as CacheEntry | undefined;
  if (cachedValue) {
    cachedValue.load = load;
    cachedValue.ttlMs = ttlMs;
    if (cachedValue.expiresAt <= Date.now()) refreshInBackground(key, cachedValue);
    return cachedValue.value as T;
  }
  const pending = store.inflight.get(key);
  if (pending) return pending as Promise<T>;
  const get = unstable_cache(load, ["atpl", key], {
    revalidate: Math.max(1, Math.ceil(ttlMs / 1000)),
    tags: [tagFor(key)],
  });
  const p = get().then((value) => {
    store.values.set(key, { value, expiresAt: Date.now() + ttlMs, ttlMs, load });
    return value;
  }).finally(() => store.inflight.delete(key));
  store.inflight.set(key, p);
  return p;
}

function refreshInBackground(key: string, entry: CacheEntry) {
  if (entry.refresh) return;
  entry.refresh = entry.load().then((value) => {
    entry.value = value;
    entry.expiresAt = Date.now() + entry.ttlMs;
    return value;
  }).catch((error: unknown) => {
    console.error("[cache] background refresh failed", {
      key,
      message: error instanceof Error ? error.message : String(error),
    });
  }).finally(() => { entry.refresh = undefined; });
}

export function invalidate(...prefixes: string[]) {
  for (const prefix of prefixes) {
    for (const key of store.values.keys()) {
      if (key === prefix || key.startsWith(`${prefix}:`)) {
        store.values.delete(key);
      }
    }

    revalidateTag(tagFor(prefix));
  }
}

export function resetMemoryCache() {
  store.inflight.clear();
  store.values.clear();
}
