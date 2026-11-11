import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  authenticateStaticCredentials: vi.fn(),
  crm: vi.fn(),
  listLeads: vi.fn(),
  listProducts: vi.fn(),
  listUsers: vi.fn(),
  resolvePortalUserZohoId: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ createSession: mocks.createSession, destroySession: vi.fn() }));
vi.mock("@/lib/auth/password-store", () => ({ authenticateStaticCredentials: mocks.authenticateStaticCredentials }));
vi.mock("@/lib/auth/users", () => ({
  staticUserAsPortalUser: (user: { zohoUserId?: string }) => ({ ...user, id: user.zohoUserId ?? "" }),
  verifyStaticCredentials: vi.fn(() => null),
  resolvePortalUserZohoId: mocks.resolvePortalUserZohoId,
}));
vi.mock("@/lib/crm", () => ({ crm: mocks.crm }));
vi.mock("@/lib/auth/demo", () => ({ demoLoginAllowed: vi.fn(() => false) }));

describe("static login lockout", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createSession.mockReset();
    mocks.authenticateStaticCredentials.mockReset().mockResolvedValue(null);
    mocks.crm.mockReset();
    mocks.listLeads.mockReset().mockResolvedValue([]);
    mocks.listProducts.mockReset().mockResolvedValue([]);
    mocks.listUsers.mockReset().mockResolvedValue([]);
    mocks.resolvePortalUserZohoId.mockReset().mockReturnValue("zoho-user-1");
  });

  afterEach(() => vi.unstubAllEnvs());

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
    const navigation = await import("next/navigation");
    mocks.authenticateStaticCredentials.mockImplementation(async (_username, password) => password === "correct" ? {
      username: "pavan", name: "Pavan", role: "Sales", passwordEnv: "ATPL_PAVAN_PASSWORD",
    } : null);
    mocks.crm.mockReturnValue({ listLeads: mocks.listLeads, listProducts: mocks.listProducts });
    const { loginAction } = await import("@/app/actions/auth");
    const form = (password: string) => {
      const data = new FormData();
      data.set("username", "reset-pavan");
      data.set("password", password);
      return data;
    };
    await expect(loginAction(null, form("wrong"))).resolves.toEqual({ error: "Invalid username or password" });
    await expect(loginAction(null, form("correct"))).resolves.toBeUndefined();
    expect(navigation.redirect).toHaveBeenCalledWith("/home");
    expect(mocks.listLeads).toHaveBeenCalledOnce();
    expect(mocks.listProducts).toHaveBeenCalledOnce();
    await expect(loginAction(null, form("wrong"))).resolves.toEqual({ error: "Invalid username or password" });
  });

  it("returns to the originally requested allowed route after session expiry", async () => {
    const navigation = await import("next/navigation");
    mocks.authenticateStaticCredentials.mockResolvedValue({
      username: "manager", name: "Manager", role: "Manager", passwordEnv: "ATPL_MANAGER_PASSWORD",
    });
    const { loginAction } = await import("@/app/actions/auth");
    const data = new FormData();
    data.set("username", "manager");
    data.set("password", "correct");
    data.set("returnTo", "/quotations?lead=5725767000000123456");

    await loginAction(null, data);

    expect(navigation.redirect).toHaveBeenCalledWith("/quotations?lead=5725767000000123456");
  });

  it("allows /home as an explicit return destination", async () => {
    const navigation = await import("next/navigation");
    mocks.authenticateStaticCredentials.mockResolvedValue({
      username: "manager", name: "Manager", role: "Manager", passwordEnv: "ATPL_MANAGER_PASSWORD",
    });
    const { loginAction } = await import("@/app/actions/auth");
    const data = new FormData();
    data.set("username", "manager");
    data.set("password", "correct");
    data.set("returnTo", "/home?welcome=1");

    await loginAction(null, data);

    expect(navigation.redirect).toHaveBeenCalledWith("/home?welcome=1");
  });

  it("does not redirect a user to an external URL after session expiry", async () => {
    const navigation = await import("next/navigation");
    mocks.authenticateStaticCredentials.mockResolvedValue({
      username: "manager", name: "Manager", role: "Manager", passwordEnv: "ATPL_MANAGER_PASSWORD",
    });
    const { loginAction } = await import("@/app/actions/auth");
    const data = new FormData();
    data.set("username", "manager");
    data.set("password", "correct");
    data.set("returnTo", "//example.com");

    await loginAction(null, data);

    expect(navigation.redirect).toHaveBeenCalledWith("/home");
  });

  it("does not allow the correct password while the account is locked", async () => {
    mocks.authenticateStaticCredentials.mockImplementation(async (_username, password) =>
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

  it("resolves the active Zoho user ID before creating a Zoho-backed session", async () => {
    vi.stubEnv("DATA_SOURCE", "zoho");
    mocks.authenticateStaticCredentials.mockResolvedValue({
      username: "pavan", name: "Pavan", role: "Sales", passwordEnv: "ATPL_PAVAN_PASSWORD",
    });
    mocks.crm.mockReturnValue({
      listUsers: mocks.listUsers,
      listLeads: vi.fn().mockResolvedValue([]),
      listAssignableUsers: vi.fn().mockResolvedValue([]),
    });
    mocks.resolvePortalUserZohoId.mockReturnValue("zoho-pavan-id");

    const { loginAction } = await import("@/app/actions/auth");
    const data = new FormData();
    data.set("username", "pavan");
    data.set("password", "correct");
    await loginAction(null, data);

    expect(mocks.listUsers).toHaveBeenCalledOnce();
    expect(mocks.resolvePortalUserZohoId).toHaveBeenCalledWith(
      expect.objectContaining({ username: "pavan" }), [],
    );
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "zoho-pavan-id" }), "pavan",
    );
  });

  it("blocks Zoho login when the account cannot be mapped to an active CRM user", async () => {
    vi.stubEnv("DATA_SOURCE", "zoho");
    mocks.authenticateStaticCredentials.mockResolvedValue({
      username: "pavan", name: "Pavan", role: "Sales", passwordEnv: "ATPL_PAVAN_PASSWORD",
    });
    mocks.crm.mockReturnValue({ listUsers: mocks.listUsers });
    mocks.resolvePortalUserZohoId.mockReturnValue("");

    const { loginAction } = await import("@/app/actions/auth");
    const data = new FormData();
    data.set("username", "pavan");
    data.set("password", "correct");

    await expect(loginAction(null, data)).resolves.toEqual({
      error: "Your account is not mapped to an active Zoho CRM user. Please ask an administrator to update your user mapping.",
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
