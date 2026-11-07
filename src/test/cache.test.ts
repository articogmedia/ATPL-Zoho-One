import { beforeEach, describe, expect, it, vi } from "vitest";

const afterTasks = vi.hoisted(() => [] as (() => Promise<void> | void)[]);

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({
  after: (task: () => Promise<void> | void) => { afterTasks.push(task); },
}));

beforeEach(async () => {
  vi.unstubAllGlobals();
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

  it("does not serve an in-memory stale entry after invalidation", async () => {
    let value = "old";
    const load = vi.fn(async () => value);
    const { cached, invalidate } = await import("@/lib/cache");
    await expect(cached("leads", 1_000, load, { keepStale: true })).resolves.toBe("old");
    value = "new";
    vi.advanceTimersByTime(1_001);
    await expect(cached("leads", 1_000, load, { keepStale: true })).resolves.toBe("old");
    await invalidate("leads");
    await afterTasks.shift()?.();
    await expect(cached("leads", 1_000, load, { keepStale: true })).resolves.toBe("new");
  });

  it("deletes fresh and stale Redis entries before invalidation resolves", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    const calls: { url: string; commands: string[][] }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as string[] | string[][];
      if (Array.isArray(body[0])) {
        const pipeline = body as string[][];
        calls.push({ url, commands: pipeline });
        return { ok: true, json: async () => pipeline.map(() => ({ result: 1 })) };
      }
      const command = body as string[];
      calls.push({ url, commands: [command] });
      return { ok: true, json: async () => ({ result: ["leads", "leads:page"] }) };
    }));
    const { invalidate } = await import("@/lib/cache");

    await invalidate("leads");

    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://redis.example/pipeline");
    const [deleteCommand, removeIndexCommand] = calls[1]!.commands;
    expect(deleteCommand?.[0]).toBe("DEL");
    expect(deleteCommand?.slice(1)).toHaveLength(4);
    expect(deleteCommand?.some((key) => key.includes(":fresh:"))).toBe(true);
    expect(deleteCommand?.some((key) => key.includes(":stale:"))).toBe(true);
    expect(removeIndexCommand).toEqual(["SREM", "atpl:cache:index:leads", "leads", "leads:page"]);
  });

  it("reads completed background assignment warnings without serving a cached pending value", async () => {
    const { getCachedValue, setCachedValue } = await import("@/lib/cache");
    await expect(getCachedValue("assignment-warnings:request-1")).resolves.toBeUndefined();
    await setCachedValue("assignment-warnings:request-1", 60_000, { taskWarning: "Task failed." });
    await expect(getCachedValue("assignment-warnings:request-1")).resolves.toEqual({ taskWarning: "Task failed." });
  });

  it("does not repopulate invalidated values from an older in-flight load", async () => {
    let releaseOldLoad: (value: string) => void = () => undefined;
    let oldLoadStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { oldLoadStarted = resolve; });
    const oldLoad = import("@/lib/cache").then(({ cached }) => cached(
      "leads:page",
      1_000,
      () => new Promise<string>((resolve) => {
        releaseOldLoad = resolve;
        oldLoadStarted();
      }),
    ));
    const { cached, invalidate } = await import("@/lib/cache");
    await started;
    await invalidate("leads");
    await expect(cached("leads:page", 1_000, async () => "new data")).resolves.toBe("new data");
    releaseOldLoad("old data");
    await expect(oldLoad).resolves.toBe("old data");
    await expect(cached("leads:page", 1_000, async () => "unexpected reload")).resolves.toBe("new data");
  });
});
