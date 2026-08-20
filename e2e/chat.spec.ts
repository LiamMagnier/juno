import { test, expect, type Page } from "@playwright/test";
import { composer } from "./helpers";

const SUCCESS_TOKEN = process.env.E2E_SUCCESS_TOKEN ?? "JUNO_HEALTHY_CHAT_OK";

declare global {
  interface Window {
    __junoDocumentInstanceId?: string;
    __junoBeforeUnloadFired?: number;
    __junoPageShowFired?: number;
    __junoPageHideFired?: number;
    __junoNavigationType?: string;
  }
}

function providerErrorSurface(page: Page) {
  return page.locator('main [class*="border-destructive"]');
}

async function instrumentDocument(page: Page) {
  await page.evaluate(() => {
    window.__junoDocumentInstanceId = `document-${Math.random().toString(36).slice(2)}`;
    window.__junoBeforeUnloadFired = 0;
    window.__junoPageShowFired = 0;
    window.__junoPageHideFired = 0;
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    window.__junoNavigationType = navigation?.type ?? "unknown";
    window.addEventListener("beforeunload", () => {
      window.__junoBeforeUnloadFired = (window.__junoBeforeUnloadFired ?? 0) + 1;
    });
    window.addEventListener("pageshow", () => {
      window.__junoPageShowFired = (window.__junoPageShowFired ?? 0) + 1;
    });
    window.addEventListener("pagehide", () => {
      window.__junoPageHideFired = (window.__junoPageHideFired ?? 0) + 1;
    });
  });
}

async function sendSuccessfulTurn(page: Page, prompt: string) {
  const input = composer(page);
  const sendButton = page.locator(".composer-primary-action");
  const streamResponse = page.waitForResponse(
    (response) => {
      const request = response.request();
      return request.method() === "POST" && new URL(response.url()).pathname === "/api/chat";
    },
    { timeout: 30_000 },
  );
  await input.fill(prompt);
  await expect(sendButton).toBeEnabled({ timeout: 5_000 });
  await sendButton.click();
  await expect(page.locator("main")).toContainText(prompt, { timeout: 15_000 });

  const response = await streamResponse;
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["content-type"] ?? "").toMatch(/text\/event-stream/i);

  // A successful turn has actual assistant content, not merely an ended HTTP
  // response. The token is deliberately controlled so the provider path must
  // stream a deterministic success marker.
  await expect(page.locator(".prose-juno").last()).toContainText(SUCCESS_TOKEN, { timeout: 90_000 });
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  await expect(providerErrorSurface(page)).toHaveCount(0);
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

  test("healthy chat streams success without a document reload or ChatView remount", async ({ page }) => {
    test.setTimeout(150_000);
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    await instrumentDocument(page);

    const root = page.locator("[data-juno-chat-root]");
    await expect(root).toHaveAttribute("data-juno-chat-mount-id", /chat-mount-/);
    const initialMountId = await root.getAttribute("data-juno-chat-mount-id");
    const initialDocumentId = await page.evaluate(() => window.__junoDocumentInstanceId);
    const initialNavigationType = await page.evaluate(() => window.__junoNavigationType);
    expect(initialDocumentId).toBeTruthy();
    expect(initialNavigationType).toBe("navigate");

    await sendSuccessfulTurn(
      page,
      `Healthy provider probe: reply with the exact token ${SUCCESS_TOKEN} and no other words.`,
    );
    await expect(page).toHaveURL(/\/chat\/[a-z0-9]+/i, { timeout: 30_000 });

    expect(await page.evaluate(() => window.__junoDocumentInstanceId)).toBe(initialDocumentId);
    expect(await page.evaluate(() => window.__junoBeforeUnloadFired)).toBe(0);
    expect(await page.evaluate(() => window.__junoPageShowFired)).toBe(0);
    expect(await page.evaluate(() => window.__junoPageHideFired)).toBe(0);
    expect(await root.getAttribute("data-juno-chat-mount-id")).toBe(initialMountId);

    await sendSuccessfulTurn(page, `Second healthy turn: reply with ${SUCCESS_TOKEN}.`);
    expect(await page.evaluate(() => window.__junoDocumentInstanceId)).toBe(initialDocumentId);
    expect(await root.getAttribute("data-juno-chat-mount-id")).toBe(initialMountId);
  });

  test("success persists across reload, sidebar navigation, history, and a copied URL", async ({ page, context }) => {
    test.setTimeout(180_000);
    const prompt = `Persistence probe: reply with ${SUCCESS_TOKEN}.`;
    await sendSuccessfulTurn(page, prompt);
    const conversationUrl = await page.url();
    const conversationId = new URL(conversationUrl).pathname.split("/").pop();
    expect(conversationId).toBeTruthy();

    await page.reload();
    await expect(page.locator("main")).toContainText(prompt, { timeout: 30_000 });
    await expect(page.locator(".prose-juno").last()).toContainText(SUCCESS_TOKEN, { timeout: 30_000 });
    await expect(providerErrorSurface(page)).toHaveCount(0);

    const sidebarLink = page.locator(`a[href="/chat/${conversationId}"]`).first();
    await expect(sidebarLink).toBeVisible({ timeout: 30_000 });
    await sidebarLink.click();
    await expect(page).toHaveURL(conversationUrl);
    await expect(page.locator(".prose-juno").last()).toContainText(SUCCESS_TOKEN, { timeout: 30_000 });

    // Explicit navigation creates a history entry; back/forward must preserve
    // the same conversation after the chat's own replaceState transition.
    await page.goto("/chat");
    await page.goto(conversationUrl);
    await page.goBack();
    await expect(page).toHaveURL(/\/chat$/);
    await page.goForward();
    await expect(page).toHaveURL(conversationUrl);
    await expect(page.locator(".prose-juno").last()).toContainText(SUCCESS_TOKEN, { timeout: 30_000 });

    // A copied conversation URL opened in a second tab must hydrate the same
    // persisted user and assistant messages.
    const copiedUrl = await page.evaluate(() => window.location.href);
    const copiedTab = await context.newPage();
    try {
      await copiedTab.goto(copiedUrl);
      await expect(copiedTab.locator("main")).toContainText(prompt, { timeout: 30_000 });
      await expect(copiedTab.locator(".prose-juno").last()).toContainText(SUCCESS_TOKEN, { timeout: 30_000 });
      await expect(providerErrorSurface(copiedTab)).toHaveCount(0);
    } finally {
      await copiedTab.close();
    }
  });

  test("typed provider failure renders a controlled error and retry action", async ({ page }) => {
    test.setTimeout(60_000);
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: "The configured smoke provider is unavailable.",
          },
        }),
      });
    });

    const input = composer(page);
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill("Controlled provider failure probe.");
    await page.locator(".composer-primary-action").click();
    await expect(page.getByText("The configured smoke provider is unavailable.", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(page.locator(".prose-juno")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(SUCCESS_TOKEN);
  });
});
