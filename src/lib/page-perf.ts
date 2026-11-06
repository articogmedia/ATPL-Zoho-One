import "server-only";
import { after } from "next/server";
import { cacheStats } from "@/lib/cache";
import { zohoRequestCount } from "@/lib/zoho/client";

type PagePerfSnapshot = {
  page: string;
  startedAt: number;
  cache: ReturnType<typeof cacheStats>;
  zohoCalls: number;
};

export function beginPagePerf(page: string): PagePerfSnapshot {
  return { page, startedAt: Date.now(), cache: cacheStats(), zohoCalls: zohoRequestCount() };
}

export function endPagePerf(snapshot: PagePerfSnapshot) {
  const report = () => {
    const current = cacheStats();
    console.info("[perf]", {
      page: snapshot.page,
      totalMs: Date.now() - snapshot.startedAt,
      cacheHits: current.hits - snapshot.cache.hits,
      cacheMisses: current.misses - snapshot.cache.misses,
      staleCacheHits: current.staleHits - snapshot.cache.staleHits,
      zohoCalls: zohoRequestCount() - snapshot.zohoCalls,
    });
  };
  try {
    after(report);
  } catch {
    report();
  }
}
