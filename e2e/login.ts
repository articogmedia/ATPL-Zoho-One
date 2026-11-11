import { expect, type Page } from "@playwright/test";

const credentials: Record<string, { username: string; password: string }> = {
  Reshma: { username: "reshma", password: "playwright-reshma-password" },
  Pavan: { username: "pavan", password: "playwright-pavan-password" },
  "Sai Kiran": { username: "saikiran", password: "playwright-saikiran-password" },
  "Calling Team": { username: "calling", password: "playwright-calling-password" },
};

export async function loginAs(page: Page, name: string, role: string) {
  const demoButton = page.getByRole("button", { name: `Continue as ${name}, ${role}` });
  if (await demoButton.count()) {
    await demoButton.click();
  } else {
    const user = credentials[name];
    if (!user) throw new Error(`No Playwright credentials configured for ${name}.`);
    await page.locator("#login-username").fill(user.username);
    await page.locator("#login-password").fill(user.password);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page).toHaveURL(/\/home$/);
}
