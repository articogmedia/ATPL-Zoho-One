import { put } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/guard";
import { crm } from "@/lib/crm";
import { env } from "@/lib/env";
import { newErrorReference } from "@/lib/crm-action-errors";
import { canAccess, visibleFor } from "@/lib/domain";
import { renderInvoicePdf } from "@/lib/invoice-pdf";
import { getStoredInvoicePdf, saveStoredInvoicePdf } from "@/lib/invoice-pdf-store";

export const runtime = "nodejs";
export const preferredRegion = "bom1";
export const maxDuration = 30;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (!canAccess(user.role, "invoices")) {
    return NextResponse.json({ error: "Invoice access denied." }, { status: 403 });
  }
  const { id } = await params;
  try {
    const invoice = await crm().getInvoice(id);
    if (!invoice || visibleFor(user, [invoice]).length === 0) {
      return NextResponse.json({ error: "Invoice not found or access denied." }, { status: 404 });
    }
    const stored = await getStoredInvoicePdf(id);
    if (stored?.url) {
      if (new URL(request.url).searchParams.get("download") !== "1") {
        return NextResponse.redirect(stored.url);
      }
      const response = await fetch(stored.url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Stored invoice PDF could not be fetched (HTTP ${response.status}).`);
      return new NextResponse(await response.arrayBuffer(), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${invoice.invoiceNo.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf"`,
          "Cache-Control": "private, no-store",
        },
      });
    }

    const pdf = await renderInvoicePdf(invoice);
    const blobToken = env().BLOB_READ_WRITE_TOKEN;
    if (blobToken) {
      const blob = await put(`invoices/${randomUUID()}.pdf`, Buffer.from(pdf), {
        access: "public",
        contentType: "application/pdf",
        token: blobToken,
      });
      await saveStoredInvoicePdf(id, {
        url: blob.url,
        ownerId: invoice.ownerId,
        executive: invoice.executive,
      });
      return NextResponse.redirect(blob.url);
    }
    const inline = new URL(request.url).searchParams.get("inline") === "1";
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${invoice.invoiceNo.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    const reference = newErrorReference();
    console.error("[api] invoice PDF generation failed", {
      reference,
      invoiceId: id,
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: `Could not generate the invoice PDF. (Ref: ${reference})` }, { status: 500 });
  }
}
