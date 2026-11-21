import { test, expect, type Page } from "@playwright/test";
import { SMOKE_CONTEXT_DIRECTIVE, SMOKE_CONTEXT_INPUT_TOKENS } from "../src/lib/chat/turn/model-streams";
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

    await page.goto("/chat");
    await expect(composer(page)).toBeVisible();
    // Simulate a browser that drops the animation callback. Opening a chat
    // still goes through the normal link and commits a different route.
    await page.evaluate(() => {
      Object.defineProperty(document, "startViewTransition", {
        configurable: true,
        value: () => ({ finished: Promise.resolve() }),
      });
    });
    const sidebarToggle = page.getByRole("button", { name: "Open menu", exact: true });
    if (await sidebarToggle.isVisible()) await sidebarToggle.click();
    const sidebarLink = page.locator(`a[href="/chat/${conversationId}"]:visible`).first();
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

  test("saved chat context usage survives a reload", async ({ page }, testInfo) => {
    const prompt = `Context usage probe: reply with ${SUCCESS_TOKEN}.`;
    const expectedInput = String(Math.ceil(prompt.length / 4));
    await sendSuccessfulTurn(page, prompt);
    await expect(page).toHaveURL(/\/chat\/[a-z0-9]+/i);

    const meter = page.getByRole("button", { name: /^Context: .* of the model's window used$/ });
    const details = page.getByRole("dialog", { name: "Context window" });
    const inputUsage = details.locator("dl > div").filter({ has: page.getByText("Input", { exact: true }) }).locator("dd");
    await meter.click();
    await expect(inputUsage).toHaveText(expectedInput);
    await expect(details.getByText("Cache hits", { exact: true })).toHaveCount(0);

    await page.reload();
    // The reload can paint the server-rendered button before it handles clicks.
    await expect(async () => {
      if ((await meter.getAttribute("aria-expanded")) !== "true") await meter.click();
      await expect(details).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(inputUsage).toHaveText(expectedInput);
    await page.screenshot({ path: testInfo.outputPath("desktop-context.png"), animations: "disabled" });
  });

  test("context opens as a phone sheet and returns keyboard focus", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 580 });
    const prompt = `Mobile context probe ${SMOKE_CONTEXT_DIRECTIVE}: reply with ${SUCCESS_TOKEN}.`;
    await sendSuccessfulTurn(page, prompt);
    const meter = page.getByRole("button", { name: /^Context: .* of the model's window used$/ });
    await meter.focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("dialog", { name: "Context window" });
    await expect(details).toHaveAttribute("data-side", "bottom");
    await expect(details.getByRole("button", { name: "Close context window" })).toBeVisible();
    await expect(details.locator("dd").first()).toHaveText(SMOKE_CONTEXT_INPUT_TOKENS.toLocaleString("en-US"));
    await page.screenshot({ path: testInfo.outputPath("phone-context.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(meter).toBeFocused();
  });

  test("chat keeps model search and sending reachable in a short window", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 430 });
    const model = page.getByRole("button", { name: /^Model:/ });
    await model.click();
    await page.getByRole("dialog", { name: "Thinking" }).getByRole("button", { name: /^Change model/ }).click();
    const picker = page.getByRole("dialog", { name: "Models" });
    const search = picker.getByRole("combobox", { name: "Search models" });
    await expect(search).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("short-model-picker.png"), animations: "disabled" });
    await search.fill("no models match this query");
    await expect(picker.getByText(/No models/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(model).toBeFocused();

    await composer(page).fill(Array.from({ length: 45 }, (_, i) => `Draft line ${i + 1}`).join("\n"));
    await expect(composer(page)).toBeInViewport();
    await expect(page.locator(".composer-primary-action")).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  });

  test("model search selects a named model without dropping a draft", async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => localStorage.setItem("theme", "dark"));
    await page.reload();
    await composer(page).fill("Compare the forecast with actual revenue.");
    const model = page.getByRole("button", { name: /^Model:/ });
    await model.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Thinking" }).getByRole("button", { name: /^Change model/ }).press("Enter");
    const picker = page.getByRole("dialog", { name: "Models" });
    const search = picker.getByRole("combobox", { name: "Search models" });
    await search.fill("qwen3.7 flash");
    await expect(picker.getByRole("option", { name: /^Qwen3\.7 Flash,/ }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("desktop-model-picker.png"), animations: "disabled" });
    await search.press("Home");
    await search.press("Enter");
    await expect(picker).toHaveCount(0);
    await expect(model).toHaveAccessibleName(/^Model: Qwen3\.7 Flash/);
    await expect(model).toBeFocused();
    await expect(composer(page)).toHaveText("Compare the forecast with actual revenue.");
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

test("ending voice restores the composer while the transcript saves", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "uses a synthetic Chromium microphone");
  await page.addInitScript(() => {
    localStorage.setItem("juno:onboarded:v1", "1");
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext();
      const stream = audio.createMediaStreamDestination().stream;
      const [track] = stream.getAudioTracks();
      const stop = track.stop.bind(track);
      track.stop = () => {
        stop();
        void audio.close();
      };
      return stream;
    };
  });
  await page.route("**/api/voice/relay-token*", (route) => route.fulfill({
    json: { token: "fixture", url: new URL("/qa-voice-relay", page.url()).href },
  }));
  const transcript = "A fixture line from the voice relay.";
  await page.routeWebSocket(/\/qa-voice-relay\/\?token=fixture$/, (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== "string" || JSON.parse(message).type !== "session.start") return;
      socket.send(JSON.stringify({
        type: "session.ready", provider: "gemini", thinking: false,
        capabilities: { videoInput: false, trueS2S: true, needsClientTranscript: false, thinkingChoice: false, maxSessionSec: 600 },
      }));
      socket.send(JSON.stringify({ type: "transcript", role: "assistant", text: transcript, final: true }));
    });
  });
  let releaseSave = () => {};
  const saveResponse = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route("**/api/voice/transcript", async (route) => {
    await saveResponse;
    await route.continue();
  });
  await page.goto("/chat");
  await page.getByRole("button", { name: "Start voice conversation" }).click();
  await expect(page.getByRole("log", { name: "Conversation transcript" })).toContainText(transcript, { timeout: 20_000 });
  const end = page.getByRole("button", { name: "End the call" });
  await expect(end).toBeVisible();
  const callFrame = page.locator(".voice-call-frame[data-voice-call]");
  await expect(callFrame).toBeVisible();
  await expect(callFrame.locator("[data-voice-edge], .border-primary\\/60")).toHaveCount(0);
  await end.evaluate((button) => {
    const frame = button.closest(".voice-call-frame");
    if (!frame) throw new Error("Voice composer frame is missing");
    Object.defineProperty(frame, "startViewTransition", {
      configurable: true,
      value: () => ({ ready: Promise.resolve() }),
    });
  });

  try {
    const pending = page.waitForRequest("**/api/voice/transcript");
    await end.click();
    const save = await pending;
    expect(save.postDataJSON()).toMatchObject({ turns: [{ role: "ASSISTANT", content: transcript }] });
    await expect(end).toHaveCount(0);
    await expect(composer(page)).toBeEditable();
    await composer(page).fill("A draft written while saving.");
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await expect(page.getByText(/saving (your chat|voice transcript)/i)).toHaveCount(0);
  } finally {
    releaseSave();
  }
  await expect(page).toHaveURL(/\/chat\/[a-z0-9]+$/i);
  await expect(composer(page)).toHaveText("A draft written while saving.");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("log", { name: "Conversation transcript" })).toContainText(transcript);
});
