import { z } from "zod";
import { after, NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { STATIC_USERS } from "@/lib/auth/users";
import { hashResetToken, newResetToken, passwordStore } from "@/lib/auth/password-store";
import { sendEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

const GENERIC_MESSAGE = "If an account exists for that email address, a password reset link will be sent.";
const requestSchema = z.object({ email: z.string().trim().email().max(254) });

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}

function clientIp(request: NextRequest) {
  return request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
}

export async function POST(request: NextRequest) {
  let email = "";
  try {
    const body: unknown = await request.json();
    const parsed = requestSchema.safeParse(body);
    if (parsed.success) email = parsed.data.email.toLowerCase();
  } catch {
    // Invalid request bodies receive the same response as unknown email addresses.
  }

  after(async () => {
    try {
      if (!email) return;
      const [emailAllowed, ipAllowed] = await Promise.all([
        passwordStore.takeResetRateLimit(`email:${email}`, 3, 15 * 60),
        passwordStore.takeResetRateLimit(`ip:${clientIp(request)}`, 10, 15 * 60),
      ]);
      if (!emailAllowed || !ipAllowed) return;

      const user = STATIC_USERS.find((candidate) => candidate.email?.trim().toLowerCase() === email);
      if (!user?.email?.trim()) return;

      const config = env();
      const token = newResetToken();
      const tokenHash = hashResetToken(token);
      await passwordStore.createResetToken(tokenHash, user.username);
      const baseUrl = config.APP_URL ?? request.nextUrl.origin;
      const resetUrl = new URL("/reset-password", baseUrl);
      resetUrl.searchParams.set("token", token);
      const link = resetUrl.toString();
      const logoUrl = new URL("/brand/atpl-logo.webp", baseUrl).toString();

      try {
        await sendEmail({
          to: user.email,
          subject: "Reset your ATPL Sales Portal password",
          text: [
            "Hello,",
            "",
            "We received a request to reset the password for your ATPL Sales Portal account.",
            `Reset your password using this single-use link within 30 minutes: ${link}`,
            "",
            "If you did not request a reset, you can safely ignore this email.",
            "Air Trendz Private Limited",
          ].join("\n"),
          html: `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f3f6fa;font-family:Arial,Helvetica,sans-serif;color:#172554">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px;background:#f3f6fa">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5eaf1;border-radius:16px">
          <tr><td align="center" style="padding:30px 28px 18px">
            <img src="${escapeHtml(logoUrl)}" width="180" alt="ATPL - Air Trendz Private Limited" style="display:block;width:180px;max-width:100%;height:auto">
          </td></tr>
          <tr><td style="padding:12px 32px 32px">
            <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3">Reset your password</h1>
            <p style="margin:0 0 22px;color:#475569;font-size:15px;line-height:1.6">We received a request to reset the password for your ATPL Sales Portal account. Use the secure button below to choose a new password.</p>
            <p style="margin:0 0 24px;text-align:center">
              <a href="${escapeHtml(link)}" style="display:inline-block;padding:14px 24px;border-radius:8px;background:#1e7fd0;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none">Reset Password</a>
            </p>
            <p style="margin:0 0 12px;color:#475569;font-size:13px;line-height:1.6">This single-use link expires in 30 minutes. If the button does not work, copy and paste this address into your browser:</p>
            <p style="margin:0 0 22px;word-break:break-all;font-size:12px;line-height:1.6"><a href="${escapeHtml(link)}" style="color:#1e7fd0">${escapeHtml(link)}</a></p>
            <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6">If you did not request a password reset, you can safely ignore this email. Your password will not change.</p>
          </td></tr>
          <tr><td style="padding:16px 32px;border-top:1px solid #e5eaf1;color:#64748b;font-size:12px;text-align:center">Air Trendz Private Limited · ATPL Sales Portal</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`,
        });
      } catch (error) {
        await passwordStore.deleteResetToken(tokenHash);
        console.error("[auth] password reset email could not be sent", {
          username: user.username,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      console.error("[auth] password reset request failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return NextResponse.json({ message: GENERIC_MESSAGE }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
