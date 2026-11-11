import { expect, test } from "@playwright/test";

test("home greeting hydrates to the current Asia/Kolkata greeting", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydration/i.test(message.text())) hydrationErrors.push(message.text());
  });

  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
  await page.waitForURL(/\/home$/);

  await expect(page.getByRole("heading", {
    name: /^Good (morning|afternoon|evening), Reshma$/,
  })).toBeVisible();
  expect(hydrationErrors).toEqual([]);
});
