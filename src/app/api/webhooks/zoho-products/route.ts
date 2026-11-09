import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { invalidate } from "@/lib/cache";

export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";
export const runtime = "nodejs";

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

  try {
    await invalidate("products");
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("[webhook] product cache invalidation failed", {
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Product cache refresh failed." }, { status: 500 });
  }
}
