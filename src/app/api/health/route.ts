import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { hosts, zoho } from "@/lib/zoho/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const configuration = env();
    await zoho("GET", "/org");
    return NextResponse.json({ ok: true, dataSource: configuration.DATA_SOURCE, sandbox: configuration.ZOHO_SANDBOX === "true", apiHost: hosts().api });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Health check failed",
    }, { status: 503 });
  }
}
