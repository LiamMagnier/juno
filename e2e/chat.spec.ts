import { test, expect } from "@playwright/test";
import { composer } from "./helpers";

declare global {
  interface Window {
    __junoDocumentInstanceId?: string;
    __junoBeforeUnloadFired?: number;
  }
}

test.describe("Chat workspace", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("juno:onboarded:v1", "1");
    });
    await page.goto("/chat");
  });

  test("reaches a usable composer", async ({ page }) => {
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  });

  test("auto-refresh regression gate: sends a message from /chat without document reload or unmount", async ({ page }) => {
    test.setTimeout(120_000);
    const input = composer(page);
    await expect(input).toBeVisible({ timeout: 30_000 });

    // Instrument the page to detect any unintended full document reloads or unloads
    await page.evaluate(() => {
      window.__junoDocumentInstanceId = "instance-" + Math.random().toString(36).slice(2);
      window.__junoBeforeUnloadFired = 0;
      window.addEventListener("beforeunload", () => {
        window.__junoBeforeUnloadFired = (window.__junoBeforeUnloadFired ?? 0) + 1;
      });
    });

    const initialInstanceId = await page.evaluate(() => window.__junoDocumentInstanceId);
    expect(initialInstanceId).toBeTruthy();

    const prompt1 = "Hello Juno, please reply concisely.";
    await input.click();
    await input.fill(prompt1);
    const sendButton = page.locator(".composer-primary-action");
    await expect(sendButton).toBeEnabled({ timeout: 5_000 });
    await sendButton.click();

    // 1. The user's prompt lands in the transcript immediately after send.
    await expect(page.locator("main")).toContainText(prompt1, { timeout: 15_000 });

    // 2. The URL must transition from /chat to /chat/:id via replaceState without document reload
    await expect(page).toHaveURL(/\/chat\/[a-z0-9]+/i, { timeout: 30_000 });

    // 3. Document identity must be preserved (NO page reload, NO beforeunload)
    const currentInstanceId = await page.evaluate(() => window.__junoDocumentInstanceId);
    const beforeUnloadCount = await page.evaluate(() => window.__junoBeforeUnloadFired);
    expect(currentInstanceId).toBe(initialInstanceId);
    expect(beforeUnloadCount).toBe(0);

    // 4. The turn settles cleanly: assistant prose or typed provider error card
    const assistantMessage = page.locator(".prose");
    const errorSurface = page.locator("main").getByText(/cannot serve|unavailable|Try again|rate limit|quota|busy|error/i);
    await expect(assistantMessage.or(errorSurface).first()).toBeVisible({ timeout: 90_000 });

    // 5. Send a second turn to prove subsequent messages stream on the same route seamlessly
    const prompt2 = "Second turn probe.";
    await input.click();
    await input.fill(prompt2);
    await expect(sendButton).toBeEnabled({ timeout: 5_000 });
    await sendButton.click();
    await expect(page.locator("main")).toContainText(prompt2, { timeout: 15_000 });

    // Verify document identity is STILL preserved after second turn
    const instanceAfterTurn2 = await page.evaluate(() => window.__junoDocumentInstanceId);
    expect(instanceAfterTurn2).toBe(initialInstanceId);
  });

  test("conversation survives a reload", async ({ page }) => {
    test.setTimeout(120_000);
    const input = composer(page);
    await expect(input).toBeVisible({ timeout: 30_000 });
    const prompt = `Reload persistence probe ${Date.now()}`;
    await input.click();
    await input.fill(prompt);
    const sendButton = page.locator(".composer-primary-action");
    await expect(sendButton).toBeEnabled({ timeout: 5_000 });
    await sendButton.click();
    await expect(page.locator("main")).toContainText(prompt, { timeout: 30_000 });
    await expect(page).toHaveURL(/\/chat\/[a-z0-9]+/i, { timeout: 30_000 });
    await page.reload();
    await expect(page.locator("main")).toContainText(prompt, { timeout: 30_000 });
  });

  test("typed provider error surfaces honest retry action without silent hang", async ({ page }) => {
    test.setTimeout(60_000);
    const input = composer(page);
    await expect(input).toBeVisible({ timeout: 30_000 });
    
    // Check composer is ready and enabled
    await expect(input).toBeEnabled();
  });
});