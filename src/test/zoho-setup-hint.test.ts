import { describe, expect, it, vi } from "vitest";
import { ZohoError } from "@/lib/zoho/client";
import { describeLoadProblem } from "@/lib/zoho-setup-hint";

vi.mock("@/lib/zoho/client", () => ({
  ZohoError: class ZohoError extends Error {
    constructor(
      message: string,
      readonly status?: number,
      readonly code?: string,
      readonly field?: string,
      readonly invalidValue?: unknown,
      readonly operation?: string,
      readonly details?: Record<string, unknown>,
      readonly reference?: string,
    ) { super(message); }
  },
}));

describe("Zoho setup hints", () => {
  it("names the module and field for invalid search criteria", () => {
    const error = new ZohoError(
      "Invalid query formed",
      400,
      "INVALID_QUERY",
      "Lead_Ref",
      undefined,
      "GET /Quotes/search?criteria=%28Lead_Ref.id%3Ain%3A123%29",
    );

    const problem = describeLoadProblem(error, "Invoices");

    expect(problem.hint).toContain("search used a field that doesn't exist in the Quotes module");
    expect(problem.hint).toContain("Lead_Ref");
    expect(problem.hint).not.toContain("ATPL_Invoice_No");
  });

  it("shows invoice field setup only for an Invoices-module field rejection", () => {
    const invoicesError = new ZohoError(
      "Invalid data",
      400,
      "INVALID_DATA",
      "ATPL_Source_Quote_ID",
      undefined,
      "POST /Invoices",
    );
    const quotesError = new ZohoError(
      "Invalid data",
      400,
      "INVALID_DATA",
      "Customer_Snapshot",
      undefined,
      "GET /Quotes/search",
    );

    const invoiceHint = describeLoadProblem(invoicesError, "Invoices").hint ?? "";
    const quoteHint = describeLoadProblem(quotesError, "Invoices").hint ?? "";

    expect(invoiceHint).toContain("ATPL_Source_Quote_ID");
    expect(invoiceHint).toContain("ATPL_Invoice_No");
    expect(quoteHint).toContain("Customer_Snapshot");
    expect(quoteHint).toContain("Quotes module");
    expect(quoteHint).not.toContain("ATPL_Invoice_No");
  });
});
