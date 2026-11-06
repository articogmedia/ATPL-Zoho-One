import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (load: () => Promise<unknown>) => load,
}));

beforeEach(async () => {
  process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";
  process.env.DATA_SOURCE = "mock";
  delete process.env.ZOHO_QUEUE_OWNER_ID;
  const { resetMemoryCache } = await import("@/lib/cache");
  resetMemoryCache();
  vi.resetModules();
});

describe("Zoho visit lookup", () => {
  it("fetches a task by ID instead of depending on the cached/paginated task list", async () => {
    const task = {
      id: "task-1", Subject: "Customer call", Status: "Not Started", Due_Date: "2026-11-06",
      Owner: { id: "sai-id", name: "Sai Kiran" }, What_Id: { id: "lead-1", name: "Customer" },
    };
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/Tasks/task-1") return { data: [task] };
      if (path === "/users") return {
        users: [
          { id: "manager-id", full_name: "Manager", role: { name: "Manager" } },
          { id: "sai-id", full_name: "Sai Kiran", role: { name: "Sales Executive" } },
        ],
      };
      if (path === "/settings/fields") return { fields: [] };
      return {};
    });
    const zohoList = vi.fn(async (module: string) => module === "Leads" ? [{
      id: "lead-1", Last_Name: "Customer", Company: "Customer Co", Mobile: "9876543210",
      Lead_Status: "Assigned to Sales", Lead_Source: "Direct Call", Owner: { id: "sai-id", name: "Sai Kiran" },
    }] : []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: class extends Error {
        constructor(message: string, readonly status?: number, readonly code?: string) {
          super(message);
          this.name = "ZohoError";
        }
      },
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList,
      zohoWrite: vi.fn(),
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");

    await expect(zohoRepository.getVisit("task-1")).resolves.toMatchObject({
      id: "task-1", leadId: "lead-1", executiveId: "sai-id", customer: "Customer Co",
    });
    expect(zoho).toHaveBeenCalledWith("GET", "/Tasks/task-1", expect.objectContaining({
      query: expect.objectContaining({ fields: expect.stringContaining("What_Id") }),
    }));
    expect(zohoList).toHaveBeenCalledWith("Tasks", expect.any(Array), expect.any(Number));
  });

  it("returns null for a missing task so the action can report not found distinctly", async () => {
    class MockZohoError extends Error {
      constructor(message: string, readonly status?: number) {
        super(message);
        this.name = "ZohoError";
      }
    }
    const zoho = vi.fn(async (_method: string, path: string) => {
      if (path === "/Tasks/missing") throw new MockZohoError("record not found", 404);
      if (path === "/settings/modules") return { modules: [] };
      return {};
    });
    const zohoList = vi.fn(async () => []);
    vi.doMock("@/lib/zoho/client", () => ({
      ZohoError: MockZohoError,
      hosts: () => ({ api: "https://sandbox.zohoapis.in" }),
      zoho,
      zohoList,
      zohoWrite: vi.fn(),
    }));
    const { zohoRepository } = await import("@/lib/zoho/repository");
    await expect(zohoRepository.getVisit("missing")).resolves.toBeNull();
  });
});
