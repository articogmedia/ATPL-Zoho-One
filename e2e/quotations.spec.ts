import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 768 }]) {
  test(`product picker and preview work at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    const mobileViewport = viewport.width < 768;
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
    await page.waitForURL(/\/(?:home|leads)(?:\?.*)?$/);
    await page.goto("/quotations");
    await expect(page.getByRole("heading", { name: "Create Quotation" })).toBeVisible();
    const savedQuotesButton = page.getByRole("button", { name: /Saved quotations/ });
    await expect(savedQuotesButton).toBeVisible();
    await expect(savedQuotesButton).toHaveText(/Saved quotations \(\d+\)/);
    const savedCountBefore = Number((await savedQuotesButton.textContent())?.match(/\((\d+)\)/)?.[1]);
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
    await expect(savedQuotesButton).toHaveText(`Saved quotations (${savedCountBefore + 1})`);

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
    if (mobileViewport) {
      await page.route("https://public.blob.vercel-storage.com/**", (route) => route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: "%PDF-1.4\nshare fixture",
      }));
    }
    const whatsappPopupPromise = mobileViewport ? undefined : page.waitForEvent("popup");
    const shareResponsePromise = page.waitForResponse((response) =>
      response.url().includes("/api/quotations/share") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "WhatsApp" }).click();
    const shareResponse = await shareResponsePromise;
    expect(shareResponse.status()).toBe(200);
    if (mobileViewport) {
      await expect.poll(() => page.url()).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
    } else {
      const whatsappPopup = await whatsappPopupPromise!;
      expect(await shareResponse.json()).toMatchObject({
        url: "https://public.blob.vercel-storage.com/quotes/test-unpredictable.pdf",
      });
      await expect.poll(() => whatsappPopup.url()).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
      const message = decodeURIComponent(new URL(whatsappUrls[0] ?? whatsappPopup.url()).searchParams.get("text") ?? "");
      expect(message).toContain("Offer ");
      expect(message).toContain("Grand total:");
      expect(message).toContain("PDF: https://public.blob.vercel-storage.com/quotes/test-unpredictable.pdf");
      await expect(page.getByText(/WhatsApp opened for /)).toBeVisible();
      await expect(offer.getByText("Sent", { exact: true })).toBeVisible();
    }
  });
}

test("saved quotation keeps customer details and can download and share its PDF", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const mobileViewport = page.viewportSize()?.width === 390;
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
  await page.waitForURL(/\/(?:home|leads)(?:\?.*)?$/);
  await page.goto("/quotations");
  await page.getByRole("button", { name: /Saved quotations/ }).click();
  const savedDialog = page.getByRole("dialog", { name: "Saved quotations" });
  const quoteCard = savedDialog.locator("article").filter({ hasText: "225/26-27" });
  await expect(quoteCard).toContainText("Sri Lakshmi Textiles");
  await quoteCard.getByRole("button", { name: "View" }).click();

  const offer = page.locator("article.offer-document");
  await expect(offer.getByText("Bill To").locator("..")).toContainText("Sri Lakshmi Textiles");
  await expect(page.getByRole("button", { name: "Download PDF" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "WhatsApp" })).toBeEnabled();

  const whatsappUrls: string[] = [];
  await page.context().route("https://wa.me/**", (route) => {
    whatsappUrls.push(route.request().url());
    return route.fulfill({ status: 200, body: "ok" });
  });
  await page.route("**/api/quotations/share", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "BLOB_READ_WRITE_TOKEN is missing" }),
  }));
  const pdfDownload = page.waitForEvent("download");
  const whatsappPopup = mobileViewport ? undefined : page.waitForEvent("popup");
  await page.getByRole("button", { name: "WhatsApp" }).click();
  const download = await pdfDownload;
  expect(download.suggestedFilename()).toMatch(/^offer-.*\.pdf$/);
  if (mobileViewport) {
    await expect.poll(() => page.url()).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
  } else {
    const popup = await whatsappPopup!;
    await expect.poll(() => popup.url()).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
    await expect(page.getByRole("heading", { name: "Create Quotation" })).toBeVisible();
    const message = decodeURIComponent(new URL(whatsappUrls[0] ?? popup.url()).searchParams.get("text") ?? "");
    expect(message).toContain("Sri Lakshmi Textiles");
    expect(message).toContain("Grand total:");
    expect(message).not.toContain("PDF:");
    await expect(page.getByText(/WhatsApp opened for /)).toBeVisible();
    await expect(offer.getByText("Sent", { exact: true })).toBeVisible();
  }
  expect(whatsappUrls).toHaveLength(1);
});

test("the newest five saved quotes work at 360px and 1280px without duplicate offer numbers", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
  await page.waitForURL(/\/(?:home|leads)(?:\?.*)?$/);
  const whatsappUrls: string[] = [];
  await page.context().route("https://wa.me/**", async (route) => {
    whatsappUrls.push(route.request().url());
    await route.fulfill({ status: 200, body: "WhatsApp chat fixture" });
  });
  await page.route("**/api/quotations/share", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ url: "https://public.blob.vercel-storage.com/quotes/saved-offer.pdf" }),
  }));

  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: width < 768 ? 800 : 800 });
    for (let quoteIndex = 0; quoteIndex < 5; quoteIndex++) {
      await page.goto("/quotations");
      await page.getByRole("button", { name: /Saved quotations/ }).click();
      const dialog = page.getByRole("dialog", { name: "Saved quotations" });
      const cards = dialog.locator("article");
      await expect.poll(() => cards.count(), { timeout: 20_000 }).toBeGreaterThan(0);
      while (await cards.count() < 5) {
        await dialog.getByRole("button", { name: "Load more quotations" }).click();
        await expect.poll(() => cards.count(), { timeout: 20_000 }).toBeGreaterThan(0);
      }
      expect(await cards.count()).toBeGreaterThanOrEqual(5);
      const references = (await cards.allInnerTexts()).map((text) => /Offer\s+(\d+\/\d{2}-\d{2})/.exec(text)?.[1]).filter(Boolean);
      expect(new Set(references).size).toBe(references.length);

      const card = cards.nth(quoteIndex);
      const offerNo = /Offer\s+(\d+\/\d{2}-\d{2})/.exec(await card.innerText())?.[1];
      expect(offerNo).toBeTruthy();
      await card.getByRole("button", { name: "View" }).click();

      const offer = page.locator("article.offer-document");
      await expect(offer.getByText("Bill To")).toBeVisible();
      const billTo = offer.getByText("Bill To").locator("..");
      await expect(billTo).not.toContainText("Customer details not saved with this quote");
      expect((await billTo.innerText()).replace(/\D/g, "")).toMatch(/\d{10}/);
      await expect(page.getByRole("button", { name: "Download PDF" })).toBeEnabled();
      await expect(page.getByRole("button", { name: "WhatsApp" })).toBeEnabled();

      const pdfResponsePromise = page.waitForResponse((response) =>
        response.url().includes("/api/quotations/pdf") && response.request().method() === "POST",
      );
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download PDF" }).click();
      const [pdfResponse, download] = await Promise.all([pdfResponsePromise, downloadPromise]);
      expect(pdfResponse.ok()).toBe(true);
      expect(download.suggestedFilename()).toMatch(/^offer-.*\.pdf$/);
      const filePath = await download.path();
      if (!filePath) throw new Error("The saved quotation PDF was not written.");
      const pdf = await readFile(filePath);
      expect(pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");

      const popupPromise = width < 768 ? undefined : page.waitForEvent("popup");
      const shareResponsePromise = page.waitForResponse((response) =>
        response.url().includes("/api/quotations/share") && response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "WhatsApp" }).click();
      const shareResponse = await shareResponsePromise;
      expect(shareResponse.ok()).toBe(true);
      const chat = width < 768 ? page : await popupPromise!;
      await expect.poll(() => chat.url()).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
      const message = decodeURIComponent(new URL(whatsappUrls[whatsappUrls.length - 1]!).searchParams.get("text") ?? "");
      expect(message).toContain(`Offer ${offerNo}`);
      expect(message).toContain("PDF: https://public.blob.vercel-storage.com/quotes/saved-offer.pdf");
      if (width < 768) await page.goto("/quotations");
      else await chat.close();
    }
  }
});

test("new quotation customer can be cancelled or created and selected", async ({ page }) => {
  const mobile = `8${Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0")}`;
  const customerName = `E2E Quotation Customer ${mobile.slice(-4)}`;
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
  await page.getByLabel("Contact name").fill(customerName);
  await page.getByLabel("Mobile number").fill(mobile);
  await page.getByRole("combobox", { name: "Source", exact: true }).click();
  await page.getByRole("option", { name: "Website", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Source", exact: true })).toContainText("Website");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.locator("#quote-step-customer")).toHaveCount(0);
  await expect(page.locator("#quote-step-products")).toBeVisible();

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator("#quote-step-customer")).toContainText(customerName);
  await page.locator("#quote-step-customer ul button").filter({ hasText: customerName }).click();
  await expect(page.locator("#quote-step-products")).toBeVisible();
  await page.getByRole("button", { name: "Item 1 product" }).click();
  const productDialog = page.getByRole("dialog", { name: "Choose product" });
  await expect(productDialog).toBeVisible();
  await productDialog.getByRole("option").first().click();
  await page.getByRole("button", { name: "Preview Offer" }).click();
  await expect(page.locator("#offer-heading")).toBeVisible();
  await expect(page.locator("article.offer-document").getByText(/^\d+\/\d{2}-\d{2}$/)).toBeVisible();
  await expect(page.locator("article.offer-document")).toContainText(customerName);
});

test("quotation wizard and preview fit target widths", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Runs one screenshot matrix regardless of device project.");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
  await page.waitForURL(/\/(?:home|leads)(?:\?.*)?$/);
  await page.goto("/quotations");

  const widths = [360, 390, 430, 768, 1280];
  const expectNoHorizontalOverflow = async () => {
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.document, `document overflows at ${dimensions.viewport}px`).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body, `body overflows at ${dimensions.viewport}px`).toBeLessThanOrEqual(dimensions.viewport);
  };
  const captureAtWidths = async (state: string) => {
    for (const width of widths) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
      await expectNoHorizontalOverflow();
      await page.screenshot({ path: testInfo.outputPath(`${state}-${width}.png`), fullPage: true });
    }
  };

  await captureAtWidths("customer-wizard");
  await page.locator("#quote-step-customer ul button").first().click();
  await page.getByRole("button", { name: "Item 1 product" }).click();
  const picker = page.getByRole("dialog", { name: "Choose product" });
  await picker.getByRole("option").first().click();
  await captureAtWidths("product-wizard");
  await page.getByRole("button", { name: "Preview Offer" }).click();
  await expect(page.locator("#offer-heading")).toBeVisible();
  await captureAtWidths("quotation-preview");

  for (const width of widths.filter((value) => value <= 430)) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ["Download PDF", "WhatsApp"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(box?.height).toBe(48);
    }
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  }
});
