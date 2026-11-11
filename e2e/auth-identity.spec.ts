import { expect, test } from "@playwright/test";

for (const { username, name } of [
  { username: "pavan", name: "Pavan" },
  { username: "saikiran", name: "Sai Kiran" },
]) {
  test(`${username} sees their own name and role in the header`, async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: `Continue as ${name}, Sales Executive` }).click();
    await page.waitForURL(/\/home$/);

    const header = page.locator("header");
    const identityIndex = (await page.evaluate(() => window.innerWidth)) >= 1024 ? 0 : 1;
    await expect(header.getByText(name, { exact: true }).nth(identityIndex)).toBeVisible();
    await expect(header.getByText("Sales Executive", { exact: true }).nth(identityIndex)).toBeVisible();

    await page.goto("/leads");
    await expect(page.getByRole("tab")).toHaveCount(3);
    await expect(page.getByRole("tab", { name: /^Assigned/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /^Follow-ups\/Callback/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /^My Leads/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Fresh Leads to Call|All Leads/ })).toHaveCount(0);
  });
}

test("Calling Team can only see Fresh/Callback tabs and assign a fresh lead", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue as Calling Team, Calling Team" }).click();
  await page.waitForURL(/\/home$/);
  await page.goto("/leads");

  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: /^Fresh(?:\s|$)/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Call Back" })).toBeVisible();

  const desktopRow = page.locator("#leads-list tbody tr").first();
  const mobileCard = page.locator("#leads-list-mobile [data-testid='mobile-lead-card']").first();
  const leadName = await (await desktopRow.isVisible() ? desktopRow : mobileCard).locator(
    (await desktopRow.isVisible() ? "td:first-child" : ".font-semibold"),
  ).innerText();
  await (await desktopRow.isVisible() ? desktopRow : mobileCard).click();

  const drawer = page.getByRole("dialog", { name: leadName });
  await drawer.getByRole("combobox", { name: "Assign to Sales Executive" }).click();
  await page.getByRole("option", { name: "Anil", exact: true }).click();
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  const assignmentResult = await page.evaluate(async (name) => {
    const [freshResponse, assignedResponse] = await Promise.all([
      fetch("/api/leads?tab=fresh&page=1"),
      fetch("/api/leads?tab=assigned&page=1"),
    ]);
    const freshBody = await freshResponse.json() as { leads: { name: string }[] };
    const assignedBody = await assignedResponse.json() as { leads: { name: string }[] };
    return {
      remainsFresh: freshBody.leads.some((lead) => lead.name === name),
      canReadAssignedTab: assignedBody.leads.length > 0,
    };
  }, leadName.trim().split("\n")[0]);
  expect(assignmentResult.remainsFresh).toBe(false);
  expect(assignmentResult.canReadAssignedTab).toBe(false);
});
