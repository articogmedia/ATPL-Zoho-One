import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ createSession: vi.fn(), destroySession: vi.fn() }));
vi.mock("@/lib/auth/users", () => ({
  staticUserAsPortalUser: (user: unknown) => user,
  verifyStaticCredentials: vi.fn(() => null),
}));
vi.mock("@/lib/crm", () => ({ crm: vi.fn() }));
vi.mock("@/lib/auth/demo", () => ({ demoLoginAllowed: vi.fn(() => false) }));

describe("static login lockout", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("blocks the username for five minutes after five failed attempts", async () => {
    const { loginAction } = await import("@/app/actions/auth");
    const form = () => {
      const data = new FormData();
      data.set("username", "pavan");
      data.set("password", "wrong");
      return data;
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(loginAction(null, form())).resolves.toEqual({ error: "Invalid username or password" });
    }
    await expect(loginAction(null, form())).resolves.toEqual({ error: "Too many attempts, try again in a few minutes" });
    await expect(loginAction(null, form())).resolves.toEqual({ error: "Too many attempts, try again in a few minutes" });
  });
});
