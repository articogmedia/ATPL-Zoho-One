import { expect, test } from "@playwright/test";
import { loginAs } from "./login";
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  const pdf = "%PDF-1.4\nmock stored quotation";
  await page.route("**/api/quotations/share", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ url: "https://blob.example/quotation.pdf" }),
  }));
  await page.route("https://blob.example/quotation.pdf", (route) => route.fulfill({
    status: 200,
    contentType: "application/pdf",
    body: pdf,
  }));
  await page.route("https://public.blob.vercel-storage.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/pdf",
    body: pdf,
  }));
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 768 }]) {
  test(`product picker and preview work at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    const mobileViewport = viewport.width < 768;
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await loginAs(page, "Reshma", "Manager");
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
    const productTable = productsStep.getByRole("table", { name: "Quotation products" });
    const itemRows = productTable.locator("tbody tr");
    await expect(productTable.getByRole("columnheader")).toHaveText([
      "S.No", "Product", "Unit", "Qty", "Rate", "Discount", "GST %", "Amount", "Actions",
    ]);
    await expect(itemRows).toHaveCount(1);
    await expect(itemRows.first().getByRole("cell").nth(4)).toHaveText("Rs. 1,22,000");

    await productsStep.getByRole("button", { name: "Add item", exact: true }).click();
    await expect(itemRows).toHaveCount(2);
    await itemRows.nth(1).getByRole("button", { name: "Item 2 product" }).click();
    const secondProductDialog = page.getByRole("dialog", { name: "Choose product" });
    await secondProductDialog.getByRole("searchbox", { name: "Search products by name, code or description" }).fill("cassette");
    await secondProductDialog.getByRole("option", { name: /cassette/i }).first().click();
    await expect(itemRows.nth(1).getByRole("cell").nth(4)).toHaveText("Rs. 1,22,000");
    if (mobileViewport) {
      const hasHorizontalOverflow = await productTable.evaluate((table) => {
        const scroller = table.parentElement;
        return !!scroller && scroller.scrollWidth > scroller.clientWidth;
      });
      expect(hasHorizontalOverflow).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    }
    await itemRows.nth(1).getByRole("button", { name: "Remove item 2" }).click();
    await expect(itemRows).toHaveCount(1);

    await productsStep.getByRole("spinbutton").first().fill("2");
    await expect(productsStep.getByRole("definition").last()).toHaveText("Rs. 2,87,920");
    const previewButton = viewport.width < 640
      ? page.getByRole("button", { name: "Preview", exact: true })
      : page.getByRole("button", { name: "Preview Offer" });
    let pdfGenerations = 0;
    await page.route("**/api/quotations/share", async (route) => {
      pdfGenerations += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: "https://blob.example/quotation.pdf" }),
      });
    });
    await page.route("https://blob.example/quotation.pdf", (route) => route.fulfill({
      status: 200,
      contentType: "application/pdf",
      body: "%PDF-1.4\nstored quotation fixture",
    }));
    await previewButton.click();

    const offerHeading = page.locator("#offer-heading");
    await expect(offerHeading).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Generating and storing the quotation PDF…" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Generating and storing the quotation PDF…" })).toHaveCount(0, { timeout: 10_000 });
    expect(pdfGenerations).toBe(1);
    await expect(page.locator("#quote-step-products")).toHaveCount(0);
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    const offer = page.locator("article.offer-document");
    await expect(offer.getByText(/^\d+\/\d{2}-\d{2}$/)).toBeVisible();
    const clientDetails = offer.getByText("Client", { exact: true }).locator("..");
    await expect(clientDetails).toBeVisible();
    await expect(clientDetails).not.toContainText("Customer details not saved with this quote");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(offerHeading).toBeInViewport();
    await expect(savedQuotesButton).toHaveText(`Saved quotations (${savedCountBefore + 1})`);

    const pdfResponsePromise = page.waitForResponse((response) => response.url() === "https://blob.example/quotation.pdf");
    const pdfDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /Download (?:quotation )?PDF/ }).click();
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
    await page.getByRole("button", { name: "WhatsApp" }).click();
    expect(pdfGenerations).toBe(1);
    if (mobileViewport) {
      await expect.poll(() => page.url()).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
    } else {
      const whatsappPopup = await whatsappPopupPromise!;
      await expect.poll(() => whatsappPopup.url()).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
      const message = decodeURIComponent(new URL(whatsappUrls[0] ?? whatsappPopup.url()).searchParams.get("text") ?? "");
      expect(message).toContain("Offer ");
      expect(message).toContain("Grand total:");
      expect(message).toContain("PDF: https://blob.example/quotation.pdf");
      await expect(page.getByText(/WhatsApp opened for /)).toBeVisible();
      await expect(offer.getByText("Sent", { exact: true })).toBeVisible();
    }
  });
}

test("quotation product rows fit desktop widths and scroll only on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/login");
  await loginAs(page, "Reshma", "Manager");
  await page.goto("/quotations");
  await page.locator("#quote-step-customer ul button").first().click();
  await page.getByRole("button", { name: "Item 1 product" }).click();
  const picker = page.getByRole("dialog", { name: "Choose product" });
  await picker.getByRole("searchbox", { name: "Search products by name, code or description" }).fill("copper piping");
  await picker.getByRole("option", { name: /copper piping/i }).first().click();

  const productsStep = page.locator("#quote-step-products");
  const table = productsStep.getByRole("table", { name: "Quotation products" });
  const row = table.locator("tbody tr").first();
  const scroller = table.locator("xpath=..");
  await expect(row.getByRole("cell").nth(2)).toHaveText("Running Meter");
  await expect(row.getByRole("cell")).toHaveCount(9);

  for (const width of [1440, 1280, 1024, 430, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const scrollWidths = await scroller.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    if (width >= 1024) expect(scrollWidths.scrollWidth).toBeLessThanOrEqual(scrollWidths.clientWidth);
    else expect(scrollWidths.scrollWidth).toBeGreaterThan(scrollWidths.clientWidth);

    const alignment = await row.evaluate((productRow) => {
      const headers = productRow.closest("table")?.querySelectorAll("thead th");
      const cells = productRow.querySelectorAll("td");
      return Array.from(cells, (cell, index) => {
        const header = headers?.[index];
        if (!header) return false;
        const headerBounds = header.getBoundingClientRect();
        const cellBounds = cell.getBoundingClientRect();
        return Math.abs(headerBounds.left - cellBounds.left) <= 1 &&
          Math.abs(headerBounds.right - cellBounds.right) <= 1;
      });
    });
    expect(alignment.every(Boolean)).toBe(true);
    expect(await row.evaluate((productRow) => Array.from(productRow.querySelectorAll("input, select, button")).every((control) => {
      const bounds = control.getBoundingClientRect();
      const cellBounds = control.closest("td")?.getBoundingClientRect();
      return !!cellBounds && bounds.left >= cellBounds.left - 1 && bounds.right <= cellBounds.right + 1;
    }))).toBe(true);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Preview Offer" }).click();
  await expect(page.locator("article.offer-document")).toContainText("Running Meter");
});

test("virtualized product picker scrolls to and selects the last product on desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/login");
  await loginAs(page, "Reshma", "Manager");
  await page.goto("/quotations");
  await page.locator("#quote-step-customer ul button").first().click();

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 390, height: 844 },
    { width: 390, height: 430 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "Item 1 product" }).click();
    const dialog = page.getByRole("dialog", { name: "Choose product" });
    const listbox = dialog.getByRole("listbox", { name: "Products" });
    const countLabel = dialog.locator("p").filter({ hasText: /^\d+ products?$/ });
    await expect.poll(async () => Number((await countLabel.textContent())?.match(/\d+/)?.[0] ?? 0)).toBeGreaterThan(0);
    const total = Number((await countLabel.textContent())?.match(/\d+/)?.[0]);
    const lastOption = listbox.getByRole("option", { name: /.*/ }).last();
    await listbox.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: "instant" }));
    await expect(lastOption).toHaveAttribute("aria-posinset", String(total));
    const lastProduct = (await lastOption.innerText()).split("\n")[0];
    if (!lastProduct) throw new Error("The last product has no model name.");
    await lastOption.click();
    await expect(page.getByRole("button", { name: "Item 1 product" })).toContainText(lastProduct);
  }
});

test("manager can add and select a product from the quotation picker", async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name.replace(/\W/g, "")}-${Date.now()}`;
  const productName = `Playwright Wall ${suffix}`;
  const productCode = `PW${suffix}`.slice(0, 60);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await loginAs(page, "Reshma", "Manager");
  await page.goto("/quotations");
  await page.locator("#quote-step-customer ul button").first().click();
  await page.getByRole("button", { name: "Item 1 product" }).click();

  const picker = page.getByRole("dialog", { name: "Choose product" });
  await picker.getByRole("button", { name: "Add new product" }).click();
  const productForm = page.getByRole("dialog", { name: "Add new product" });
  await productForm.getByLabel("New product name").fill(productName);
  await productForm.getByLabel("New product code").fill(productCode);
  await productForm.getByLabel("New product unit").fill("Nos");
  await productForm.getByLabel("New product price").fill("25000");
  await productForm.getByLabel("New product GST rate").selectOption("12");
  await productForm.getByRole("button", { name: "Add product", exact: true }).click();

  await expect(productForm).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Item 1 product" })).toContainText(productName);
  await expect(page.locator('#quote-step-products select[aria-label="GST rate for item 1"]:visible').first()).toHaveValue("12");
  await expect(page.locator('#quote-step-products dl:visible').getByText("Rs. 28,000")).toBeVisible();
});

