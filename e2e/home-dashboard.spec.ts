import { expect, test } from "@playwright/test";

test("Manager sees the three main actions before monthly KPIs", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
  await page.waitForURL(/\/home$/);

  const mainActions = page.locator("main a[href='/leads'], main a[href='/quotations'], main a[href='/visits']");
  await expect(mainActions).toHaveCount(3);
  await expect(mainActions.nth(0)).toContainText("Manage Leads");
  await expect(mainActions.nth(1)).toContainText("Create Quotation");
  await expect(mainActions.nth(2)).toContainText("My Work & Site Visits");
  const thirdActionBounds = await mainActions.nth(2).boundingBox();
  const monthlySectionBounds = await page.getByRole("region", { name: "Monthly performance" }).boundingBox();
  expect(thirdActionBounds).not.toBeNull();
  expect(monthlySectionBounds).not.toBeNull();
  expect(monthlySectionBounds!.y).toBeGreaterThan(thirdActionBounds!.y);
  await expect(page.getByText("Leads this month")).toBeVisible();
  await expect(page.getByText("Conversion", { exact: true })).toBeVisible();
  await expect(page.getByText("Quotes sent")).toBeVisible();
});

test("Sales Executive sees today's assigned work", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue as Pavan, Sales Executive" }).click();
  await page.waitForURL(/\/home$/);

  const today = page.getByRole("region", { name: "Today" });
  await expect(today).toBeVisible();
  await expect(today.getByText("Follow-ups due")).toBeVisible();
  await expect(today.getByText("Visits today")).toBeVisible();
  await expect(today.getByText("New assigned leads")).toBeVisible();
});

test("Calling Team sees its fresh uncalled lead count", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as Calling Team/i }).click();
  await page.waitForURL(/\/home$/);

  await expect(page.getByRole("region", { name: "Today" })).toContainText("Fresh uncalled leads");
});
