import { test as setup, expect } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./helpers";

// One real credential sign-in per run, shared by every browser project through
// storage state. This keeps the suite from hammering the brute-force rate
// limiter (10 attempts / 15 min per account) and makes the run one sign-in
// instead of one per test per browser.
setup("authenticate the E2E account", async ({ page }) => {
  await page.goto("/sign-in");
  await page.fill('input[type="email"]', E2E_EMAIL);
  await page.fill('input[type="password"]', E2E_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/chat/, { timeout: 30_000 });
  await page.context().storageState({ path: "e2e/.auth/e2e-user.json" });
});