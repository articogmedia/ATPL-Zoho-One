import { expect, test } from "@playwright/test";

for (const { name, role } of [
  { name: "Reshma", role: "Manager" },
  { name: "Pavan", role: "Sales Executive" },
]) {
  test(`${role} can open the invoices section`, async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: `Continue as ${name}, ${role}` }).click();
    await page.waitForURL(/\/home$/);

    await expect(page.getByRole("link", { name: /Invoices/ }).first()).toBeVisible();
    await page.goto("/invoices");
    await expect(page.getByRole("heading", { name: "Invoices", exact: true })).toBeVisible();
    await expect(page.getByText(/^Saved invoices \(/)).toBeVisible();
  });
}