import "server-only";
import { after } from "next/server";
import { cacheStats } from "@/lib/cache";
import { zohoRequestCount } from "@/lib/zoho/client";
import { logPerf } from "@/lib/perf-log";

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
    logPerf("page.render", Date.now() - snapshot.startedAt, {
      page: snapshot.page,
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
