import { test, expect, type Page } from "@playwright/test";
import { composer } from "./helpers";

/**
 * Real chat controls with a deterministic, client-only stream. No model or
 * saved conversation is needed: incognito carries the fixture in memory.
 * Run through npm run test:e2e so auth uses the disposable local QA database.
 */
async function openStreamingConversation(page: Page, text: string) {
  await page.addInitScript((answer) => {
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, location.href).pathname;
      if (path === "/api/chat/clarify") return Promise.resolve(Response.json({ needsClarification: false }));
      if (path === "/api/chat" && init?.method === "POST") {
        const encoder = new TextEncoder();
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text: answer })}\n\n`));
            // Leave the stream live until the user presses Stop. In a real
            // fetch AbortSignal closes the body; the stub must do the same.
            init.signal?.addEventListener("abort", () => controller.error(new DOMException("Stopped", "AbortError")), { once: true });
          },
        }), { headers: { "content-type": "text/event-stream" } }));
      }
      return realFetch(input, init);
    };
    localStorage.setItem("juno:onboarded:v1", "1");
  }, text);
  await page.goto("/chat");
  await page.getByRole("button", { name: "Turn on incognito", exact: true }).click();
  await composer(page).fill("Keep preparing this response.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".prose-juno").last()).toContainText(text.slice(0, 24));
  await expect(page.getByRole("button", { name: "Stop generating", exact: true })).toBeVisible();
  await composer(page).focus();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.getByRole("textbox", { name: "Find in this conversation", exact: true })).toBeFocused();
}

test("Find previews individual hits and Escape closes it without stopping the answer", async ({ page }, testInfo) => {
  await openStreamingConversation(page, `The needle starts the first section. ${"Intervening detail. ".repeat(12)} The needle finishes the final section.`);
  const find = page.getByRole("textbox", { name: "Find in this conversation", exact: true });
  const preview = page.locator("[data-conversation-find-preview]");
  await find.fill("needle");
  await expect(page.getByRole("search")).toContainText("1 of 2");
  await expect(preview.locator("mark")).toHaveText("needle");
  await expect(preview).toContainText("first section");
  await find.press("Enter");
  await expect(page.getByRole("search")).toContainText("2 of 2");
  await expect(preview).toContainText("final section");
  const previewPath = testInfo.outputPath("find-context-preview.png");
  await page.screenshot({ path: previewPath });
  await testInfo.attach("find-context-preview", { path: previewPath, contentType: "image/png" });
  await find.press("Shift+Enter");
  await expect(page.getByRole("search")).toContainText("1 of 2");

  // Committing an IME candidate is not "next result" or "close Find".
  await find.dispatchEvent("keydown", { key: "Enter", isComposing: true, keyCode: 229 });
  await expect(page.getByRole("search")).toContainText("1 of 2");
  await find.dispatchEvent("keydown", { key: "Escape", isComposing: true, keyCode: 229 });
  await expect(find).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop generating", exact: true })).toBeVisible();

  // Claim Escape even on a button: otherwise the composer's global shortcut
  // cancels paid work when the user only meant to dismiss search.
  await page.getByRole("button", { name: "Next match", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("search")).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  await expect(page.getByRole("button", { name: "Stop generating", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop generating", exact: true }).click();
});

test("Find discloses capped results and supports replacement with the repeated shortcut", async ({ page }, testInfo) => {
  await openStreamingConversation(page, `${"needle ".repeat(501)}A unique ending.`);
  const find = page.getByRole("textbox", { name: "Find in this conversation", exact: true });
  await find.fill("needle");
  await expect(page.getByRole("search")).toContainText("1 of 500+");
  await expect(page.getByRole("search")).toContainText("Showing the first 500 matches");
  const cappedPath = testInfo.outputPath("find-capped-results.png");
  await page.screenshot({ path: cappedPath });
  await testInfo.attach("find-capped-results", { path: cappedPath, contentType: "image/png" });
  await page.getByRole("button", { name: "Next match", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(find).toBeFocused();
  await page.keyboard.type("unique");
  await expect(find).toHaveValue("unique");
  await expect(page.getByRole("search")).toContainText("1 of 1");
  await expect(page.locator("[data-conversation-find-preview] mark")).toHaveText("unique");
  await find.press("Escape");
  await page.getByRole("button", { name: "Stop generating", exact: true }).click();
});
