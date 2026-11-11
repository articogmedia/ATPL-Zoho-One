import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";

const users = [
  { name: "Reshma", role: "Manager", slug: "manager" },
  { name: "Pavan", role: "Sales Executive", slug: "pavan" },
  { name: "Sai Kiran", role: "Sales Executive", slug: "saikiran" },
] as const;

async function assertPrimaryVisible(page: Page, action: Locator) {
  await expect(action).toBeVisible();
  const bounds = await action.boundingBox();
  const height = await page.evaluate(() => window.innerHeight);
  expect(bounds, "primary action must have visible bounds").not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
}

async function assertResponsive(page: Page, userSlug: string, pageSlug: string) {
  await page.screenshot({
    path: path.resolve("e2e", "screenshots", `${test.info().project.name}-${userSlug}-${pageSlug}.png`),
    animations: "disabled",
  });
  const metrics = await page.evaluate(() => {
    const width = window.innerWidth;
    const horizontalOverflow = Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ) > width + 1;
    const visibleButtons = [...document.querySelectorAll<HTMLElement>('button, a[role="button"]')]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 && bounds.width > 0 && bounds.height > 0;
      });
    const clippedButtons = visibleButtons
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left < -1 || bounds.right > width + 1;
      })
      .map((element) => element.innerText || element.getAttribute("aria-label") || element.tagName);
    const undersizedTargets = width <= 768
      ? visibleButtons
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.height < 44 || bounds.width < 44;
        })
        .map((element) => element.innerText || element.getAttribute("aria-label") || element.tagName)
      : [];
    return { horizontalOverflow, clippedButtons, undersizedTargets };
  });
  expect(metrics.horizontalOverflow, `${pageSlug} has horizontal overflow`).toBe(false);
  expect(metrics.clippedButtons, `${pageSlug} has clipped buttons`).toEqual([]);
  expect(metrics.undersizedTargets, `${pageSlug} has tap targets shorter than 44px`).toEqual([]);
}

for (const user of users) {
  test(`${user.name} pages fit the configured responsive viewport`, async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await assertPrimaryVisible(page, page.getByRole("button", { name: "Sign in" }));
    await assertResponsive(page, user.slug, "login");

    await page.getByRole("button", { name: `Continue as ${user.name}, ${user.role}` }).click();
    await expect(page).toHaveURL(/\/home$/);
    await page.waitForLoadState("networkidle");

    const routes = [
      {
        slug: "home",
        path: "/home",
        heading: /Welcome|Good morning|Good afternoon|Good evening/,
        primary: () => page.locator("main a[href='/leads']").first(),
      },
      {
        slug: "leads",
        path: "/leads",
        heading: "Manage Leads",
        primary: () => page.getByRole("button", { name: "Add Lead" }),
      },
      {
        slug: "quotations",
        path: "/quotations",
        heading: "Create Quotation",
        primary: () => page.getByRole("button", { name: /Saved quotations/ }),
      },
      {
        slug: "visits",
        path: "/visits",
        heading: "My Work & Site Visits",
        primary: () => page.getByRole("button", { name: /^Tasks \(/ }),
      },
      {
        slug: "performance",
        path: "/performance",
        heading: "Performance",
        primary: () => page.getByRole("button", { name: "Apply date range" }),
      },
    ] as const;

    for (const route of routes) {
      await page.goto(route.path, { waitUntil: "domcontentloaded" });
      if (route.slug === "performance" && user.role !== "Manager") {
        await expect(page).toHaveURL(/\/home$/);
        await assertPrimaryVisible(page, page.locator("main a[href='/leads']").first());
      } else {
        await expect(page.getByRole("heading", { name: route.heading, exact: true })).toBeVisible();
        await assertPrimaryVisible(page, route.primary());
      }
      await page.waitForLoadState("networkidle");
      await assertResponsive(page, user.slug, route.slug);
    }
  });
}
