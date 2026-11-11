import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resetPasswordWithToken } from "@/lib/auth/password-store";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  token: z.string().min(1).max(256),
  password: z.string().min(10).max(128),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Provide a valid reset request." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Password must be between 10 and 128 characters." }, { status: 400 });
  }

  try {
    if (!await resetPasswordWithToken(parsed.data.token, parsed.data.password)) {
      return NextResponse.json({ error: "This password reset link is invalid or expired." }, { status: 400 });
    }
    return NextResponse.json({ message: "Password updated. You can now sign in." }, { status: 200 });
  } catch (error) {
    console.error("[auth] password reset failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Password reset is temporarily unavailable. Please try again." }, { status: 503 });
  }
}
