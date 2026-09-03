import { test, expect } from "@playwright/test";

// The sign-in surface is tested ANONYMOUS: `test.use` overrides the shared
// storage state for this file, because an already-signed-in visitor is
// redirected away from /sign-in.

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Authentication surfaces", () => {
  test("sign-in page validates its form structure", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page).toHaveTitle(/Juno|Sign In/i);
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test("rejects invalid credentials with the real product message", async ({ page }) => {
    await page.goto("/sign-in");
    await page.fill('input[type="email"]', "nonexistent@user.com");
    await page.fill('input[type="password"]', "WrongPassword123!");
    await page.click('button[type="submit"]');
    await expect(page.locator("text=Invalid email or password.")).toBeVisible({ timeout: 10_000 });
  });

  test("forgot-password page is accessible", async ({ page }) => {
    await page.goto("/forgot-password");
    const email = page.locator('input[type="email"]');
    const submit = page.locator('button[type="submit"]');
    await expect(email).toBeVisible();
    await expect(submit).toBeVisible();
    // Without a configured email provider the form renders disabled with an
    // explanatory note rather than a warning-only state, so this holds in
    // every environment — with email configured the controls are live.
    if (await submit.isDisabled()) {
      await expect(email).toBeDisabled();
      await expect(page.locator('[role="note"]')).toContainText(/email is not set up/i);
    }
  });
});