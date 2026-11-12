import { put } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/guard";
import { env } from "@/lib/env";
import { newErrorReference } from "@/lib/crm-action-errors";
import { quotationRequestSchema } from "@/lib/quotation-request";
import { logPerf } from "@/lib/perf-log";
import { crm } from "@/lib/crm";
import { visibleFor, type Quotation } from "@/lib/domain";
import { getStoredQuotationPdf, saveStoredQuotationPdf } from "@/lib/quotation-pdf-store";
import { signQuotationPdfSnapshot, verifyQuotationPdfSnapshot } from "@/lib/quotation-pdf-snapshot";
import { POST as generateQuotationPdf } from "@/app/api/quotations/pdf/route";

export const runtime = "nodejs";
export const preferredRegion = "bom1";
export const maxDuration = 30;

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

async function handlePost(request: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  let payload: unknown;
  let stage = "stored_pdf_lookup";
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

  try {
    let savedQuote: Quotation | null = null;
    if (parsed.data.quoteId) {
      const stored = await getStoredQuotationPdf(parsed.data.quoteId);
      if (stored) {
        if (visibleFor(user, [{ ownerId: stored.ownerId, executive: stored.executive }]).length === 0) {
          return NextResponse.json({ error: "Quotation not found or access denied." }, { status: 403 });
        }
        return NextResponse.json({ url: stored.url });
      }
      stage = parsed.data.quoteSnapshotToken ? "quotation_snapshot_verification" : "quotation_retrieval";
      savedQuote = parsed.data.quoteSnapshotToken
        ? verifyQuotationPdfSnapshot(parsed.data.quoteSnapshotToken, user.id, parsed.data.quoteId)
        : await crm().getQuote(parsed.data.quoteId);
      if (!savedQuote || visibleFor(user, [savedQuote]).length === 0) {
        return NextResponse.json({ error: "Quotation not found or access denied." }, { status: 403 });
      }
    }

    stage = "storage_configuration";
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

    stage = "pdf_generation";
    const pdfStarted = Date.now();
    const pdfUrl = new URL("/api/quotations/pdf", request.url);
    const pdfResponse = await generateQuotationPdf(new NextRequest(pdfUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(request.headers.get("cookie") ? { Cookie: request.headers.get("cookie")! } : {}),
      },
      body: JSON.stringify({
        ...parsed.data,
        ...(savedQuote ? { quoteSnapshotToken: signQuotationPdfSnapshot(savedQuote, user.id) } : {}),
      }),
    }));
    logPerf("api.quotations.share.pdf", Date.now() - pdfStarted, { status: pdfResponse.status });
    if (!pdfResponse.ok) {
      const body = await pdfResponse.text();
      let innerReference: string | undefined;
      let innerError: string | undefined;
      try {
        const responseBody = JSON.parse(body) as { error?: unknown };
        if (typeof responseBody.error === "string") {
          innerError = responseBody.error;
          innerReference = /\(Ref:\s*([A-Za-z0-9-]+)\)/.exec(responseBody.error)?.[1];
        }
      } catch {
        // The outer error remains safe if PDF generation returned non-JSON.
      }
      const reference = newErrorReference();
      console.error("[api] quotation share PDF generation failed", {
        reference,
        stage,
        quoteId: parsed.data.quoteId,
        offerNo: parsed.data.offerNo,
        status: pdfResponse.status,
        innerReference,
        innerError,
        deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA,
      });
      return NextResponse.json({
        error: `Could not prepare the quotation PDF. (Ref: ${reference})`,
        reference,
      }, { status: pdfResponse.status });
    }

    stage = "pdf_validation";
    const pdf = Buffer.from(await pdfResponse.arrayBuffer());
    if (pdf.length === 0 || pdf.subarray(0, 4).toString("ascii") !== "%PDF") {
      throw new Error("The generated quotation file is empty or invalid.");
    }
    stage = "blob_upload";
    const blobStarted = Date.now();
    const blob = await put(`quotations/${randomUUID()}.pdf`, pdf, {
      access: "public",
      contentType: "application/pdf",
      token: blobToken,
    });
    const blobUrl = new URL(blob.url);
    if (blobUrl.protocol !== "https:") {
      throw new Error("Vercel Blob returned a non-HTTPS quotation URL.");
    }
    logPerf("api.quotations.share.upload", Date.now() - blobStarted, { bytes: pdf.length });
    if (savedQuote) {
      stage = "pdf_storage";
      await saveStoredQuotationPdf(savedQuote.id, {
        url: blobUrl.toString(),
        ownerId: savedQuote.ownerId,
        executive: savedQuote.executive,
      });
    }
    return NextResponse.json({ url: blobUrl.toString() });
  } catch (error) {
    const reference = newErrorReference();
    console.error("[api] quotation share preparation failed", {
      reference,
      quoteId: parsed.data.quoteId,
      offerNo: parsed.data.offerNo,
      stage,
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      cause: error instanceof Error ? describeErrorCause(error.cause) : undefined,
      deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA,
    });
    return NextResponse.json({
      error: `Could not prepare a shareable quotation PDF. (Ref: ${reference})`,
      reference,
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const started = Date.now();
  try {
    return await handlePost(request);
  } finally {
    logPerf("api.quotations.share", Date.now() - started);
  }
}
