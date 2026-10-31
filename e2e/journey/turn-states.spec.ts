import { expect, test, type Locator, type Page } from "@playwright/test";
import { SMOKE_SLOW_DIRECTIVE, SMOKE_SLOW_START } from "../../src/lib/chat/turn/model-streams";
import { composer } from "../helpers";
import { conversationIdOf, expectNotStreaming, lastAnswer, openNewChat, submitPrompt } from "./journey";

/*
 * The four states of a turn (COMPETITORS.md §4, outcome 2) on the real chat
 * route: generating, a recoverable failure, a stopped turn and a completed
 * turn each say which they are, in words and controls, not by colour alone.
 * And leaving a chat while its answer streams, then coming back (sidebar,
 * history, reload), re-attaches to the one generation: no second request.
 */

/**
 * The turn around the newest answer, pinned by its message id so it still
 * names that turn after later turns arrive. Call it once the turn has settled:
 * a streaming answer is renamed from its temporary id when it lands.
 */
async function newestTurn(page: Page): Promise<Locator> {
  const id = await lastAnswer(page).locator("xpath=ancestor::*[@data-juno-message][1]").getAttribute("data-juno-message");
  expect(id, "the newest answer sits in a named turn").toBeTruthy();
  return page.locator(`[data-juno-message="${id}"]`);
}

async function stateOf(turn: Locator) {
  return {
    streaming: (await turn.locator('[data-streaming="true"]').count()) > 0,
    stopped: (await turn.getByText("Stopped by user.", { exact: true }).count()) > 0,
    failed: (await turn.getByRole("button", { name: "Try again", exact: true }).count()) > 0,
    actions: (await turn.getByRole("button", { name: "Copy", exact: true }).count()) > 0,
  };
}

function chatPosts(page: Page) {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") posts.push(request.url());
  });
  return posts;
}

test.describe("Turn states", () => {
  test("generating, stopped, failed and completed turns are told apart in words and controls", async ({ page }) => {
    test.setTimeout(150_000);
    await openNewChat(page);

    // Completed.
    await submitPrompt(page, "State probe: reply with JUNO_STATE_COMPLETED_OK.");
    await expect(lastAnswer(page)).toContainText("JUNO_STATE_COMPLETED_OK", { timeout: 60_000 });
    await expectNotStreaming(page);
    const completed = await newestTurn(page);
    expect(await stateOf(completed)).toEqual({ streaming: false, stopped: false, failed: false, actions: true });

    // Generating: the answer says it is still being written, and the one
    // primary control is Stop.
    await submitPrompt(page, `State probe: write at length. ${SMOKE_SLOW_DIRECTIVE}`);
    await expect(lastAnswer(page)).toContainText("word2", { timeout: 30_000 });
    const generating = lastAnswer(page).locator("xpath=ancestor::*[@data-juno-message][1]");
    expect(await stateOf(generating)).toEqual({ streaming: true, stopped: false, failed: false, actions: false });
    await expect(page.locator(".composer-primary-action")).toHaveAttribute("aria-label", "Stop generating");

    // Stopped: the partial answer stays, says it was stopped, and is not an error.
    await page.locator('.composer-primary-action[data-face="stop"]').click();
    await expectNotStreaming(page, 15_000);
    const stopped = await newestTurn(page);
    await expect(stopped.getByText("Stopped by user.", { exact: true })).toBeVisible();
    expect(await stateOf(stopped)).toEqual({ streaming: false, stopped: true, failed: false, actions: true });
    await expect(lastAnswer(page)).toContainText(SMOKE_SLOW_START);

    // A recoverable failure: the reason in words, the question kept, a way to retry.
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "PROVIDER_UNAVAILABLE", message: "The model is unavailable right now." } }),
      });
    });
    await composer(page).fill("State probe: this one fails.");
    await page.locator(".composer-primary-action").click();
    await expect(page.getByText("The model is unavailable right now.", { exact: true })).toBeVisible({ timeout: 15_000 });
    const failedTurn = page.locator("[data-juno-message]").filter({ hasText: "The model is unavailable right now." }).last();
    expect(await stateOf(failedTurn)).toEqual({ streaming: false, stopped: false, failed: true, actions: false });
    await expect(page.getByText("Not sent", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry send" })).toBeVisible();

    // The earlier turns kept their own states.
    expect(await stateOf(completed)).toEqual({ streaming: false, stopped: false, failed: false, actions: true });
    expect(await stateOf(stopped)).toEqual({ streaming: false, stopped: true, failed: false, actions: true });

    // Recovering it really retries: the route answers again and the question goes out once more.
    await page.unroute("**/api/chat");
    const retried = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/chat");
    await page.getByRole("button", { name: "Retry send" }).click();
    expect((await retried).ok()).toBeTruthy();
    await expect(page.getByText("Not sent", { exact: true })).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText("The model is unavailable right now.", { exact: true })).toHaveCount(0);
  });

  test("leaving a streaming chat and coming back re-attaches to the one generation", async ({ page }) => {
    test.setTimeout(150_000);
    const posts = chatPosts(page);
    const reattached: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/chat/stream/")) reattached.push(request.url());
    });
    await openNewChat(page);
    await submitPrompt(page, `Navigation probe: write at length. ${SMOKE_SLOW_DIRECTIVE}`);
    await expect(lastAnswer(page)).toContainText("word3", { timeout: 30_000 });
    const conversationId = await conversationIdOf(page);
    const conversationUrl = page.url();
    expect(posts).toHaveLength(1);

    // Away to a new chat and back through the sidebar.
    await page.getByRole("button", { name: /^New chat/ }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(composer(page)).toBeVisible();
    await page.locator(`a[href="/chat/${conversationId}"]`).first().click();
    await expect(page).toHaveURL(conversationUrl);
    await expect(page.locator('[data-streaming="true"]')).toHaveCount(1, { timeout: 15_000 });
    const before = (await lastAnswer(page).innerText()).length;
    await expect.poll(async () => (await lastAnswer(page).innerText()).length, { timeout: 10_000 }).toBeGreaterThan(before);

    // Browser history and a reload land on the same generation too.
    await page.goBack();
    await expect(page).toHaveURL(/\/chat$/);
    await page.goForward();
    await expect(page).toHaveURL(conversationUrl);
    await page.reload();
    await expect(lastAnswer(page)).toContainText(SMOKE_SLOW_START, { timeout: 30_000 });
    await expect(page.locator('[data-streaming="true"]')).toHaveCount(1, { timeout: 15_000 });

    expect(posts, "one POST /api/chat for one question").toHaveLength(1);
    expect(reattached.length, "returning re-attached to the running answer").toBeGreaterThan(0);
    expect(new Set(reattached.map((url) => new URL(url).pathname)).size, "always the same generation").toBe(1);

    await page.locator('.composer-primary-action[data-face="stop"]').click();
    await expectNotStreaming(page, 15_000);
    expect(posts).toHaveLength(1);
  });
});
