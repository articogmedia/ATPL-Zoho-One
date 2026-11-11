import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("password storage and reset tokens", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("seeds a salted password hash from the environment on first successful login", async () => {
    vi.resetModules();
    vi.stubEnv("ATPL_PAVAN_PASSWORD", "legacy-password");
    const { authenticateStaticCredentials, createMemoryPasswordStore, verifyPasswordHash } =
      await import("@/lib/auth/password-store");
    const store = createMemoryPasswordStore();

    await expect(authenticateStaticCredentials("pavan", "wrong", store)).resolves.toBeNull();
    await expect(store.getPasswordHash("pavan")).resolves.toBeUndefined();
    await expect(authenticateStaticCredentials("pavan", "legacy-password", store)).resolves.toMatchObject({ username: "pavan" });

    const encoded = await store.getPasswordHash("pavan");
    expect(encoded).toMatch(/^scrypt\$[a-f\d]{32}\$[a-f\d]{128}$/);
    expect(await verifyPasswordHash("legacy-password", encoded!)).toBe(true);
    vi.stubEnv("ATPL_PAVAN_PASSWORD", "changed-environment-value");
    await expect(authenticateStaticCredentials("pavan", "legacy-password", store)).resolves.toMatchObject({ username: "pavan" });
  });

  it("rejects expired, wrong, and already-used reset tokens", async () => {
    vi.resetModules();
    const { createMemoryPasswordStore, hashPassword, hashResetToken } =
      await import("@/lib/auth/password-store");
    const store = createMemoryPasswordStore();
    const token = "single-use-test-token";
    await store.createResetToken(hashResetToken(token), "pavan");
    const hash = await hashPassword("first-new-password");

    expect(await store.consumeResetToken(hashResetToken("wrong-token"), hash)).toBeUndefined();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 30 * 60 * 1000 + 1);
    expect(await store.consumeResetToken(hashResetToken(token), hash)).toBeUndefined();
    vi.restoreAllMocks();

    await store.createResetToken(hashResetToken(token), "pavan");
    expect(await store.consumeResetToken(hashResetToken(token), hash)).toBe("pavan");
    expect(await store.consumeResetToken(hashResetToken(token), hash)).toBeUndefined();
  });

  it("clears the login lockout and increments the session version after a valid token reset", async () => {
    vi.resetModules();
    const { MemoryLoginAttemptStore } = await import("@/lib/auth/login-attempt-store");
    const { createMemoryPasswordStore, hashResetToken, resetPasswordWithToken, verifyPasswordHash } =
      await import("@/lib/auth/password-store");
    const store = createMemoryPasswordStore();
    const attempts = new MemoryLoginAttemptStore();
    const token = "lockout-reset-token";
    await store.createResetToken(hashResetToken(token), "pavan");
    await attempts.set("pavan", { count: 0, lockedUntil: Date.now() + 60_000 });

    await expect(resetPasswordWithToken(token, "new-secure-password", store, attempts)).resolves.toBe(true);
    await expect(attempts.get("pavan")).resolves.toBeUndefined();
    await expect(store.getSessionVersion("pavan")).resolves.toBe(1);
    const encoded = await store.getPasswordHash("pavan");
    expect(await verifyPasswordHash("new-secure-password", encoded!)).toBe(true);
    await expect(resetPasswordWithToken(token, "another-new-password", store, attempts)).resolves.toBe(false);
  });
});
