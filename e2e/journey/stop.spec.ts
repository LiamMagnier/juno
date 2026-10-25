import { expect, test } from "@playwright/test";
import { SMOKE_SLOW_DIRECTIVE, SMOKE_SLOW_END, SMOKE_SLOW_START } from "../../src/lib/chat/turn/model-streams";
import { conversationIdOf, expectNotStreaming, lastAnswer, openNewChat, submitPrompt } from "./journey";

/*
 * Stop, end to end (ledger P1-5): a long answer is streaming, the reader
 * presses Stop, and
 *   - the server really stops (POST /api/chat/cancel answers cancelled: true,
 *     not just the browser dropping its stream);
 *   - the transcript stops growing and the composer is ready again;
 *   - the partial answer is kept, and after a reload it is still the partial
 *     answer: nothing resumed it, and it never reached its end marker.
 *
 * The smoke provider's slow mode streams a word every 150ms for 45s and
 * honours the generation's abort signal, so a Stop that only hid the stream
 * would show up here as an answer that keeps growing or finishes.
 */

test.describe("Stop", () => {
  test("stops a streaming answer on the server and keeps the partial answer", async ({ page }) => {
    test.setTimeout(120_000);
    await openNewChat(page);

    await submitPrompt(page, `Stop probe: write at length. ${SMOKE_SLOW_DIRECTIVE}`);
    await expect(lastAnswer(page)).toContainText(SMOKE_SLOW_START, { timeout: 30_000 });
    // A few words in, so the partial answer has something beyond its marker.
    await expect(lastAnswer(page)).toContainText("word3", { timeout: 15_000 });
    const conversationId = await conversationIdOf(page);

    // The composer's primary action wears its "stop" face while an answer
    // streams (`.composer-primary-action` is the class hook kept for e2e).
    const stop = page.locator('.composer-primary-action[data-face="stop"]');
    await expect(stop).toBeVisible();
    await expect(stop).toHaveAttribute("aria-label", "Stop generating");
    const cancelled = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/chat/cancel",
      { timeout: 15_000 }
    );
    await stop.click();
    const cancel = await cancelled;
    expect(cancel.ok(), `POST /api/chat/cancel answered ${cancel.status()}`).toBeTruthy();
    expect(await cancel.json()).toMatchObject({ cancelled: true });

    await expectNotStreaming(page, 15_000);
    await expect(page.locator('.composer-primary-action[data-face="stop"]')).toHaveCount(0, { timeout: 10_000 });
    const stoppedText = (await lastAnswer(page).innerText()).trim();
    expect(stoppedText).toContain(SMOKE_SLOW_START);
    expect(stoppedText).not.toContain(SMOKE_SLOW_END);

    // Nothing keeps writing behind the reader's back.
    await page.waitForTimeout(2_000);
    expect((await lastAnswer(page).innerText()).trim()).toBe(stoppedText);

    // The kept answer is the stored one: reload, and it is still partial and
    // still not streaming (a server still generating would be re-attached to
    // here and keep growing).
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/chat/${conversationId}`));
    await expect(lastAnswer(page)).toContainText(SMOKE_SLOW_START, { timeout: 30_000 });
    await expectNotStreaming(page, 15_000);
    const reloaded = (await lastAnswer(page).innerText()).trim();
    expect(reloaded).not.toContain(SMOKE_SLOW_END);
    await page.waitForTimeout(2_000);
    expect((await lastAnswer(page).innerText()).trim()).toBe(reloaded);
  });
});
