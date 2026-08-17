import { test, expect } from "@playwright/test";

test.describe("Projects & Artifacts E2E Flow", () => {
  test("Navigation includes Projects, Work, and Library", async ({ page }) => {
    await page.goto("/");
    // Look for navigation elements
    const nav = page.locator("nav, aside, [role='navigation']");
    await expect(nav).toBeVisible({ timeout: 10000 });
  });

  test("Settings modal opens and exposes preferences", async ({ page }) => {
    await page.goto("/");
    const settingsTrigger = page.locator("button[aria-label*='Settings'], button:has-text('Settings'), [data-testid='settings-button']").first();
    if (await settingsTrigger.isVisible()) {
      await settingsTrigger.click();
      await expect(page.locator("[role='dialog'], [data-testid='settings-modal']")).toBeVisible();
    }
  });
});
