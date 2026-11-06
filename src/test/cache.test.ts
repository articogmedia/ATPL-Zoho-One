import { beforeEach, describe, expect, it, vi } from "vitest";

const afterTasks = vi.hoisted(() => [] as (() => Promise<void> | void)[]);

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({
  after: (task: () => Promise<void> | void) => { afterTasks.push(task); },
}));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
  afterTasks.length = 0;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  vi.resetModules();
  const { resetMemoryCache } = await import("@/lib/cache");
  resetMemoryCache();
});

describe("shared cache stale-while-revalidate", () => {
  it("returns stale data immediately and refreshes it after the response", async () => {
    let value = "first";
    let loads = 0;
    const load = async () => { loads += 1; return value; };
    const { cached } = await import("@/lib/cache");

    await expect(cached("leads", 1_000, load)).resolves.toBe("first");
    value = "refreshed";
    vi.advanceTimersByTime(1_001);

    await expect(cached("leads", 1_000, load)).resolves.toBe("first");
    expect(loads).toBe(1);
    expect(afterTasks).toHaveLength(1);

    await afterTasks.shift()?.();
    await expect(cached("leads", 1_000, load)).resolves.toBe("refreshed");
    expect(loads).toBe(2);
  });

  it("keeps product and quote stale data available when refreshes keep failing", async () => {
    const { cached } = await import("@/lib/cache");
    const load = vi.fn(async () => "cached catalogue");
    await expect(cached("products", 1_000, load, { keepStale: true })).resolves.toBe("cached catalogue");
    load.mockRejectedValue(new Error("network timeout"));
    vi.advanceTimersByTime(3_600_001);

    await expect(cached("products", 1_000, load, { keepStale: true })).resolves.toBe("cached catalogue");
    await afterTasks.shift()?.();
    await expect(cached("products", 1_000, load, { keepStale: true })).resolves.toBe("cached catalogue");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
