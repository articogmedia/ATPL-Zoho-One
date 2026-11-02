import "server-only";
import { revalidateTag, unstable_cache } from "next/cache";

const g = globalThis as unknown as { __atplCache?: { inflight: Map<string, Promise<unknown>> } };
const store = (g.__atplCache ??= { inflight: new Map() });

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
  const pending = store.inflight.get(key);
  if (pending) return pending as Promise<T>;
  const get = unstable_cache(load, ["atpl", key], {
    revalidate: Math.max(1, Math.ceil(ttlMs / 1000)),
    tags: [tagFor(key)],
  });
  const p = get()
    .finally(() => store.inflight.delete(key));
  store.inflight.set(key, p);
  return p;
}

export function invalidate(...prefixes: string[]) {
  for (const prefix of prefixes) {
    store.inflight.delete(prefix);
    revalidateTag(tagFor(prefix));
  }
}
