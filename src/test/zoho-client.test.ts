import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";
  process.env.ZOHO_DC = "in";
  process.env.DATA_SOURCE = "mock";
  delete process.env.ZOHO_API_BASE_URL;
  delete process.env.ZOHO_SANDBOX;
  vi.resetModules();
});

describe("Zoho hosts", () => {
  it("refuses production Zoho CRM outside production", async () => {
    process.env.DATA_SOURCE = "zoho";
    process.env.ZOHO_CLIENT_ID = "client";
    process.env.ZOHO_CLIENT_SECRET = "secret";
    process.env.ZOHO_REFRESH_TOKEN = "refresh";

    const { env } = await import("@/lib/env");

    expect(() => env()).toThrow(
      "Refusing to connect to production Zoho CRM in development. Set ZOHO_SANDBOX=true.",
    );
  });

  it("uses the sandbox API host while keeping the accounts host unchanged", async () => {
    process.env.ZOHO_SANDBOX = "true";
    const { hosts } = await import("@/lib/zoho/client");

    expect(hosts()).toEqual({
      accounts: "https://accounts.zoho.in",
      api: "https://sandbox.zohoapis.in",
    });
  });

  it("uses the production API host when sandbox mode is false or unset", async () => {
    for (const value of ["false", undefined]) {
      if (value === undefined) delete process.env.ZOHO_SANDBOX;
      else process.env.ZOHO_SANDBOX = value;

      vi.resetModules();
      const { hosts } = await import("@/lib/zoho/client");
      expect(hosts()).toEqual({
        accounts: "https://accounts.zoho.in",
        api: "https://www.zohoapis.in",
      });
    }
  });
});
