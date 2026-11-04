import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 768 }]) {
  test(`product picker and preview work at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
    await page.waitForURL(/\/home(?:\?.*)?$/);
    await page.goto("/quotations");
    await expect(page.getByRole("heading", { name: "Create Quotation" })).toBeVisible();
    await page.locator("#quote-step-customer ul button").first().click();

    await page.getByRole("button", { name: "Item 1 product" }).click();
    const dialog = page.getByRole("dialog", { name: "Choose product" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/^\d+ products$/)).toBeVisible();
    await expect.poll(() => dialog.getByRole("option").count()).toBeGreaterThan(20);

    await dialog.getByRole("searchbox", { name: "Search products by name, code or description" }).fill("grille");
    const grille = dialog.getByRole("option", { name: /grille/i }).first();
    await expect(grille).toBeVisible();
    await grille.click();

    await page.locator("#quote-step-products").getByRole("spinbutton").first().fill("2");
    const previewButton = viewport.width < 640
      ? page.getByRole("button", { name: "Preview", exact: true })
      : page.getByRole("button", { name: "Preview Offer" });
    await previewButton.click();

    const offerHeading = page.locator("#offer-heading");
    await expect(offerHeading).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(offerHeading).toBeInViewport();
  });
}
