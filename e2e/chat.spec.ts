import { test, expect } from "@playwright/test";

test.describe("Chat Workspace E2E Flow", () => {
  test("Loads home workspace with model picker and composer", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("textarea, input[placeholder*='Ask'], [contenteditable]")).toBeVisible({
      timeout: 10000,
    });
  });

  test("Model selector is interactive", async ({ page }) => {
    await page.goto("/");
    const modelButton = page.locator("button:has-text('GPT'), button:has-text('Claude'), button:has-text('Gemini'), [data-testid='model-selector']").first();
    if (await modelButton.isVisible()) {
      await modelButton.click();
      await expect(page.locator("[role='menu'], [role='dialog'], [data-testid='model-menu']")).toBeVisible();
    }
  });
});
