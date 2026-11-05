import { expect, test } from "@playwright/test";

test("manager can create and manage a lead from the list", async ({ page }) => {
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
  await page.getByRole("button", { name: "Add Lead", exact: true }).last().click();

  const row = page.locator("#leads-list tbody tr").filter({ hasText: "E2E Lead" });
  await expect(row).toBeVisible();
  await expect(allLeadsTab).toContainText(`(${initialCount + 1})`);
  await expect(row.getByRole("link", { name: "Call E2E Lead" })).toHaveAttribute("href", "tel:+918111111199");
  await expect(row.getByRole("link", { name: "Message E2E Lead on WhatsApp" })).toHaveAttribute("href", "https://wa.me/918111111199");

  await row.getByRole("button", { name: "Edit E2E Lead" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit lead" });
  await editDialog.getByLabel("Name").fill("E2E Lead Updated");
  await editDialog.getByRole("button", { name: "Save", exact: true }).click();
  const updatedRow = page.locator("#leads-list tbody tr").filter({ hasText: "E2E Lead Updated" });
  await expect(updatedRow).toBeVisible();

  await updatedRow.getByRole("button", { name: "Reassign E2E Lead Updated" }).click();
  const reassignDialog = page.getByRole("dialog", { name: "Reassign owner" });
  const confirm = reassignDialog.getByRole("button", { name: "Confirm" });
  await expect(confirm).toBeDisabled();
  await reassignDialog.getByLabel("Assign to").selectOption("Anil");
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await page.locator('[data-tab="assigned"]').click();
  const assignedRow = page.locator("#leads-list tbody tr").filter({ hasText: "E2E Lead Updated" });
  await expect(assignedRow).toBeVisible();
  await assignedRow.getByRole("button", { name: "Delete E2E Lead Updated" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete lead" });
  await expect(deleteDialog.getByText(/Recycle Bin/)).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(assignedRow).toHaveCount(0);
});
