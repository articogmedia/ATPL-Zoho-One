import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireActionUser: vi.fn(),
  setStaticUserPassword: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({ requireActionUser: mocks.requireActionUser }));
vi.mock("@/lib/auth/password-store", () => ({ setStaticUserPassword: mocks.setStaticUserPassword }));
vi.mock("@/lib/auth/users", () => ({
  STATIC_USERS: [{ username: "pavan", name: "Pavan" }],
}));

describe("manager password reset action", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.requireActionUser.mockReset();
    mocks.setStaticUserPassword.mockReset().mockResolvedValue(undefined);
  });

  it("allows Managers to reset a known static portal user's password", async () => {
    mocks.requireActionUser.mockResolvedValue({ id: "manager", name: "Manager", role: "Manager" });
    const { managerResetPassword } = await import("@/app/actions/passwords");

    await expect(managerResetPassword({ username: "pavan", password: "temporary-pass-123" })).resolves.toEqual({ success: true });
    expect(mocks.setStaticUserPassword).toHaveBeenCalledWith("pavan", "temporary-pass-123");
  });

  it("denies non-Managers and rejects passwords shorter than ten characters", async () => {
    mocks.requireActionUser.mockResolvedValue({ id: "caller", name: "Caller", role: "Calling Team" });
    const { managerResetPassword } = await import("@/app/actions/passwords");
    await expect(managerResetPassword({ username: "pavan", password: "temporary-pass-123" })).resolves.toMatchObject({ error: expect.any(String) });
    expect(mocks.setStaticUserPassword).not.toHaveBeenCalled();

    mocks.requireActionUser.mockResolvedValue({ id: "manager", name: "Manager", role: "Manager" });
    await expect(managerResetPassword({ username: "pavan", password: "short" })).resolves.toMatchObject({ error: expect.any(String) });
    expect(mocks.setStaticUserPassword).not.toHaveBeenCalled();
  });
});
