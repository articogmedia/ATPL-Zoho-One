import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const envMock = vi.hoisted(() => ({ env: vi.fn() }));
const nodemailerMock = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: envMock.env }));
vi.mock("nodemailer", () => ({ default: { createTransport: nodemailerMock.createTransport } }));

describe("sendEmail", () => {
  beforeEach(() => {
    vi.resetModules();
    nodemailerMock.createTransport.mockReset();
  });

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

  it("sends through Gmail SMTP with the configured message fields", async () => {
    envMock.env.mockReturnValue({
      EMAIL_PROVIDER: "gmail",
      GMAIL_USER: "sales@gmail.com",
      GMAIL_APP_PASSWORD: "gmail-app-password",
    });
    const sendMail = vi.fn().mockResolvedValue(undefined);
    nodemailerMock.createTransport.mockReturnValue({ sendMail });
    const { sendEmail } = await import("@/lib/email");

    await sendEmail({ to: "customer@example.com", subject: "Offer", text: "PDF link" });

    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: "sales@gmail.com", pass: "gmail-app-password" },
    }));
    expect(sendMail).toHaveBeenCalledWith({
      from: "Air Trendz <sales@gmail.com>",
      to: "customer@example.com",
      subject: "Offer",
      text: "PDF link",
    });
  });

  it.each([
    {
      error: Object.assign(new Error("secret smtp response"), { code: "EAUTH", responseCode: 535 }),
      message: "Email sign-in to Gmail failed. Check GMAIL_USER and the App Password.",
    },
    {
      error: new Error("secret smtp response"),
      message: "Could not send the email through Gmail.",
    },
  ])("returns a safe friendly error when Gmail delivery fails", async ({ error, message }) => {
    envMock.env.mockReturnValue({
      EMAIL_PROVIDER: "gmail",
      GMAIL_USER: "sales@gmail.com",
      GMAIL_APP_PASSWORD: "gmail-app-password",
    });
    const sendMail = vi.fn().mockRejectedValue(error);
    nodemailerMock.createTransport.mockReturnValue({ sendMail });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendEmail } = await import("@/lib/email");

    await expect(sendEmail({ to: "customer@example.com", subject: "Offer", text: "Body" }))
      .rejects.toThrow(message);
    expect(errorLog).toHaveBeenCalledWith("[email] Gmail SMTP send failed", {
      code: "code" in error ? error.code : undefined,
      responseCode: "responseCode" in error ? error.responseCode : undefined,
    });
    expect(errorLog).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("secret smtp response"));
  });

  it("fails explicitly when email delivery is disabled or rejected", async () => {
    const { sendEmail } = await import("@/lib/email");
    envMock.env.mockReturnValue({ EMAIL_PROVIDER: "disabled" });
    await expect(sendEmail({ to: "customer@example.com", subject: "Offer", text: "Body" }))
      .rejects.toThrow("Email is not configured.");

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
