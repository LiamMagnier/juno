import { test, expect } from "@playwright/test";

test.describe("Authentication E2E Flow", () => {
  test("Navigates to sign-in page and validates form structure", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page).toHaveTitle(/Juno|Sign In/i);
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test("Shows error on invalid credentials submission", async ({ page }) => {
    await page.goto("/sign-in");
    await page.fill('input[type="email"]', "nonexistent@user.com");
    await page.fill('input[type="password"]', "WrongPassword123!");
    await page.click('button[type="submit"]');
    // Expect error alert or message
    await expect(page.locator("text=/Invalid|error|Credentials/i")).toBeVisible({ timeout: 5000 });
  });

  test("Forgot password page is accessible", async ({ page }) => {
    await page.goto("/forgot-password");
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });
});
