import { expect, test } from "@playwright/test";

test("login links to the generic forgot-password flow", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.getByLabel("Registered email address").fill("unknown@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "If an account exists for that email address, a password reset link will be sent.",
  );
});

test("forgot password response does not reveal whether an email address exists", async ({ request }) => {
  const known = await request.post("/api/auth/forgot-password", {
    data: { email: "pavan@example.com" },
    headers: { "x-real-ip": "203.0.113.10" },
  });
  const unknown = await request.post("/api/auth/forgot-password", {
    data: { email: "unknown@example.com" },
    headers: { "x-real-ip": "203.0.113.10" },
  });

  expect(known.status()).toBe(200);
  expect(await known.json()).toEqual(await unknown.json());
});

test("reset form requires matching password confirmation", async ({ page }) => {
  await page.goto("/reset-password?token=invalid-test-token");
  await page.getByLabel("New password", { exact: true }).fill("new-password-value");
  await page.getByLabel("Confirm new password", { exact: true }).fill("different-password-value");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.locator('p[role="alert"]')).toHaveText("Passwords do not match.");
});

test("Manager can reset a portal user's password from home", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
  await page.waitForURL(/\/home$/);

  await page.getByText("Reset password for user", { exact: true }).click();
  await page.getByLabel("User").selectOption("pavan");
  await page.getByLabel("Temporary password").fill("manager-reset-password-123");
  await page.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.getByText("Password updated. The user's existing sessions have been signed out.")).toBeVisible();
});