test("quotation preview totals mixed item GST rates and extra-charge GST", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await loginAs(page, "Reshma", "Manager");
  await page.goto("/quotations");
  await page.locator("#quote-step-customer ul button").first().click();

  await page.getByRole("button", { name: "Item 1 product" }).click();
  const picker = page.getByRole("dialog", { name: "Choose product" });
  await picker.getByRole("searchbox", { name: "Search products by name, code or description" }).fill("cassette");
  await picker.getByRole("option", { name: /cassette/i }).first().click();
  await page.locator('#quote-step-products select[aria-label="GST rate for item 1"]:visible').first().selectOption("5");
  await page.getByRole("button", { name: "Add charge" }).click();
  await page.getByLabel("Extra charge 1 label").fill("Freight");
  await page.getByLabel("Extra charge 1 amount").fill("100");
  await page.locator('#quote-step-products select[aria-label="GST rate for extra charge 1"]:visible').selectOption("12");
  await page.route("**/api/quotations/share", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ url: "https://blob.example/mixed-gst-quotation.pdf" }),
  }));
  await page.getByRole("button", { name: "Preview", exact: true }).click();

  const offer = page.locator("article.offer-document");
  await expect(offer.getByText("GST @ 5%", { exact: true }).first()).toBeVisible();
  await expect(offer.getByText("Rs. 6,100.00").first()).toBeVisible();
  await expect(offer.getByText("GST @ 12%", { exact: true }).first()).toBeVisible();
  await expect(offer.getByText("Freight (+ GST 12%)")).toBeVisible();
  await expect(offer.getByText("Rs. 100.00")).toBeVisible();
  await expect(offer.getByText("Rs. 1,28,212.00")).toBeVisible();
});

