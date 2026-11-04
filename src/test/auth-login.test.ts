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

  it("resets failed attempts and redirects after a valid login", async () => {
    const users = await import("@/lib/auth/users");
    const navigation = await import("next/navigation");
    vi.mocked(users.verifyStaticCredentials).mockImplementation((_username, password) => password === "correct" ? {
      username: "pavan", name: "Pavan", role: "Sales", passwordEnv: "ATPL_PAVAN_PASSWORD",
    } : null);
    const { loginAction } = await import("@/app/actions/auth");
    const form = (password: string) => {
      const data = new FormData();
      data.set("username", "reset-pavan");
      data.set("password", password);
      return data;
    };
    await expect(loginAction(null, form("wrong"))).resolves.toEqual({ error: "Invalid username or password" });
    await expect(loginAction(null, form("correct"))).resolves.toBeUndefined();
    expect(navigation.redirect).toHaveBeenCalledWith("/leads");
    await expect(loginAction(null, form("wrong"))).resolves.toEqual({ error: "Invalid username or password" });
  });

  it("does not allow the correct password while the account is locked", async () => {
    const users = await import("@/lib/auth/users");
    vi.mocked(users.verifyStaticCredentials).mockImplementation((_username, password) =>
      password === "correct" ? { username: "locked", name: "Locked", role: "Sales", passwordEnv: "ATPL_LOCKED_PASSWORD" } : null);
    const { loginAction } = await import("@/app/actions/auth");
    const form = (password: string) => {
      const data = new FormData();
      data.set("username", "locked");
      data.set("password", password);
      return data;
    };
    for (let attempt = 0; attempt < 5; attempt++) await loginAction(null, form("wrong"));
    await expect(loginAction(null, form("correct"))).resolves.toEqual({ error: "Too many attempts, try again in a few minutes" });
  });
});
