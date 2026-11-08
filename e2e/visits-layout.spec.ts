import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const viewport of [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 900 },
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
      { label: "Tasks", pattern: /^Tasks \(/, empty: /No assigned tasks right now/ },
      { label: "In Progress", pattern: /^In Progress \(/, empty: /Nothing is in progress/ },
      { label: "Upcoming Visits", pattern: /^Upcoming Visits \(/, empty: /No upcoming visits/ },
      { label: "Completed", pattern: /^Completed \(/, empty: /No completed work yet/ },
    ];
    for (const tab of tabs) {
      await page.getByRole("button", { name: tab.pattern }).click();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const card = page.locator("#work-list article").first();
      if (await card.count()) {
        await expect(card).toBeVisible();
        if (tab.label === "Tasks") {
          await expect(card.getByRole("button", { name: "Start Work" })).toBeVisible();
          const actionButtons = [
            card.getByRole("button", { name: "Call" }),
            card.locator('[aria-label="WhatsApp"]'),
            card.getByRole("link", { name: "Quotation" }),
            card.getByRole("button", { name: "Reschedule" }),
          ];
          const boxes = await Promise.all(actionButtons.map((button) => button.boundingBox()));
          expect(boxes.every(Boolean)).toBe(true);
          expect(boxes.map((box) => box!.height)).toEqual([44, 44, 44, 44]);
          expect(Math.max(...boxes.map((box) => box!.width)) - Math.min(...boxes.map((box) => box!.width))).toBeLessThanOrEqual(1);
          for (let first = 0; first < boxes.length; first += 1) {
            for (let second = first + 1; second < boxes.length; second += 1) {
              const a = boxes[first]!;
              const b = boxes[second]!;
              const intersects = Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x)
                && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
              expect(intersects, `action buttons ${first} and ${second} overlap at ${viewport.width}px`).toBe(false);
            }
          }
          const whatsapp = card.getByRole("link", { name: "WhatsApp" });
          if (await whatsapp.count()) await expect(whatsapp).toHaveAttribute("href", /^https:\/\/wa\.me\/91\d{10}\?text=/);
        }
      } else {
        await expect(page.getByText(tab.empty)).toBeVisible();
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

  const task = page.locator("#work-list article")
    .filter({ has: page.getByRole("button", { name: /Start Work/ }) })
    .filter({ hasText: /Site survey|Room inspection|Demo visit|Installation check|Collect advance/ })
    .first();
  await task.getByRole("button", { name: "Call" }).click();
  const callDialog = page.getByRole("dialog", { name: "Call lead" });
  await expect(callDialog).toBeVisible();
  await expect(callDialog.getByRole("link", { name: "Open dialer" })).toHaveAttribute("href", /^tel:\+91\d{10}$/);
  await callDialog.getByRole("button", { name: "Not answered" }).click();
  await callDialog.getByRole("button", { name: "Save outcome" }).click();
  await expect(callDialog).toHaveCount(0);

  const taskCountBefore = Number((await page.getByRole("button", { name: /^Tasks \(/ }).innerText()).match(/\((\d+)\)/)?.[1]);
  const upcomingCountBefore = Number((await page.getByRole("button", { name: /^Upcoming Visits \(/ }).innerText()).match(/\((\d+)\)/)?.[1]);
  await task.getByRole("button", { name: /Reschedule/ }).click();
  const reschedule = page.getByRole("dialog", { name: "Reschedule task" });
  await expect(reschedule).toBeVisible();
  const minDate = await reschedule.getByLabel("New date").getAttribute("min");
  expect(minDate).toBeTruthy();
  const yesterday = await page.evaluate((minimum) => {
    const date = new Date(`${minimum}T12:00:00`);
    date.setDate(date.getDate() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }, minDate!);
  await reschedule.getByLabel("New date").fill(yesterday);
  await expect(reschedule.getByRole("button", { name: "Save new date" })).toBeDisabled();
  await expect(reschedule.getByRole("alert")).toHaveText("Choose today or a future date.");
  await reschedule.getByRole("button", { name: "Tomorrow" }).click();
  await reschedule.getByLabel("Reason or notes").fill("Customer requested a new time");
  await reschedule.getByRole("button", { name: "Save new date" }).click();
  await expect(reschedule).toHaveCount(0);
  await expect(page.getByText(/Rescheduled to .* \d{2}:\d{2}/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Upcoming Visits \(/ })).toHaveClass(/bg-primary/);
  await expect(page.getByRole("button", { name: new RegExp(`^Tasks \\(${taskCountBefore - 1}\\)$`) })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`^Upcoming Visits \\(${upcomingCountBefore + 1}\\)$`) })).toBeVisible();

  const upcomingTask = page.locator("#work-list article").first();
  await expect(upcomingTask.getByRole("button", { name: /Start Work/ })).toBeVisible();
  await upcomingTask.getByRole("button", { name: /Start Work/ }).click();
  await expect(upcomingTask.getByRole("button", { name: /Mark Completed/ })).toBeVisible();
  await upcomingTask.getByRole("button", { name: /Mark Completed/ }).click();
  const confirmation = page.getByRole("dialog", { name: /Mark this task completed/ });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Confirm completed" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.locator("#work-list article").first().getByText("Completed", { exact: true })).toBeVisible();
});

test("visits page has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as .*Manager/i }).first().click();
  await page.waitForURL(/\/(?:home|leads)(?:\?.*)?$/);
  await page.goto("/visits");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([]);
});
