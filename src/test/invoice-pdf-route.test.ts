import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  getInvoice: vi.fn(),
  canAccess: vi.fn(),
  visibleFor: vi.fn(),
  env: vi.fn(),
  renderInvoicePdf: vi.fn(),
  getStoredInvoicePdf: vi.fn(),
  saveStoredInvoicePdf: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ put: mocks.put }));
vi.mock("@/lib/auth/guard", () => ({ currentUser: mocks.currentUser }));
vi.mock("@/lib/crm", () => ({ crm: () => ({ getInvoice: mocks.getInvoice }) }));
vi.mock("@/lib/domain", () => ({
  canAccess: mocks.canAccess,
  visibleFor: mocks.visibleFor,
}));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/crm-action-errors", () => ({ newErrorReference: () => "PDF-REF" }));
vi.mock("@/lib/invoice-pdf", () => ({ renderInvoicePdf: mocks.renderInvoicePdf }));
vi.mock("@/lib/invoice-pdf-store", () => ({
  getStoredInvoicePdf: mocks.getStoredInvoicePdf,
  saveStoredInvoicePdf: mocks.saveStoredInvoicePdf,
}));

const user = { id: "manager-1", name: "Manager", role: "Manager" };
const invoice = {
  id: "invoice-1",
  invoiceNo: "INV/26-27/0001",
  ownerId: "exec-1",
  executive: "Executive",
};
const bytes = new Uint8Array([37, 80, 68, 70]);

beforeEach(() => {
  vi.resetModules();
  mocks.currentUser.mockReset().mockResolvedValue(user);
  mocks.getInvoice.mockReset().mockResolvedValue(invoice);
  mocks.canAccess.mockReset().mockReturnValue(true);
  mocks.visibleFor.mockReset().mockReturnValue([invoice]);
  mocks.env.mockReset().mockReturnValue({ BLOB_READ_WRITE_TOKEN: "blob-secret" });
  mocks.renderInvoicePdf.mockReset().mockResolvedValue(bytes);
  mocks.getStoredInvoicePdf.mockReset().mockResolvedValue(null);
  mocks.saveStoredInvoicePdf.mockReset().mockResolvedValue(undefined);
  mocks.put.mockReset().mockResolvedValue({ url: "https://blob.example/invoice.pdf" });
});

describe("invoice PDF Blob fallback", () => {
  it("serves the rendered PDF inline when the Blob upload fails and logs the sanitized error", async () => {
    const secret = "blob-secret";
    const uploadError = new Error(`Blob upload failed using ${secret}`);
    mocks.put.mockRejectedValue(uploadError);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/invoices/[id]/pdf/route");

    const response = await GET(
      new NextRequest("https://portal.example/api/invoices/invoice-1/pdf?inline=1"),
      { params: Promise.resolve({ id: invoice.id }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("inline;");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...bytes]);
    expect(log).toHaveBeenCalledWith(
      "[api] invoice PDF storage unavailable; returning PDF directly",
      expect.objectContaining({
        message: "Blob upload failed using [redacted]",
        stack: expect.not.stringContaining(secret),
      }),
    );
    log.mockRestore();
  });

  it("serves the rendered PDF as an attachment when Blob is not configured", async () => {
    mocks.env.mockReturnValue({});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/invoices/[id]/pdf/route");

    const response = await GET(
      new NextRequest("https://portal.example/api/invoices/invoice-1/pdf?download=1"),
      { params: Promise.resolve({ id: invoice.id }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...bytes]);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[api] invoice PDF storage unavailable; returning PDF directly",
      expect.objectContaining({
        message: "BLOB_READ_WRITE_TOKEN is not configured.",
        stack: expect.any(String),
      }),
    );
    log.mockRestore();
  });
});
