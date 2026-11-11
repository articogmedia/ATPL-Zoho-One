import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("quotation email rate limit", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("limits sends by user and by quotation", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const { takeQuotationEmailRateLimit } = await import("@/lib/quotation-email-rate-limit");

    expect(await takeQuotationEmailRateLimit("user-limit-test", "quote-limit-test")).toBe(true);
    expect(await takeQuotationEmailRateLimit("user-limit-test", "quote-limit-test")).toBe(true);
    expect(await takeQuotationEmailRateLimit("user-limit-test", "quote-limit-test")).toBe(true);
    expect(await takeQuotationEmailRateLimit("user-limit-test", "quote-limit-test")).toBe(false);
    for (let index = 0; index < 9; index += 1) {
      await takeQuotationEmailRateLimit("hourly-user-limit-test", `quote-${index}`);
    }
    expect(await takeQuotationEmailRateLimit("hourly-user-limit-test", "quote-last")).toBe(true);
    expect(await takeQuotationEmailRateLimit("hourly-user-limit-test", "quote-over")).toBe(false);
  });

  it("requires shared Redis rate limiting in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const { takeQuotationEmailRateLimit } = await import("@/lib/quotation-email-rate-limit");

    await expect(takeQuotationEmailRateLimit("production-user", "production-quote"))
      .rejects.toThrow("Upstash Redis is required");
  });
});
