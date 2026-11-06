import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 768 }]) {
  test(`product picker and preview work at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => false });
    });
    await page.goto("/login");
    await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
    await page.waitForURL(/\/(?:home|leads)(?:\?.*)?$/);
    await page.goto("/quotations");
    await expect(page.getByRole("heading", { name: "Create Quotation" })).toBeVisible();
    await page.locator("#quote-step-customer ul button").first().click();
    await expect(page.locator("#quote-step-products")).toHaveCount(0);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator("#quote-step-customer")).toHaveCount(0);
    await expect(page.locator("#quote-step-products")).toBeVisible();

    await page.getByRole("button", { name: "Item 1 product" }).click();
    const dialog = page.getByRole("dialog", { name: "Choose product" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/^\d+ products$/)).toBeVisible();
    await expect.poll(() => dialog.getByRole("option").count()).toBeGreaterThan(5);

    await dialog.getByRole("searchbox", { name: "Search products by name, code or description" }).fill("cassette");
    const cassette = dialog.getByRole("option", { name: /cassette/i }).first();
    await expect(cassette).toBeVisible();
    await cassette.click();
    const productsStep = page.locator("#quote-step-products");
    if (viewport.width < 1024) {
      await expect(productsStep.getByText("Rate", { exact: true }).locator("..").getByText("Rs. 1,22,000")).toBeVisible();
    } else {
      await expect(productsStep.locator("tbody tr").first().getByRole("cell").nth(4)).toHaveText("Rs. 1,22,000");
    }

    await productsStep.getByRole("spinbutton").first().fill("2");
    await expect(productsStep.getByRole("definition").last()).toHaveText("Rs. 2,44,000");
    const previewButton = viewport.width < 640
      ? page.getByRole("button", { name: "Preview", exact: true })
      : page.getByRole("button", { name: "Preview Offer" });
    await previewButton.click();

    const offerHeading = page.locator("#offer-heading");
    await expect(offerHeading).toBeVisible();
    await expect(page.locator("#quote-step-products")).toHaveCount(0);
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(offerHeading).toBeInViewport();

    const pdfResponsePromise = page.waitForResponse((response) =>
      response.url().includes("/api/quotations/pdf") && response.request().method() === "POST",
    );
    const pdfDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF" }).click();
    const pdfResponse = await pdfResponsePromise;
    expect(pdfResponse.ok()).toBe(true);
    expect(pdfResponse.headers()["content-type"]).toContain("application/pdf");
    const pdfDownload = await pdfDownloadPromise;
    expect(pdfDownload.suggestedFilename()).toMatch(/^offer-.*\.pdf$/);
    const pdfPath = await pdfDownload.path();
    if (!pdfPath) throw new Error("The generated PDF was not saved.");
    const pdfBytes = await readFile(pdfPath);
    expect(pdfBytes.length).toBeGreaterThan(0);
    expect(pdfBytes.subarray(0, 4).toString("ascii")).toBe("%PDF");

    await page.context().route("https://wa.me/**", (route) => route.fulfill({ status: 200, body: "ok" }));
    const sharePdfResponsePromise = page.waitForResponse((response) =>
      response.url().includes("/api/quotations/pdf") && response.request().method() === "POST",
    );
    const whatsappDownloadPromise = page.waitForEvent("download");
    const whatsappPopupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "WhatsApp" }).click();
    const sharePdfResponse = await sharePdfResponsePromise;
    expect(sharePdfResponse.ok()).toBe(true);
    expect(sharePdfResponse.headers()["content-type"]).toContain("application/pdf");
    const whatsappPopup = await whatsappPopupPromise;
    await expect.poll(() => whatsappPopup.url()).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
    const whatsappDownload = await whatsappDownloadPromise;
    const whatsappPdfPath = await whatsappDownload.path();
    if (!whatsappPdfPath) throw new Error("The PDF for WhatsApp sharing was not saved.");
    expect((await readFile(whatsappPdfPath)).length).toBeGreaterThan(0);
  });
}

test("new quotation customer can be cancelled or created and selected", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
  await page.waitForURL(/\/(?:home|leads)(?:\?.*)?$/);
  await page.goto("/quotations");

  await page.getByRole("button", { name: "New customer" }).click();
  await expect(page.getByLabel("Contact name")).toBeVisible();
  await page.getByLabel("Contact name").fill("Cancelled customer");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Contact name")).toHaveCount(0);

  await page.getByRole("button", { name: "New customer" }).click();
  await expect(page.getByLabel("Contact name")).toHaveValue("");
  await page.getByLabel("Contact name").fill("E2E Quotation Customer");
  await page.getByLabel("Mobile number").fill("8222222299");
  await page.getByRole("combobox", { name: "Source", exact: true }).click();
  await page.getByRole("option", { name: "Website", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Source", exact: true })).toContainText("Website");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.locator("#quote-step-customer")).toHaveCount(0);
  await expect(page.locator("#quote-step-products")).toBeVisible();

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator("#quote-step-customer")).toContainText("E2E Quotation Customer");
});
