import { expect, test } from "@playwright/test";

test("manager can create and manage a lead from the list", async ({ page }) => {
  await page.addInitScript(() => {
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
  await expect(reassignDialog.getByLabel("Assign to").locator("option")).toContainText(["Select a team member", "Pavan", "Sai Kiran", "Anil", "Ravi"]);
  await reassignDialog.getByLabel("Assign to").selectOption("anil");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.locator("#leads-list tbody tr").filter({ hasText: "E2E Lead Updated" })).toBeVisible();

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
