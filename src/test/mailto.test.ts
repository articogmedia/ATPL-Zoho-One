import { describe, expect, it } from "vitest";
import { buildMailtoUrl } from "@/lib/mailto";

describe("buildMailtoUrl", () => {
  it("encodes the subject and body while preserving the recipient and PDF URL", () => {
    const recipient = "buyer+quotes@example.com";
    const subject = "Quotation 279/26-27 from Air Trendz Pvt Ltd";
    const body = [
      "Dear Customer,",
      "",
      "Please find your quotation 279/26-27 from Air Trendz Pvt Ltd.",
      "Grand total: ₹1,18,000.00",
      "Quotation PDF: https://blob.example/offer.pdf?token=a&format=pdf",
    ].join("\n");
    const mailto = buildMailtoUrl(recipient, subject, body);
    const query = new URLSearchParams(mailto.slice(mailto.indexOf("?") + 1));

    expect(mailto).toBe(`mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
    expect(mailto).toContain(encodeURIComponent(subject));
    expect(query.get("subject")).toBe(subject);
    expect(query.get("body")).toContain("Quotation PDF: https://blob.example/offer.pdf?token=a&format=pdf");
  });
});
