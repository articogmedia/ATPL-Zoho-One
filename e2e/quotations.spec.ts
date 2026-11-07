import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 768 }]) {
  test(`product picker and preview work at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript((nativeFileShare) => {
      Object.defineProperty(navigator, "canShare", {
        configurable: true,
        value: (data: ShareData) => nativeFileShare && !!data.files?.length,
      });
      if (nativeFileShare) {
        Object.defineProperty(navigator, "share", {
          configurable: true,
          value: async (data: ShareData) => {
            Object.defineProperty(window, "__atplSharedFileCount", { configurable: true, value: data.files?.length ?? 0 });
          },
        });
      }
    }, viewport.width < 640);
    await page.goto("/login");
    await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
    await page.waitForURL(/\/(?:home|leads)(?:\?.*)?$/);
    await page.goto("/quotations");
    await expect(page.getByRole("heading", { name: "Create Quotation" })).toBeVisible();
    const savedQuotesButton = page.getByRole("button", { name: /Saved quotations/ });
    await expect(savedQuotesButton).toBeVisible();
    const savedQuotesRoute = (route: import("@playwright/test").Route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ quotes: [], hasMore: false }),
    });
    await page.route(/\/api\/quotations\?page=1$/, savedQuotesRoute);
    await savedQuotesButton.click();
    await expect(page.getByRole("dialog", { name: "Saved quotations" })).toBeVisible();
    await expect(page.getByText("No quotations yet.")).toBeVisible();
    await page.getByRole("button", { name: "Close saved quotations" }).click();
    await page.unroute(/\/api\/quotations\?page=1$/, savedQuotesRoute);
    await expect(savedQuotesButton).toBeVisible();
    await page.locator("#quote-step-customer ul button").first().click();
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
    const offer = page.locator("article.offer-document");
    await expect(offer.getByText(/^\d+\/\d{2}-\d{2}$/)).toBeVisible();
    await expect(offer.getByText("Bill To")).toBeVisible();
    await expect(offer.getByText("Ship To")).toBeVisible();
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

    await page.route("**/api/quotations/share", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "https://public.blob.vercel-storage.com/quotes/test-unpredictable.pdf" }),
    }));
    const whatsappUrls: string[] = [];
    await page.context().route("https://wa.me/**", (route) => {
      whatsappUrls.push(route.request().url());
      return route.fulfill({ status: 200, body: "ok" });
    });
    if (viewport.width < 640) {
      await page.route("https://public.blob.vercel-storage.com/**", (route) => route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: "%PDF-1.4\nshare fixture",
      }));
    }
    const whatsappPopupPromise = viewport.width >= 640 ? page.waitForEvent("popup") : undefined;
    const shareResponsePromise = page.waitForResponse((response) =>
      response.url().includes("/api/quotations/share") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "WhatsApp" }).click();
    const shareResponse = await shareResponsePromise;
    expect(shareResponse.status()).toBe(200);
    if (viewport.width < 640) {
      await expect.poll(() => page.evaluate(() =>
        (window as typeof window & { __atplSharedFileCount?: number }).__atplSharedFileCount,
      )).toBe(1);
    } else {
      const whatsappPopup = await whatsappPopupPromise!;
      expect(await shareResponse.json()).toMatchObject({
        url: "https://public.blob.vercel-storage.com/quotes/test-unpredictable.pdf",
      });
      await expect.poll(() => whatsappPopup.url()).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
      expect(decodeURIComponent(whatsappUrls[0] ?? whatsappPopup.url()))
        .toContain("Offer ");
    }
  });
}

test("new quotation customer can be cancelled or created and selected", async ({ page }) => {
  const mobile = `8${Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0")}`;
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
  await page.getByLabel("Mobile number").fill(mobile);
  await page.getByRole("combobox", { name: "Source", exact: true }).click();
  await page.getByRole("option", { name: "Website", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Source", exact: true })).toContainText("Website");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.locator("#quote-step-customer")).toHaveCount(0);
  await expect(page.locator("#quote-step-products")).toBeVisible();

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator("#quote-step-customer")).toContainText("E2E Quotation Customer");
  await page.locator("#quote-step-customer ul button").filter({ hasText: "E2E Quotation Customer" }).click();
  await expect(page.locator("#quote-step-products")).toBeVisible();
  await page.getByRole("button", { name: "Item 1 product" }).click();
  const productDialog = page.getByRole("dialog", { name: "Choose product" });
  await expect(productDialog).toBeVisible();
  await productDialog.getByRole("option").first().click();
  await page.getByRole("button", { name: "Preview Offer" }).click();
  await expect(page.locator("#offer-heading")).toBeVisible();
  await expect(page.locator("article.offer-document").getByText(/^\d+\/\d{2}-\d{2}$/)).toBeVisible();
  await expect(page.locator("article.offer-document")).toContainText("E2E Quotation Customer");
});
