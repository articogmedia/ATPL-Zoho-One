import { expect, test } from "@playwright/test";

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test(`work cards align without horizontal overflow at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
    await page.waitForURL(/\/(?:home|leads)(?:\?.*)?$/);
    await page.goto("/visits");

    const tabs = [
      { label: "Tasks", pattern: /^Tasks \(/ },
      { label: "In Progress", pattern: /^In Progress \(/ },
      { label: "Upcoming Visits", pattern: /^Upcoming Visits \(/ },
      { label: "Completed", pattern: /^Completed \(/ },
    ];
    for (const tab of tabs) {
      await page.getByRole("button", { name: tab.pattern }).click();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const card = page.locator("#work-list article").first();
      if (await card.count()) {
        await expect(card).toBeVisible();
        if (tab.label === "Tasks") {
          const actionButtons = [
            card.getByRole("button", { name: /Start Work/ }),
            card.getByRole("button", { name: /Mark Completed/ }),
            card.getByRole("button", { name: /Reschedule/ }),
          ];
          const boxes = await Promise.all(actionButtons.map((button) => button.boundingBox()));
          expect(boxes.every(Boolean)).toBe(true);
          expect(boxes.map((box) => box!.height)).toEqual([64, 64, 64]);
          expect(Math.max(...boxes.map((box) => box!.width)) - Math.min(...boxes.map((box) => box!.width))).toBeLessThanOrEqual(1);
        }
      } else {
        await expect(page.getByText("Nothing here.")).toBeVisible();
      }
    }

    if (viewport.width >= 1366) {
      await page.getByRole("button", { name: /^Tasks \(/ }).click();
      const cards = page.locator("#work-list article");
      const cardCount = await cards.count();
      if (cardCount > 1) {
        const firstRowCount = 3;
        const boxes = await Promise.all(Array.from({ length: Math.min(firstRowCount, cardCount) }, (_, index) => cards.nth(index).boundingBox()));
        expect(boxes.every(Boolean)).toBe(true);
        expect(Math.max(...boxes.map((box) => box!.height)) - Math.min(...boxes.map((box) => box!.height))).toBeLessThanOrEqual(1);
      }
    }
  });
}

test("work actions start, reschedule, and confirm completion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
  await page.waitForURL(/\/(?:home|leads)(?:\?.*)?$/);
  await page.goto("/visits");

  const task = page.locator("#work-list article").filter({ has: page.getByRole("button", { name: /Start Work/ }) }).first();
  await task.getByRole("button", { name: "Call lead" }).click();
  const callDialog = page.getByRole("dialog", { name: "Call lead" });
  await expect(callDialog).toBeVisible();
  await expect(callDialog.getByRole("link", { name: "Open dialer" })).toHaveAttribute("href", /^tel:\+91\d{10}$/);
  await callDialog.getByRole("button", { name: "Not answered" }).click();
  await callDialog.getByRole("button", { name: "Save outcome" }).click();
  await expect(callDialog).toHaveCount(0);

  await task.getByRole("button", { name: /Start Work/ }).click();
  await expect(page.getByRole("button", { name: /^In Progress \(/ })).toHaveClass(/bg-primary/);
  const progressTask = page.locator("#work-list article").first();
  await expect(progressTask.getByRole("button", { name: /Mark Completed/ })).toBeVisible();

  await progressTask.getByRole("button", { name: /Reschedule/ }).click();
  const reschedule = page.getByRole("dialog", { name: "Reschedule task" });
  await expect(reschedule).toBeVisible();
  await reschedule.getByLabel("New date").fill("2026-11-06");
  await reschedule.getByRole("button", { name: "Save new date" }).click();
  await expect(reschedule).toHaveCount(0);

  await page.locator("#work-list article").first().getByRole("button", { name: /Mark Completed/ }).click();
  const confirmation = page.getByRole("dialog", { name: /Mark this task completed/ });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Confirm completed" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.locator("#work-list article").first().getByText("Completed", { exact: true })).toBeVisible();
});