test("saved quotation keeps customer details and can download and share its PDF", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const mobileViewport = page.viewportSize()?.width === 390;
  await page.goto("/login");
  await loginAs(page, "Reshma", "Manager");
  await page.goto("/quotations");
  await page.getByRole("button", { name: /Saved quotations/ }).click();
  const savedDialog = page.getByRole("dialog", { name: "Saved quotations" });
  const quoteCard = savedDialog.locator("article").filter({ hasText: "225/26-27" });
  await expect(quoteCard).toContainText("Sri Lakshmi Textiles");
  await quoteCard.getByRole("button", { name: "View" }).click();

  const offer = page.locator("article.offer-document");
  await expect(offer.getByText("Client", { exact: true }).locator("..")).toContainText("Sri Lakshmi Textiles");
  await expect(page.getByRole("button", { name: /Download (?:quotation )?PDF/ })).toBeEnabled();
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

  await page.getByRole("button", { name: "Email" }).click();
  const emailDialog = page.getByRole("dialog", { name: "Email quotation" });
  await expect(emailDialog).toBeVisible();
  const manualPdfDownload = page.waitForEvent("download");
  const directPdfResponse = page.waitForResponse((response) =>
    response.url().includes("/api/quotations/pdf") && response.request().method() === "POST",
  );
  await emailDialog.getByRole("button", { name: "Send email" }).click();
  const [pdfResponse, emailDownload] = await Promise.all([directPdfResponse, manualPdfDownload]);
  expect(pdfResponse.ok()).toBe(true);
  expect(emailDownload.suggestedFilename()).toMatch(/^offer-.*\.pdf$/);
  await expect(page.getByText(/PDF storage is unavailable\. The PDF was downloaded/)).toBeVisible();
  await expect(emailDialog).not.toBeVisible();
});

