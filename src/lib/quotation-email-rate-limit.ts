import "server-only";
import { createHash } from "node:crypto";

const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;
const localCounters = new Map<string, { count: number; expiresAt: number }>();

async function consume(key: string, limit: number, windowSeconds: number) {
  const digest = createHash("sha256").update(key).digest("hex");
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/$/, "");
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!redisUrl || !redisToken) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Upstash Redis is required for quotation email rate limiting in production.");
    }
    const current = localCounters.get(digest);
    if (!current || current.expiresAt <= Date.now()) {
      localCounters.set(digest, { count: 1, expiresAt: Date.now() + windowSeconds * 1000 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }
  const response = await fetch(redisUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(["EVAL", RATE_LIMIT_SCRIPT, 1, `atpl:quotation-email-rate:${digest}`, windowSeconds]),
    cache: "no-store",
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`Upstash rate-limit request failed (HTTP ${response.status}).`);
  const result = await response.json() as { result?: unknown; error?: string };
  if (result.error || typeof result.result !== "number") {
    throw new Error(result.error || "Upstash returned an invalid email rate-limit result.");
  }
  return result.result <= limit;
}

export async function takeQuotationEmailRateLimit(userId: string, quoteId: string) {
  const userAllowed = await consume(`user:${userId}`, 10, 60 * 60);
  if (!userAllowed) return false;
  return consume(`quote:${quoteId}`, 3, 60 * 60);
}
