import { warmZohoToken, ZohoError } from "@/lib/zoho/client";
import { friendlyZohoError, newErrorReference } from "@/lib/crm-action-errors";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await warmZohoToken();
    console.info(`[warm] zoho token ${Date.now() - started}ms`);
    return new Response(null, { status: 200 });
  } catch (error) {
    const reference = newErrorReference();
    console.error("[warm] zoho token failed", {
      reference,
      durationMs: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
      status: error instanceof ZohoError ? error.status : undefined,
      code: error instanceof ZohoError ? error.code : undefined,
      field: error instanceof ZohoError ? error.field : undefined,
      details: error instanceof ZohoError ? error.details : undefined,
      operation: error instanceof ZohoError ? error.operation : undefined,
    });
    const message = error instanceof ZohoError
      ? friendlyZohoError(error.status, error.code, error.message, error.field, reference)
      : `Unable to warm the Zoho connection. (Ref: ${reference})`;
    return NextResponse.json({ error: message, reference }, { status: 503 });
  }
}
