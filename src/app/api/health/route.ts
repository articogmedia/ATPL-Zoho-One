import { NextResponse } from "next/server";
import { zohoRuntimeStatus } from "@/lib/zoho/client";

export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";

export function GET() {
  const zoho = zohoRuntimeStatus();
  return NextResponse.json({ ok: true, zoho }, { headers: { "Cache-Control": "no-store" } });
}
