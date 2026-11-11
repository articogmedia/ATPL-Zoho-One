import "server-only";

const localCounters = new Map<string, number>();

export function financialYear(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const startYear = month >= 4 ? year : year - 1;
  return `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
}

export async function nextInvoiceNumber(date = new Date()) {
  const fy = financialYear(date);
  const key = `atpl:invoice:number:${fy}`;
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  let sequence: number;
  if (url && token) {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["INCR", key]),
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`Upstash invoice sequence request failed (HTTP ${response.status}).`);
    const result = await response.json() as { result?: unknown; error?: string };
    if (result.error || typeof result.result !== "number") {
      throw new Error(result.error || "Upstash returned an invalid invoice sequence.");
    }
    sequence = result.result;
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Upstash Redis is required for the shared invoice number series in production.");
    }
    sequence = (localCounters.get(key) ?? 0) + 1;
    localCounters.set(key, sequence);
  }
  return `INV/${fy}/${String(sequence).padStart(4, "0")}`;
}