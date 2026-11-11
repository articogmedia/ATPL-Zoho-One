import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const envMock = vi.hoisted(() => ({ env: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: envMock.env }));

describe("sendEmail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends through the configured Resend provider", async () => {
    envMock.env.mockReturnValue({
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: "quotes@example.com",
      RESEND_API_KEY: "test-key",
    });

    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const { sendEmail } = await import("@/lib/email");

    await sendEmail({ to: "customer@example.com", subject: "Offer", text: "PDF link" });

    expect(fetch).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      body: JSON.stringify({
        from: "quotes@example.com",
        to: ["customer@example.com"],
        subject: "Offer",
        text: "PDF link",
      }),
    }));
  });

  it("includes the branded HTML body when supplied", async () => {
    envMock.env.mockReturnValue({
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: "portal@example.com",
      RESEND_API_KEY: "test-key",
    });
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const { sendEmail } = await import("@/lib/email");

    await sendEmail({
      to: "staff@example.com",
      subject: "Reset password",
      text: "Reset your password",
      html: "<p>Reset your password</p>",
    });

    expect(JSON.parse(fetch.mock.calls[0]?.[1].body as string)).toMatchObject({
      html: "<p>Reset your password</p>",
    });
  });

  it("fails explicitly when email delivery is disabled or rejected", async () => {
    const { sendEmail } = await import("@/lib/email");
    envMock.env.mockReturnValue({ EMAIL_PROVIDER: "disabled" });
    await expect(sendEmail({ to: "customer@example.com", subject: "Offer", text: "Body" }))
      .rejects.toThrow("delivery is disabled");

    envMock.env.mockReturnValue({
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: "quotes@example.com",
      RESEND_API_KEY: "test-key",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422 }));
    await expect(sendEmail({ to: "customer@example.com", subject: "Offer", text: "Body" }))
      .rejects.toThrow("HTTP 422");
  });
});