test("editing a saved quotation revises the same quote and regenerates its PDF", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/login");
  await loginAs(page, "Reshma", "Manager");
  await page.goto("/quotations");
  const savedButton = page.getByRole("button", { name: /Saved quotations/ });
  const countBefore = Number((await savedButton.textContent())?.match(/\((\d+)\)/)?.[1]);
  await page.locator("#quote-step-customer ul button").first().click();
  await page.getByRole("button", { name: "Item 1 product" }).click();
  await page.getByRole("dialog", { name: "Choose product" }).getByRole("option").first().click();
  await page.locator('#quote-step-products select[aria-label="GST rate for item 1"]:visible').first().selectOption("5");
  await page.getByRole("button", { name: "Add charge" }).click();
  await page.getByLabel("Extra charge 1 label").fill("Revision freight");
  await page.getByLabel("Extra charge 1 amount").fill("100");
  await page.locator('#quote-step-products select[aria-label="GST rate for extra charge 1"]:visible').selectOption("12");
  await page.route("**/api/quotations/share", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ url: "https://blob.example/revised-quotation.pdf" }),
  }));
  await page.getByRole("button", { name: "Preview Offer" }).click();

  const offer = page.locator("article.offer-document");
  await expect(offer).toBeVisible();
  const offerReference = await offer.getByText("Offer Ref").locator("..").innerText();
  const offerNo = offerReference.match(/\d+\/\d{2}-\d{2}/)?.[0];
  if (!offerNo) throw new Error("The new quotation did not display its offer number.");
  await expect(savedButton).toHaveText(`Saved quotations (${countBefore + 1})`);

  await savedButton.click();
  const savedDialog = page.getByRole("dialog", { name: "Saved quotations" });
  const quoteCard = savedDialog.locator("article").filter({ hasText: offerNo });
  await quoteCard.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#quote-step-products")).toBeVisible();
  await expect(page.getByLabel("Extra charge 1 label")).toHaveValue("Revision freight");
  await expect(page.getByLabel("Extra charge 1 amount")).toHaveValue("100");
  await expect(page.locator('#quote-step-products select[aria-label="GST rate for item 1"]:visible').first()).toHaveValue("5");
  await expect(page.locator('#quote-step-products select[aria-label="GST rate for extra charge 1"]:visible')).toHaveValue("12");
  const desktopQuantity = page.locator('#quote-step-products input[aria-label="Quantity"]:visible').first();
  if (await desktopQuantity.isVisible()) {
    await desktopQuantity.fill("2");
  } else {
    await page.getByLabel("Quantity for item 1", { exact: true }).fill("2");
  }
  await page.getByRole("button", { name: "Save revision" }).click();

  await expect(offer.getByText("Offer Ref").locator("..")).toContainText(`${offerNo} /R1`);
  await expect(offer.getByText("Revision freight")).toBeVisible();
  await expect(savedButton).toHaveText(`Saved quotations (${countBefore + 1})`);
  await savedButton.click();
  const revisedCard = page.getByRole("dialog", { name: "Saved quotations" }).locator("article").filter({ hasText: `${offerNo}/R1` });
  await expect(revisedCard).toHaveCount(1);
  await revisedCard.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#quote-step-products")).toBeVisible();
  const secondEditQuantity = page.locator('#quote-step-products input[aria-label="Quantity"]:visible').first();
  if (await secondEditQuantity.isVisible()) {
    await secondEditQuantity.fill("3");
  } else {
    await page.getByLabel("Quantity for item 1", { exact: true }).fill("3");
  }
  await page.getByRole("button", { name: "Save revision" }).click();
  await expect(offer.getByText("Offer Ref").locator("..")).toContainText(`${offerNo} /R2`);
  await expect(savedButton).toHaveText(`Saved quotations (${countBefore + 1})`);
});

