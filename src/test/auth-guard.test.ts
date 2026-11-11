import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ readSession: vi.fn(), getSessionVersion: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ readSession: mocks.readSession }));
vi.mock("@/lib/auth/password-store", () => ({
  passwordStore: { getSessionVersion: mocks.getSessionVersion },
}));
vi.mock("@/lib/auth/users", () => ({
  STATIC_USERS: [
    { username: "pavan", name: "Pavan", role: "Sales" },
    { username: "saikiran", name: "Sai Kiran", role: "Sales" },
  ],
  portalRole: (role: string) => role === "Sales" ? "Sales Executive" : role,
  staticUserAsPortalUser: (user: { name: string; role: string }, id = "") => ({
    id,
    name: user.name,
    role: user.role === "Sales" ? "Sales Executive" : user.role,
  }),
}));

describe("currentUser identity", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.readSession.mockReset();
    mocks.getSessionVersion.mockReset().mockResolvedValue(0);
  });

  it("does not share identity between users whose Zoho IDs are empty", async () => {
    mocks.readSession
      .mockResolvedValueOnce({
        uid: "", username: "pavan", name: "Pavan", role: "Sales Executive", zohoUserId: "", lastActivity: Date.now(), sessionVersion: 0,
      })
      .mockResolvedValueOnce({
        uid: "", username: "saikiran", name: "Sai Kiran", role: "Sales Executive", zohoUserId: "", lastActivity: Date.now(), sessionVersion: 0,
      });
    const { currentUser } = await import("@/lib/auth/guard");

    await expect(currentUser()).resolves.toMatchObject({ name: "Pavan", role: "Sales Executive", id: "" });
    await expect(currentUser()).resolves.toMatchObject({ name: "Sai Kiran", role: "Sales Executive", id: "" });
  });

  it("rejects sessions created before the user's password was reset", async () => {
    mocks.readSession.mockResolvedValue({
      uid: "pavan-id", username: "pavan", name: "Pavan", role: "Sales Executive",
      zohoUserId: "pavan-id", lastActivity: Date.now(), sessionVersion: 0,
    });
    mocks.getSessionVersion.mockResolvedValue(1);
    const { currentUser } = await import("@/lib/auth/guard");

    await expect(currentUser()).resolves.toBeNull();
  });
});
