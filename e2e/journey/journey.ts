import { expect, type Page, type Response } from "@playwright/test";
import { composer } from "../helpers";

/*
 * Shared steps for the deterministic journey (ledger P1-5): the specs in this
 * folder, plus e2e/chat.spec.ts and e2e/regenerate.spec.ts, run on every pull
 * request against the QA runner's production build, with the chat route's
 * deterministic smoke provider (src/lib/chat/turn/model-streams.ts) standing
 * in for a model. Nothing here talks to a real provider or a real account.
 */

/** Opens a fresh chat with onboarding dismissed and waits for the composer. */
export async function openNewChat(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("juno:onboarded:v1", "1");
  });
  await page.goto("/chat");
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
}

function isChatPost(response: Response): boolean {
  const request = response.request();
  return request.method() === "POST" && new URL(response.url()).pathname === "/api/chat";
}

/**
 * Types `prompt`, presses send, and waits for the /api/chat stream to open.
 * Returns the response so a caller can read the request it carried.
 */
export async function submitPrompt(page: Page, prompt: string): Promise<Response> {
  const input = composer(page);
  const send = page.locator(".composer-primary-action");
  const opened = page.waitForResponse(isChatPost, { timeout: 30_000 });
  await input.fill(prompt);
  await expect(send).toBeEnabled({ timeout: 5_000 });
  await send.click();
  const response = await opened;
  expect(response.ok(), `POST /api/chat answered ${response.status()}`).toBeTruthy();
  expect(response.headers()["content-type"] ?? "").toMatch(/text\/event-stream/i);
  return response;
}

/** The id in /chat/<id>, once the first turn has given the conversation one. */
export async function conversationIdOf(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/chat\/[a-z0-9]+/i, { timeout: 30_000 });
  const id = new URL(page.url()).pathname.split("/").pop();
  expect(id, "conversation id in the URL").toBeTruthy();
  return id!;
}

/** The newest assistant answer in the transcript. */
export function lastAnswer(page: Page) {
  return page.locator(".prose-juno").last();
}

/** Resolves when no answer is streaming any more. */
export async function expectNotStreaming(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout });
}
