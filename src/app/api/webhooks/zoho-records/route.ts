import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { invalidate } from "@/lib/cache";

export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";
export const runtime = "nodejs";

const INVALIDATION_PREFIXES = {
  Leads: ["leads", "users", "visits"],
  Quotes: ["quotes", "invoices"],
  Invoices: ["invoices"],
  Tasks: ["visits"],
  Products: ["products"],
} as const;

function isWebhookModule(value: unknown): value is keyof typeof INVALIDATION_PREFIXES {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(INVALIDATION_PREFIXES, value);
}

export async function POST(request: Request) {
  const expectedSecret = process.env.ZOHO_WEBHOOK_SECRET;
  const providedSecret = request.headers.get("x-zoho-webhook-secret");
  if (!expectedSecret || !providedSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const expected = Buffer.from(expectedSecret);
  const provided = Buffer.from(providedSecret);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "A valid JSON body is required." }, { status: 400 });
  }
  const moduleName = payload && typeof payload === "object" && "module" in payload
    ? payload.module
    : undefined;
  if (!isWebhookModule(moduleName)) {
    return NextResponse.json({ error: "Unknown CRM module." }, { status: 400 });
  }

  try {
    await invalidate(...INVALIDATION_PREFIXES[moduleName]);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("[webhook] CRM cache invalidation failed", {
      module: moduleName,
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "CRM cache refresh failed." }, { status: 500 });
  }
}