test("quotation preview and saved quotation open an editable, prefilled email composer", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/login");
  await loginAs(page, "Reshma", "Manager");
  await page.goto("/quotations");
  await page.locator("#quote-step-customer ul button").filter({ hasText: "Srinivas Rao" }).click();
  await page.getByRole("button", { name: "Item 1 product" }).click();
  await page.getByRole("dialog", { name: "Choose product" }).getByRole("option").first().click();
  await page.route("**/api/quotations/share", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ url: "https://blob.example/email-quotation.pdf" }),
  }));
  await page.getByRole("button", { name: "Preview Offer" }).click();
  const offer = page.locator("article.offer-document");
  await expect(offer).toBeVisible();
  await page.getByRole("button", { name: "Email", exact: true }).click();
  const emailDialog = page.getByRole("dialog", { name: "Email quotation" });
  const recipient = emailDialog.getByLabel("Recipient email");
  await expect(recipient).toHaveValue("srinivas@example.com");
  await recipient.fill("accounts@example.com");
  await expect(recipient).toHaveValue("accounts@example.com");
  await emailDialog.getByRole("button", { name: "Cancel" }).click();

  const savedButton = page.getByRole("button", { name: /Saved quotations/ });
  await savedButton.click();
  const card = page.getByRole("dialog", { name: "Saved quotations" }).locator("article").filter({ hasText: "Sri Lakshmi Textiles" }).first();
  await card.getByRole("button", { name: "Email" }).click();
  const savedEmailDialog = page.getByRole("dialog", { name: "Email quotation" });
  await expect(savedEmailDialog.getByLabel("Recipient email")).toHaveValue("srinivas@example.com");
});

test("the newest five saved quotes work at 360px and 1280px without duplicate offer numbers", async ({ page }) => {
  await page.goto("/login");
  await loginAs(page, "Reshma", "Manager");
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

      const savedPdfHeading = page.getByRole("heading", { name: "Saved quotation PDF" });
      const offer = page.locator("article.offer-document");
      await expect.poll(async () => (await savedPdfHeading.isVisible()) || (await offer.isVisible())).toBe(true);
      if (await savedPdfHeading.isVisible()) {
        const pdfLink = page.getByRole("link", { name: "Open PDF" });
        const pdfUrl = await pdfLink.getAttribute("href");
        expect(pdfUrl).toMatch(/^https:\/\/public\.blob\.vercel-storage\.com\/quotes\/.+\.pdf$/);
        await expect(page.getByTitle("Saved quotation PDF")).toHaveAttribute("src", pdfUrl!);
        continue;
      }

      await expect(offer.getByText("Client", { exact: true })).toBeVisible();
      const clientDetails = offer.getByText("Client", { exact: true }).locator("..");
      await expect(clientDetails).not.toContainText("Customer details not saved with this quote");
      expect((await clientDetails.innerText()).replace(/\D/g, "")).toMatch(/\d{10}/);
      await expect(page.getByRole("button", { name: /Download (?:quotation )?PDF/ })).toBeEnabled();
      await expect(page.getByRole("button", { name: "WhatsApp" })).toBeEnabled();

      const pdfResponsePromise = page.waitForResponse((response) =>
        response.url().includes("/api/quotations/pdf") && response.request().method() === "POST",
      );
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: /Download (?:quotation )?PDF/ }).click();
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
  await loginAs(page, "Reshma", "Manager");
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
  await loginAs(page, "Reshma", "Manager");
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
    for (const name of ["Download quotation PDF", "Share quotation on WhatsApp"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(box?.height).toBe(44);
    }
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  }
});
