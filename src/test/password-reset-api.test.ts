import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  const afterTasks: Array<() => void | Promise<void>> = [];
  return {
    takeResetRateLimit: vi.fn(),
    createResetToken: vi.fn(),
    deleteResetToken: vi.fn(),
    resetPasswordWithToken: vi.fn(),
    sendEmail: vi.fn(),
    env: vi.fn(),
    afterTasks,
    after: vi.fn((task: () => void | Promise<void>) => {
      afterTasks.push(task);
    }),
  };
});

vi.mock("@/lib/auth/users", () => ({
  STATIC_USERS: [
    { username: "pavan", email: "Pavan@example.com" },
  ],
}));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mocks.after };
});
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
    mocks.env.mockReturnValue({ APP_URL: "https://portal.example" });
    mocks.afterTasks.length = 0;
  });

  it("returns the same generic response for registered and unknown email addresses", async () => {
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const known = await POST(new NextRequest("https://untrusted-host.example/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.1" },
      body: JSON.stringify({ email: " PAVAN@example.com " }),
    }));
    const unknown = await POST(new NextRequest("https://portal.example/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.1" },
      body: JSON.stringify({ email: "nobody@example.com" }),
    }));

    expect(known.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    await Promise.all(mocks.afterTasks.splice(0).map((task) => task()));
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.createResetToken).toHaveBeenCalledWith("hash:one-time-token", "pavan");
    const message = mocks.sendEmail.mock.calls[0]?.[0];
    expect(message.text).toContain("https://portal.example/reset-password?token=one-time-token");
    expect(message.html).toContain('alt="ATPL - Air Trendz Private Limited"');
    expect(message.html).toContain(">Reset Password</a>");
    expect(message.html).toContain("expires in 30 minutes");
    expect(message.to).toBe("Pavan@example.com");
  });

  it("rate-limits reset requests by normalized email and client IP", async () => {
    mocks.takeResetRateLimit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const response = await POST(new NextRequest("https://portal.example/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.2" },
      body: JSON.stringify({ email: "PAVAN@example.com" }),
    }));

    expect(response.status).toBe(200);
    await Promise.all(mocks.afterTasks.splice(0).map((task) => task()));
    expect(mocks.takeResetRateLimit).toHaveBeenNthCalledWith(1, "email:pavan@example.com", 3, 900);
    expect(mocks.takeResetRateLimit).toHaveBeenNthCalledWith(2, "ip:203.0.113.2", 10, 900);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("rejects mismatched confirmation, weak passwords, and wrong reset tokens", async () => {
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const mismatch = await POST(new NextRequest("https://portal.example/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong", password: "long-enough-password", confirmPassword: "different-password" }),
    }));
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: "Passwords do not match." });
    expect(mocks.resetPasswordWithToken).not.toHaveBeenCalled();

    const weakPassword = await POST(new NextRequest("https://portal.example/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong", password: "short", confirmPassword: "short" }),
    }));
    expect(weakPassword.status).toBe(400);
    expect(mocks.resetPasswordWithToken).not.toHaveBeenCalled();

    mocks.resetPasswordWithToken.mockResolvedValue(false);
    const wrongToken = await POST(new NextRequest("https://portal.example/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong", password: "long-enough-password", confirmPassword: "long-enough-password" }),
    }));
    expect(wrongToken.status).toBe(400);
    expect(await wrongToken.json()).toMatchObject({ error: "This password reset link is invalid or expired." });
  });
});
