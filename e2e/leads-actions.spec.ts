import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __advanceTime: (milliseconds: number) => void;
  }
}

test("manager can create and manage a lead from the list", async ({ page }) => {
  await page.addInitScript(() => {
    const originalNow = Date.now.bind(Date);
    let offset = 0;
    Date.now = () => originalNow() + offset;
    Object.defineProperty(window, "__advanceTime", {
      configurable: true,
      value: (milliseconds: number) => { offset += milliseconds; },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { window.name = value; } },
    });
  });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
  await page.waitForURL(/\/(?:home|leads)(?:\?.*)?$/);
  await page.goto("/leads");
  await expect(page.getByRole("heading", { name: "Manage Leads" })).toBeVisible();
  await page.waitForTimeout(1000);
  const refreshRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("leads") || request.url().includes("_rsc")) refreshRequests.push(request.url());
  });
  await page.evaluate(() => {
    window.__advanceTime(10 * 60 * 1000);
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForTimeout(1000);
  expect(refreshRequests.length).toBeGreaterThan(0);

  const allLeadsTab = page.locator('[data-tab="all"]');
  const initialCount = Number((await allLeadsTab.textContent())?.match(/\((\d+)\)/)?.[1]);
  await page.getByRole("button", { name: "Add Lead", exact: true }).click();
  await page.getByLabel("Lead name *").fill("E2E Lead");
  await page.getByLabel("Mobile number *").fill("8111111199");
  await page.getByLabel("Source", { exact: true }).click();
  await page.getByRole("option", { name: "Website", exact: true }).click();
  await expect(page.getByLabel("Source", { exact: true })).toContainText("Website");
  await page.getByLabel("Assign to").click();
  await page.getByRole("option", { name: "Anil", exact: true }).click();
  await expect(page.getByLabel("Assign to")).toContainText("Anil");
  await page.getByRole("button", { name: "Add Lead", exact: true }).last().click();

  const row = page.locator("#leads-list tbody tr").filter({ hasText: "E2E Lead" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Website");
  await expect(row).toContainText("Anil");
  await expect(allLeadsTab).toContainText(`(${initialCount + 1})`);
  await expect(row.getByRole("link", { name: "Message E2E Lead on WhatsApp" })).toHaveAttribute("href", "https://wa.me/918111111199");

  await row.getByRole("button", { name: "Call E2E Lead" }).click();
  const callDialog = page.getByRole("dialog", { name: "Call lead" });
  await expect(callDialog).toContainText("E2E Lead");
  await expect(callDialog.getByRole("link", { name: "Open dialer" })).toHaveAttribute("href", "tel:+918111111199");
  await expect(callDialog.getByRole("link", { name: "WhatsApp" })).toHaveAttribute("href", "https://wa.me/918111111199");
  await callDialog.getByRole("button", { name: "Copy number" }).click();
  await expect(page.getByText("Copied")).toBeVisible();
  expect(await page.evaluate(() => window.name)).toBe("8111111199");
  await callDialog.getByRole("button", { name: "Answered", exact: true }).click();
  await callDialog.getByRole("button", { name: "Save outcome" }).click();
  await expect(callDialog).toHaveCount(0);
  await expect(page.getByText("Call outcome saved")).toBeVisible();

  await row.click();
  const leadDrawer = page.getByRole("dialog", { name: "E2E Lead" });
  await leadDrawer.getByRole("button", { name: "History", exact: true }).first().click();
  await expect(leadDrawer.getByText(/Call: Connected/)).toBeVisible();
  await page.getByRole("button", { name: "Close lead details" }).click();

  await row.getByRole("button", { name: "Edit E2E Lead" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit lead" });
  await editDialog.getByLabel("Name").fill("E2E Lead Updated");
  await editDialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Direct Call", exact: true }).click();
  await editDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Lead updated", { exact: true })).toBeVisible();
  const updatedRow = page.locator("#leads-list tbody tr").filter({ hasText: "E2E Lead Updated" });
  await expect(updatedRow).toBeVisible();
  await expect(updatedRow).toContainText("Direct Call");

  await updatedRow.getByRole("button", { name: "Reassign E2E Lead Updated" }).click();
  const reassignDialog = page.getByRole("dialog", { name: "Reassign owner" });
  const confirm = reassignDialog.getByRole("button", { name: "Confirm" });
  await expect(confirm).toBeDisabled();
  await expect(reassignDialog).toContainText("E2E Lead Updated");
  await reassignDialog.getByLabel("Assign to").click();
  await expect(page.getByRole("option", { name: "Sai Kiran", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Anil", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "Sai Kiran", exact: true }).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  const reassignedRow = page.locator("#leads-list tbody tr").filter({ hasText: "E2E Lead Updated" });
  await expect(reassignedRow).toBeVisible();
  await expect(reassignedRow).toContainText("Sai Kiran");

  await page.locator('[data-tab="all"]').click();
  const allLeadsRow = page.locator("#leads-list tbody tr").filter({ hasText: "E2E Lead Updated" });
  await expect(allLeadsRow).toBeVisible({ timeout: 30000 });
  const deleteButton = allLeadsRow.getByRole("button", { name: "Delete E2E Lead Updated" });
  await expect(deleteButton).toBeVisible();
  await deleteButton.click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete lead" });
  await expect(deleteDialog.getByText("Delete E2E Lead Updated? This can't be undone.")).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(allLeadsRow).toHaveCount(0);
});

test("reassign immediately removes an owner from My Leads but keeps the lead in All Leads", async ({ page }) => {
  const mobile = `8${Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0")}`;
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
  await page.waitForURL(/\/(?:home|leads)(?:\?.*)?$/);
  await page.goto("/leads");
  await expect(page.getByRole("heading", { name: "Manage Leads" })).toBeVisible();
  const initialMineCount = Number((await page.locator('[data-tab="mine"]').textContent())?.match(/\((\d+)\)/)?.[1]);

  await page.getByRole("button", { name: "Add Lead", exact: true }).click();
  await page.getByLabel("Lead name *").fill("Reassignment Membership Lead");
  await page.getByLabel("Mobile number *").fill(mobile);
  await page.getByLabel("Assign to").click();
  await page.getByRole("option", { name: "Reshma", exact: true }).click();
  await page.getByRole("button", { name: "Add Lead", exact: true }).last().click();

  const leadText = "Reassignment Membership Lead";
  await expect(page.locator("#leads-list tbody tr").filter({ hasText: leadText })).toBeVisible();
  await expect(page.locator('[data-tab="all"]')).toHaveAttribute("aria-selected", "true");
  await page.locator('[data-tab="mine"]').click();
  const mineTab = page.locator('[data-tab="mine"]');
  await expect(mineTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#leads-list tbody tr").filter({ hasText: leadText })).toBeVisible();
  await expect(mineTab).toContainText(`(${initialMineCount + 1})`);
  const mineCountBefore = Number((await mineTab.textContent())?.match(/\((\d+)\)/)?.[1]);
  const assignedCountBefore = Number((await page.locator('[data-tab="assigned"]').textContent())?.match(/\((\d+)\)/)?.[1]);

  await page.locator("#leads-list tbody tr").filter({ hasText: leadText })
    .getByRole("button", { name: `Reassign ${leadText}` }).click();
  const dialog = page.getByRole("dialog", { name: "Reassign owner" });
  await dialog.getByLabel("Assign to").click();
  await page.getByRole("option", { name: "Sai Kiran", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect(page.locator("#leads-list tbody tr").filter({ hasText: leadText })).toHaveCount(0);
  await expect(mineTab).toContainText(`(${mineCountBefore - 1})`);
  await expect(page.locator('[data-tab="assigned"]')).toContainText(`(${assignedCountBefore})`);

  await page.locator('[data-tab="all"]').click();
  const allRow = page.locator("#leads-list tbody tr").filter({ hasText: leadText });
  await expect(allRow).toBeVisible();
  await expect(allRow).toContainText("Sai Kiran");
});

test("mobile lead cards fit narrow viewports and have one WhatsApp action", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
  await page.waitForURL(/\/(?:home|leads)(?:\?.*)?$/);
  await page.goto("/leads");

  const cards = page.getByTestId("mobile-lead-card");
  await expect(cards.first()).toBeVisible();
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(cards.first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await cards.first().evaluate((card) => card.scrollWidth <= card.clientWidth)).toBe(true);

    const actions = cards.first().getByTestId("mobile-lead-actions");
    const actionTargets = actions.locator("button, a");
    await expect(actionTargets).toHaveCount(5);
    const dimensions = await actionTargets.evaluateAll((elements) =>
      elements.map((element) => {
        const { width: targetWidth, height: targetHeight } = element.getBoundingClientRect();
        return { width: targetWidth, height: targetHeight };
      }),
    );
    expect(dimensions.every(({ width: targetWidth, height: targetHeight }) => targetWidth >= 44 && targetHeight >= 44)).toBe(true);
    expect(Math.max(...dimensions.map(({ width: targetWidth }) => targetWidth)) - Math.min(...dimensions.map(({ width: targetWidth }) => targetWidth))).toBeLessThanOrEqual(1);
    expect(await cards.first().getByRole("link", { name: /Message .* on WhatsApp/ }).count()).toBeLessThanOrEqual(1);
  }

  const firstWithWhatsApp = cards.filter({ has: page.getByRole("link", { name: /Message .* on WhatsApp/ }) }).first();
  await expect(firstWithWhatsApp.getByRole("link", { name: /Message .* on WhatsApp/ })).toHaveCount(1);
  await expect(firstWithWhatsApp.getByRole("link", { name: /Call .* at / })).toHaveAttribute("href", /^tel:\+91\d{10}$/);
});
