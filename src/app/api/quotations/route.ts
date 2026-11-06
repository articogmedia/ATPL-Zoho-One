import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/guard";
import { crm } from "@/lib/crm";
import { ZohoError } from "@/lib/zoho/client";
import { friendlyZohoError, newErrorReference } from "@/lib/crm-action-errors";
import { visibleFor } from "@/lib/domain";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const page = Number(request.nextUrl.searchParams.get("page") ?? "1");
  if (!Number.isInteger(page) || page < 1 || page > 100) {
    return NextResponse.json({ error: "Invalid quotation page." }, { status: 400 });
  }
  try {
    const result = await crm().listQuotesPage(page);
    return NextResponse.json({
      quotes: visibleFor(user, result.quotes),
      hasMore: result.hasMore,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const reference = newErrorReference();
    console.error("[api] quotation page load failed", {
      reference,
      message: error instanceof Error ? error.message : String(error),
      status: error instanceof ZohoError ? error.status : undefined,
      code: error instanceof ZohoError ? error.code : undefined,
      details: error instanceof ZohoError ? error.details : undefined,
    });
    const message = error instanceof ZohoError
      ? friendlyZohoError(error.status, error.code, error.message, error.field, reference)
      : `Unable to load quotations right now. (Ref: ${reference})`;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
