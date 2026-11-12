// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Product, Quotation } from "@/lib/domain";

const mocks = vi.hoisted(() => ({
  createQuoteAction: vi.fn(),
  getProductsAction: vi.fn(),
  getQuotationPdfUrlAction: vi.fn(),
  getQuoteDetailAction: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/use-mutation", () => ({
  executeMutation: (action: (input: unknown) => Promise<unknown>, input: unknown) => action(input),
  friendlyMutationError: (error: unknown) => String(error),
  notifyMutationFailure: vi.fn(),
}));
vi.mock("@/app/actions/crm", () => ({
  addLeadAction: vi.fn(),
  createProductAction: vi.fn(),
  createQuoteAction: mocks.createQuoteAction,
  getLeadSourcesAction: vi.fn(),
  getProductsAction: mocks.getProductsAction,
  getQuoteDetailAction: mocks.getQuoteDetailAction,
  getQuotationPdfUrlAction: mocks.getQuotationPdfUrlAction,
  markQuotationSentAction: vi.fn(),
  refreshProductsAction: vi.fn(),
  sendQuotationEmailAction: vi.fn(),
  setLeadOutcomeAction: vi.fn(),
  updateQuoteAction: vi.fn(),
}));
vi.mock("@/components/ui-bits", () => ({
  EmptyState: ({ message }: { message: string }) => <p>{message}</p>,
  PageHeader: ({ title, action }: { title: string; action?: ReactNode }) => <header><h1>{title}</h1>{action}</header>,
  ResponsiveTable: ({ rows, renderCard }: { rows: Quotation[]; renderCard: (row: Quotation) => ReactNode }) =>
    <div>{rows.map((row) => <div key={row.id}>{renderCard(row)}</div>)}</div>,
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
  fieldClass: "",
}));

const lead = {
  id: "lead-1",
  name: "Original Customer",
  company: "Original Company",
  phone: "9876543210",
  area: "",
  source: "Direct Call" as const,
  status: "Fresh Lead" as const,
  assignedTo: "Manager",
  ownerId: "manager-1",
  remarks: "",
  createdOn: "2026-11-12",
  address: "",
  touchedBy: [],
};
const product: Product = { id: "product-1", model: "AC Unit", code: "AC-1", price: 100, unit: "Nos", gstRate: 0.18 };
const savedQuote: Quotation = {
  id: "quote-1",
  offerNo: "279/26-27",
  leadId: "lead-1",
  customer: "Original Company",
  contactName: "Original Customer",
  company: "Original Company",
  phone: "9876543210",
  executive: "Manager",
  ownerId: "manager-1",
  total: 118,
  date: "2026-11-12",
  status: "Draft",
  items: [{ productId: product.id, model: product.model, unit: product.unit, qty: 1, price: product.price, taxRate: 0.18 }],
};
const otherQuote: Quotation = {
  ...savedQuote,
  id: "quote-2",
  offerNo: "278/26-27",
  customer: "Different Company",
  contactName: "Different Customer",
  company: "Different Company",
  pdfSnapshotToken: "snapshot-token",
};

let root: Root | undefined;
let host: HTMLDivElement;

async function click(element: Element | null) {
  if (!(element instanceof HTMLElement)) throw new Error("Expected clickable element was not found.");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(text: string) {
  return [...host.querySelectorAll("button")].find((item) => item.textContent?.trim().includes(text)) ?? null;
}

describe("quotation PDF error state", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createQuoteAction.mockReset().mockResolvedValue({ ok: true, data: savedQuote });
    mocks.getProductsAction.mockReset().mockResolvedValue({ ok: true, data: [product] });
    mocks.getQuotationPdfUrlAction.mockReset().mockResolvedValue({ ok: true, data: null });
    mocks.getQuoteDetailAction.mockReset().mockResolvedValue({ ok: true, data: otherQuote });
    mocks.toast.error.mockReset();
    mocks.toast.success.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    class TestResizeObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = undefined;
    }
    host.remove();
    vi.unstubAllGlobals();
  });

  it("clears an old PDF error when opening a different saved quotation", async () => {
    let shareRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/quotations/share" && init?.method === "POST") {
        shareRequests += 1;
        return shareRequests === 1
          ? new Response(JSON.stringify({ error: "Could not prepare a shareable quotation PDF. (Ref: 5DEA06E872F0)" }), { status: 500 })
          : new Response(JSON.stringify({ url: "https://blob.example/other.pdf" }), { status: 200 });
      }
      if (url === "/api/quotations?page=1") {
        return new Response(JSON.stringify({ quotes: [savedQuote, otherQuote], count: 48, hasMore: false }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { QuotationsClient } = await import("@/app/(app)/quotations/QuotationsClient");
    root = createRoot(host);
    await act(async () => {
      root?.render(<QuotationsClient
        leads={[lead]}
        initialCustomersHasMore={false}
        initialSavedQuotesCount={48}
        leadSources={[]}
        leadSourcesUnavailable={false}
        products={[product]}
        emailConfigured
        isManager
        suggestedOfferNo="280/26-27"
        presetLeadId="lead-1"
      />);
    });

    await click(host.querySelector('button[aria-label="Item 1 product"]'));
    await click(host.querySelector('[role="option"]'));
    await click(button("Preview Offer"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("5DEA06E872F0");
    expect(mocks.toast.success).not.toHaveBeenCalledWith("Quotation saved as Draft");

    await click(button("Saved quotations"));
    const otherQuoteCard = [...host.querySelectorAll("article")].find((article) => article.textContent?.includes("Different Company"));
    const viewOtherQuote = [...(otherQuoteCard?.querySelectorAll("button") ?? [])]
      .find((item) => item.textContent?.trim() === "View") ?? null;
    await click(viewOtherQuote);
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe("https://blob.example/other.pdf");
    await click(button("Back to quotations"));
    await click(host.querySelector('button[aria-label="Close saved quotations"]'));

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.createQuoteAction).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/quotations/share")).toHaveLength(2);
  });

  it("retries PDF preparation for the existing saved quote without creating another quotation", async () => {
    let shareRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/quotations/share") {
        expect(init?.method).toBe("POST");
        shareRequests += 1;
        return shareRequests === 1
          ? new Response(JSON.stringify({ error: "Could not prepare PDF (step: blob_upload). Ref: PDF-REF", stage: "blob_upload", reference: "PDF-REF" }), { status: 500 })
          : new Response(JSON.stringify({ url: "https://blob.example/retried.pdf" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.getQuoteDetailAction.mockResolvedValue({
      ok: true,
      data: { ...savedQuote, pdfSnapshotToken: "fresh-snapshot" },
    });
    const { QuotationsClient } = await import("@/app/(app)/quotations/QuotationsClient");
    root = createRoot(host);
    await act(async () => {
      root?.render(<QuotationsClient
        leads={[lead]}
        initialCustomersHasMore={false}
        initialSavedQuotesCount={48}
        leadSources={[]}
        leadSourcesUnavailable={false}
        products={[product]}
        emailConfigured
        isManager
        suggestedOfferNo="280/26-27"
        presetLeadId="lead-1"
      />);
    });

    await click(host.querySelector('button[aria-label="Item 1 product"]'));
    await click(host.querySelector('[role="option"]'));
    await click(button("Preview Offer"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("blob_upload");
    await click(button("Retry PDF"));

    expect(mocks.createQuoteAction).toHaveBeenCalledOnce();
    expect(mocks.getQuoteDetailAction).toHaveBeenCalledWith(savedQuote.id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(retryPayload).toMatchObject({
      quoteId: savedQuote.id,
      quoteSnapshotToken: "fresh-snapshot",
    });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
