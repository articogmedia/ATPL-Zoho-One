import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  takeResetRateLimit: vi.fn(),
  createResetToken: vi.fn(),
  deleteResetToken: vi.fn(),
  resetPasswordWithToken: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/auth/users", () => ({
  STATIC_USERS: [
    { username: "pavan", email: "pavan@example.com" },
  ],
}));
vi.mock("@/lib/auth/password-store", () => ({
  passwordStore: {
    takeResetRateLimit: mocks.takeResetRateLimit,
    createResetToken: mocks.createResetToken,
    deleteResetToken: mocks.deleteResetToken,
  },
  hashResetToken: (token: string) => `hash:${token}`,
  newResetToken: () => "one-time-token",
  resetPasswordWithToken: mocks.resetPasswordWithToken,
}));
vi.mock("@/lib/email", () => ({ sendEmail: mocks.sendEmail }));

describe("password reset APIs", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.takeResetRateLimit.mockReset().mockResolvedValue(true);
    mocks.createResetToken.mockReset().mockResolvedValue(undefined);
    mocks.deleteResetToken.mockReset().mockResolvedValue(undefined);
    mocks.resetPasswordWithToken.mockReset().mockResolvedValue(true);
    mocks.sendEmail.mockReset().mockResolvedValue(undefined);
  });

  it("returns the same generic response for known and unknown usernames", async () => {
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const known = await POST(new NextRequest("https://portal.example/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.1" },
      body: JSON.stringify({ username: "pavan" }),
    }));
    const unknown = await POST(new NextRequest("https://portal.example/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.1" },
      body: JSON.stringify({ username: "nobody" }),
    }));

    expect(known.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.createResetToken).toHaveBeenCalledWith("hash:one-time-token", "pavan");
    const message = mocks.sendEmail.mock.calls[0]?.[0];
    expect(message.text).toContain("https://portal.example/reset-password?token=one-time-token");
  });

  it("rate-limits reset requests by both normalized username and client IP", async () => {
    mocks.takeResetRateLimit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const response = await POST(new NextRequest("https://portal.example/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.2" },
      body: JSON.stringify({ username: "PAVAN" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.takeResetRateLimit).toHaveBeenNthCalledWith(1, "username:pavan", 3, 900);
    expect(mocks.takeResetRateLimit).toHaveBeenNthCalledWith(2, "ip:203.0.113.2", 10, 900);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("rejects a wrong reset token and enforces the password length", async () => {
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const weakPassword = await POST(new NextRequest("https://portal.example/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong", password: "short" }),
    }));
    expect(weakPassword.status).toBe(400);
    expect(mocks.resetPasswordWithToken).not.toHaveBeenCalled();

    mocks.resetPasswordWithToken.mockResolvedValue(false);
    const wrongToken = await POST(new NextRequest("https://portal.example/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong", password: "long-enough-password" }),
    }));
    expect(wrongToken.status).toBe(400);
    expect(await wrongToken.json()).toMatchObject({ error: "This password reset link is invalid or expired." });
  });
});
