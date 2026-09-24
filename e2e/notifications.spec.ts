import { test, expect, type Page } from "@playwright/test";

// The notifications popover, opened from the sidebar's Notifications row and
// from the command menu, authenticated through the shared storage state. The
// seeded account may have notifications or none, so either answer passes:
// the empty state's sentence, or a list. What it asserts is the part that is
// the same for everyone: the popover opens where the sidebar is (the column,
// or the drawer on a phone), and "Mark all as read" clears the dot.

/** The row, whatever its unread count says ("Notifications" or "Notifications, 3 unread"). */
function notificationsRow(page: Page) {
  return page.getByRole("button", { name: /^Notifications(, \d+ unread)?$/ });
}

async function openFromSidebar(page: Page) {
  const row = notificationsRow(page);
  // Below md the sidebar is the phone drawer, and the row is inside it.
  if (!(await row.first().isVisible())) {
    await page.getByRole("button", { name: "Open menu" }).click();
  }
  await row.first().click();
}

function inbox(page: Page) {
  return page.getByRole("dialog", { name: "Notifications" });
}

test.describe("Notifications", () => {
  test("opens from the sidebar with a list or the empty state, and marks all read", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.locator("#juno-composer-textarea, textarea").first()).toBeVisible({ timeout: 30_000 });

    await openFromSidebar(page);
    const popover = inbox(page);
    await expect(popover).toBeVisible();
    await expect(popover.getByText("Nothing new").or(popover.getByRole("list"))).toBeVisible({ timeout: 15_000 });

    const markAll = popover.getByRole("button", { name: "Mark all as read" });
    if (await markAll.isVisible()) {
      await markAll.click();
      await expect(markAll).toBeHidden();
      // The dot has gone, and the count with it from the row's name.
      await expect(page.getByRole("button", { name: /^Notifications, \d+ unread$/ })).toHaveCount(0);
    }

    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
  });

  test("opens from the command menu", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.locator("#juno-composer-textarea, textarea").first()).toBeVisible({ timeout: 30_000 });

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("juno:command-palette")));
    await page.getByRole("combobox").fill("notifications");
    await page.getByRole("option", { name: /Open notifications/ }).click();

    const popover = inbox(page);
    await expect(popover).toBeVisible({ timeout: 10_000 });
    await expect(popover.getByText("Nothing new").or(popover.getByRole("list"))).toBeVisible({ timeout: 15_000 });
  });
});
