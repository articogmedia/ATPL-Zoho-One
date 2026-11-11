import { NextRequest, NextResponse } from "next/server";
import { STATIC_USERS } from "@/lib/auth/users";
import { hashResetToken, newResetToken, passwordStore } from "@/lib/auth/password-store";
import { sendEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

const GENERIC_MESSAGE = "If an account exists for that username, a password reset link will be sent.";

function clientIp(request: NextRequest) {
  return request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
}

export async function POST(request: NextRequest) {
  let username = "";
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && "username" in body && typeof body.username === "string") {
      username = body.username.trim().toLowerCase().slice(0, 64);
    }
  } catch {
    // Invalid request bodies receive the same response as unknown usernames.
  }

  try {
    const [usernameAllowed, ipAllowed] = await Promise.all([
      passwordStore.takeResetRateLimit(`username:${username}`, 3, 15 * 60),
      passwordStore.takeResetRateLimit(`ip:${clientIp(request)}`, 10, 15 * 60),
    ]);
    if (usernameAllowed && ipAllowed) {
      const user = STATIC_USERS.find((candidate) => candidate.username === username);
      if (user?.email?.trim()) {
        const token = newResetToken();
        const tokenHash = hashResetToken(token);
        await passwordStore.createResetToken(tokenHash, user.username);
        const resetUrl = new URL("/reset-password", request.url);
        resetUrl.searchParams.set("token", token);
        try {
          await sendEmail({
            to: user.email,
            subject: "Reset your ATPL Sales Portal password",
            text: `Use this single-use link within 30 minutes to reset your password: ${resetUrl.toString()}`,
          });
        } catch (error) {
          await passwordStore.deleteResetToken(tokenHash);
          console.error("[auth] password reset email could not be sent", {
            username: user.username,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  } catch (error) {
    console.error("[auth] password reset request failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return NextResponse.json({ message: GENERIC_MESSAGE }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
