import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { currentUser } from "@/lib/auth/guard";
import { newErrorReference } from "@/lib/crm-action-errors";
import { quotationRequestSchema } from "@/lib/quotation-request";
import { logPerf } from "@/lib/perf-log";
import { QuotationPdfGenerationError, generateQuotationPdfBytes } from "@/lib/quotation-pdf";
import { ZohoError } from "@/lib/zoho/client";

export const runtime = "nodejs";
export const preferredRegion = "bom1";
export const maxDuration = 30;

function describeErrorCause(cause: unknown, depth = 0): unknown {
  if (cause === undefined || depth >= 3) return undefined;
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      stack: cause.stack,
      cause: describeErrorCause(cause.cause, depth + 1),
    };
  }
  return { type: typeof cause, message: typeof cause === "string" ? cause : String(cause) };
}

function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /^(mobile|phone|quoteSnapshotToken)$/i.test(key) && item != null
        ? `******${String(item).replace(/\D/g, "").slice(-2)}`
        : redactPayload(item),
    ]));
  }
  return value;
}

export async function POST(request: NextRequest) {
  const started = Date.now();
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  let rawPayload: unknown;
  let parsed: ReturnType<typeof quotationRequestSchema.parse>;
  try {
    rawPayload = await request.json();
    parsed = quotationRequestSchema.parse(rawPayload);
  } catch (error) {
    const message = error instanceof ZodError
      ? error.issues[0]?.message ?? "Please check the quotation details."
      : "Please provide valid quotation details.";
    const reference = newErrorReference();
    console.error("[api] quotation PDF request validation failed", {
      reference,
      stage: "request_validation",
      issues: error instanceof ZodError ? error.issues.map(({ path, message: issueMessage }) => ({ path, message: issueMessage })) : undefined,
      message: error instanceof Error ? error.message : String(error),
      payload: redactPayload(rawPayload),
    });
    return NextResponse.json({ error: `${message} (Ref: ${reference})`, reference, stage: "request_validation" }, { status: 400 });
  }

  let savedQuote = false;
  try {
    savedQuote = Boolean(parsed.quoteId);
    const { bytes, filename } = await generateQuotationPdfBytes(parsed, user);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    const failure = error instanceof QuotationPdfGenerationError
      ? error
      : new QuotationPdfGenerationError("pdf_generation", 500, error);
    const cause = failure.cause;
    const reference = newErrorReference();
    const causeError = cause instanceof Error ? cause : undefined;
    const zohoError = cause instanceof ZohoError ? cause : undefined;
    console.error("[api] quotation PDF generation failed", {
      reference,
      quoteId: parsed.quoteId,
      offerNo: parsed.offerNo,
      stage: failure.stage,
      errorName: causeError?.name ?? typeof cause,
      message: causeError?.message ?? String(cause),
      stack: causeError?.stack,
      cause: describeErrorCause(causeError?.cause),
      status: zohoError?.status,
      code: zohoError?.code,
      field: zohoError?.field,
      details: zohoError?.details,
      operation: zohoError?.operation,
      deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA,
    });
    if (failure.status === 403) {
      return NextResponse.json({ error: "Quotation not found or access denied.", reference, stage: failure.stage }, { status: 403 });
    }
    const message = `Could not prepare PDF (step: ${failure.stage}). Ref: ${reference}`;
    return NextResponse.json({ error: message, reference, stage: failure.stage }, { status: 500 });
  } finally {
    logPerf("api.quotations.pdf", Date.now() - started, { savedQuote });
  }
}
