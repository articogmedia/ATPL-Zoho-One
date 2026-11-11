import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Quotation } from "@/lib/domain";
import { env } from "@/lib/env";

type SnapshotPayload = { userId: string; issuedAt: number; quote: Quotation };
const SNAPSHOT_MAX_AGE_MS = 2 * 60_000;

function signature(payload: string) {
  return createHmac("sha256", env().SESSION_SECRET).update(payload).digest("base64url");
}

export function signQuotationPdfSnapshot(quote: Quotation, userId: string) {
  const payload = Buffer.from(JSON.stringify({ userId, issuedAt: Date.now(), quote } satisfies SnapshotPayload))
    .toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function verifyQuotationPdfSnapshot(token: string, userId: string, quoteId: string): Quotation | null {
  const [payload, providedSignature, ...extra] = token.split(".");
  if (!payload || !providedSignature || extra.length) return null;
  const expectedSignature = Buffer.from(signature(payload));
  const actualSignature = Buffer.from(providedSignature);
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<SnapshotPayload>;
    if (parsed.userId !== userId || !Number.isFinite(parsed.issuedAt) ||
      Date.now() - Number(parsed.issuedAt) > SNAPSHOT_MAX_AGE_MS ||
      Number(parsed.issuedAt) > Date.now() + 10_000 ||
      !parsed.quote || parsed.quote.id !== quoteId) return null;
    return parsed.quote;
  } catch {
    return null;
  }
}
