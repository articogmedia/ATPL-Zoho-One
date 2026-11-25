import "server-only";
import nodemailer from "nodemailer";
import { env } from "@/lib/env";

let gmailTransport: ReturnType<typeof nodemailer.createTransport> | undefined;

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export async function sendEmail(message: EmailMessage): Promise<void> {
  const config = env();
  if (config.EMAIL_PROVIDER === "disabled") {
    throw new Error("Email is not configured.");
  }
  if (config.EMAIL_PROVIDER === "gmail") {
    try {
      if (!gmailTransport) {
        gmailTransport = nodemailer.createTransport({
          host: "smtp.gmail.com",
          port: 465,
          secure: true,
          auth: { user: config.GMAIL_USER!, pass: config.GMAIL_APP_PASSWORD! },
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 15_000,
        });
      }
      await gmailTransport.sendMail({
        from: config.EMAIL_FROM
          ? `Air Trendz <${config.EMAIL_FROM}>`
          : `Air Trendz <${config.GMAIL_USER}>`,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
      return;
    } catch (error) {
      const smtpError = typeof error === "object" && error !== null
        ? error as { code?: string; responseCode?: number }
        : {};
      console.error("[email] Gmail SMTP send failed", {
        code: smtpError.code,
        responseCode: smtpError.responseCode,
      });
      throw new Error(smtpError.code === "EAUTH"
        ? "Email sign-in to Gmail failed. Check GMAIL_USER and the App Password."
        : "Could not send the email through Gmail.");
    }
  }
  if (config.EMAIL_PROVIDER === "resend") {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Email provider rejected the message (HTTP ${response.status}).`);
  }
}
