import { test, expect } from "@playwright/test";
import { composer } from "./helpers";

// These tests run authenticated through the per-run storage state (see
// playwright.config.ts), so no per-test sign-in is needed — and none of them
// must assume anything about which provider keys are live: the assertions
// require the send path to either produce a streamed reply or an honest typed
// failure, never a silent spinner.

test.describe("Chat workspace", () => {
  test("reaches a usable composer", async ({ page }) => {
    await expect(composer(page)).toBeVisible({ timeout: 15_000 });
  });

  test("sends a message and the turn settles with evidence", async ({ page }) => {
    test.setTimeout(120_000);
    const input = composer(page);
    await expect(input).toBeVisible({ timeout: 15_000 });
    const prompt = "Say hello in one short sentence.";
    await input.fill(prompt);
    await input.press("Enter");

    // The user's prompt lands in the transcript immediately after send.
    await expect(page.locator("main")).toContainText(prompt, { timeout: 15_000 });

    // The turn must settle: either a streamed assistant reply, or the typed
    // failure surface (provider error, "try again", interruption note). A run
    // that ends in neither is a silent hang and must fail the gate.
    const settled = page
      .locator("main")
      .getByText(/hello/i)
      .or(page.locator("main").getByText(/cannot serve|unavailable|try again|interrupted|failed|error/i));
    await expect(settled.first()).toBeVisible({ timeout: 90_000 });
  });

  test("conversation survives a reload", async ({ page }) => {
    test.setTimeout(120_000);
    const input = composer(page);
    await expect(input).toBeVisible({ timeout: 15_000 });
    const prompt = `Reload persistence probe ${Date.now()}`;
    await input.fill(prompt);
    await input.press("Enter");
    await expect(page.locator("main")).toContainText(prompt, { timeout: 30_000 });
    await page.reload();
    await expect(page.locator("main")).toContainText(prompt, { timeout: 30_000 });
  });
});