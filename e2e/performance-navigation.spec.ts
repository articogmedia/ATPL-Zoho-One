import { expect, test } from "@playwright/test";

test("warm navigation between Home, Leads, Quotations, and Visits does not force reloads", async ({ page }) => {
  const documentRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documentRequests.push(request.url());
  });

  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
  await page.waitForURL(/\/home$/);

  const routes = [
    { href: "/leads", heading: "Manage Leads" },
    { href: "/quotations", heading: "Create Quotation" },
    { href: "/visits", heading: "My Work & Site Visits" },
    { href: "/home", heading: /Welcome,|Good morning,|Good afternoon,|Good evening,/ },
  ] as const;
  for (const route of routes) {
    await page.locator(`a[href="${route.href}"]:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(`${route.href.replace("/", "\\/")}(?:\\?.*)?$`));
    await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
  }

  expect(documentRequests).toHaveLength(1);
});
