import { put } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/guard";
import { env } from "@/lib/env";
import { newErrorReference } from "@/lib/crm-action-errors";
import { quotationRequestSchema } from "@/lib/quotation-request";

export const runtime = "nodejs";
export const preferredRegion = "bom1";
export const maxDuration = 30;

function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /^(mobile|phone)$/i.test(key) && item != null
        ? `******${String(item).replace(/\D/g, "").slice(-2)}`
        : redactPayload(item),
    ]));
  }
  return value;
}

export async function POST(request: NextRequest) {
  if (!await currentUser()) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    const reference = newErrorReference();
    console.error("[api] quotation share request parsing failed", {
      reference, message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: `Invalid quotation share request. (Ref: ${reference})` }, { status: 400 });
  }

  const parsed = quotationRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const reference = newErrorReference();
    console.error("[api] quotation share validation failed", {
      reference,
      issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
      payload: redactPayload(payload),
    });
    return NextResponse.json({
      error: parsed.error.issues[0]?.message ?? "Please check the quotation details.",
      reference,
    }, { status: 400 });
  }

  const blobToken = env().BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    const reference = newErrorReference();
    console.error("[api] quotation share storage is not configured", {
      reference, requiredEnvironmentVariable: "BLOB_READ_WRITE_TOKEN",
    });
    return NextResponse.json({
      error: `PDF sharing is not configured. Set BLOB_READ_WRITE_TOKEN. (Ref: ${reference})`,
      reference,
    }, { status: 503 });
  }

  try {
    const pdfUrl = new URL("/api/quotations/pdf", request.url);
    const pdfResponse = await fetch(pdfUrl, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(request.headers.get("cookie") ? { Cookie: request.headers.get("cookie")! } : {}),
      },
      body: JSON.stringify(parsed.data),
    });
    if (!pdfResponse.ok) {
      const body = await pdfResponse.text();
      let errorMessage = `Could not prepare the quotation PDF (HTTP ${pdfResponse.status}).`;
      try {
        const responseBody = JSON.parse(body) as { error?: unknown };
        if (typeof responseBody.error === "string" && responseBody.error.trim()) errorMessage = responseBody.error;
      } catch {
        // Keep the HTTP status message when the PDF endpoint does not return JSON.
      }
      const reference = newErrorReference();
      console.error("[api] quotation share PDF generation failed", {
        reference, status: pdfResponse.status, body,
        payload: redactPayload(parsed.data),
      });
      return NextResponse.json({ error: errorMessage, reference }, { status: pdfResponse.status });
    }

    const pdf = Buffer.from(await pdfResponse.arrayBuffer());
    if (pdf.length === 0 || pdf.subarray(0, 4).toString("ascii") !== "%PDF") {
      throw new Error("The generated quotation file is empty or invalid.");
    }
    const blob = await put(`quotations/${randomUUID()}.pdf`, pdf, {
      access: "public",
      contentType: "application/pdf",
      token: blobToken,
    });
    return NextResponse.json({ url: blob.url });
  } catch (error) {
    const reference = newErrorReference();
    console.error("[api] quotation share preparation failed", {
      reference,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      payload: redactPayload(parsed.data),
    });
    return NextResponse.json({
      error: `Could not prepare a shareable quotation PDF. (Ref: ${reference})`,
      reference,
    }, { status: 500 });
  }
}
