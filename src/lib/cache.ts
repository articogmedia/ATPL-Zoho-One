import "server-only";

type Entry = { at: number; value: unknown };
const g = globalThis as unknown as { __atplCache?: { data: Map<string, Entry>; inflight: Map<string, Promise<unknown>> } };
const store = (g.__atplCache ??= { data: new Map(), inflight: new Map() });

/**
 * Tiny TTL cache with in-flight de-duplication. It protects the Zoho API credit budget:
 * many staff opening the same screen produce one Zoho call, not one each.
 * Per-process only; if you scale to several server instances, swap for Redis/Upstash.
 */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.data.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const pending = store.inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = load()
    .then((value) => { store.data.set(key, { at: Date.now(), value }); return value; })
    .finally(() => store.inflight.delete(key));
  store.inflight.set(key, p);
  return p;
}

export function invalidate(...prefixes: string[]) {
  for (const k of store.data.keys()) if (prefixes.some((p) => k.startsWith(p))) store.data.delete(k);
}
