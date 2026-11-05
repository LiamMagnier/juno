import { expect, test, type Page } from "@playwright/test";
import { SMOKE_SLOW_DIRECTIVE } from "../../src/lib/chat/turn/model-streams";
import { expectNotStreaming, lastAnswer, openNewChat, submitPrompt } from "./journey";

/*
 * Reading while an answer streams (COMPETITORS.md §4, outcome 3), on the real
 * /chat/[id] route rather than the development benches: a reader who scrolls
 * up to an earlier turn keeps their line while new words arrive below, and
 * Jump to latest, asked for under reduced motion, is one instant move with no
 * glide.
 */

const SCROLLER = '[aria-label="Conversation messages"]';

/** Earlier turns, each tall enough that three of them overflow a short window. */
const EARLIER = [1, 2, 3].map(
  (n) =>
    `Reading probe ${n}: ` +
    "a paragraph long enough to wrap over several lines of the reading column, so that the transcript has history above the answer that is streaming. ".repeat(3) +
    `JUNO_READING_${n}_OK`
);

function topOf(page: Page, text: string) {
  return page.locator(SCROLLER).evaluate((scroller, needle) => {
    const row = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")].find((el) => el.textContent?.includes(needle));
    return row ? row.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null;
  }, text);
}

function distanceFromEnd(page: Page) {
  return page.locator(SCROLLER).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

test.describe("Reading while an answer streams", () => {
  test.use({ viewport: { width: 1280, height: 640 } });

  test("an earlier turn holds still under the reader, and Jump to latest is instant under reduced motion", async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openNewChat(page);
    for (const [i, prompt] of EARLIER.entries()) {
      await submitPrompt(page, prompt);
      await expect(lastAnswer(page)).toContainText(`JUNO_READING_${i + 1}_OK`, { timeout: 60_000 });
      await expectNotStreaming(page);
    }

    await submitPrompt(page, `Reading probe: write at length. ${SMOKE_SLOW_DIRECTIVE}`);
    await expect(lastAnswer(page)).toContainText("word3", { timeout: 30_000 });

    // The reader scrolls up to the second turn and starts reading it.
    const scroller = page.locator(SCROLLER);
    const box = (await scroller.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const reading = "Reading probe 2:";
    for (let i = 0; i < 12; i++) {
      const top = await topOf(page, reading);
      if (top !== null && top > 0 && top < box.height / 2) break;
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(150);
    }
    await expect.poll(() => scroller.getAttribute("data-follow")).toBe("free");
    const held = await topOf(page, reading);
    expect(held, "the second question is on screen").not.toBeNull();
    const words = (await lastAnswer(page).innerText()).length;

    // New words keep arriving below; the line being read does not move.
    await expect.poll(async () => (await lastAnswer(page).innerText()).length, { timeout: 10_000 }).toBeGreaterThan(words + 30);
    for (let i = 0; i < 6; i++) {
      expect(Math.abs((await topOf(page, reading))! - held!), "the reader's line holds").toBeLessThan(2);
      await page.waitForTimeout(250);
    }

    // Jump to latest: shown, and under reduced motion the first frame after
    // the press is already at the end, not a glide toward it.
    const jump = page.getByRole("button", { name: "Jump to latest" });
    await expect(jump).toBeVisible();
    await jump.click();
    const firstFrame = await page.evaluate(
      (sel) => new Promise<number>((resolve) => requestAnimationFrame(() => {
        const el = document.querySelector(sel)!;
        resolve(el.scrollHeight - el.scrollTop - el.clientHeight);
      })),
      SCROLLER
    );
    expect(firstFrame, "one instant move to the end").toBeLessThan(4);
    await expect.poll(() => scroller.getAttribute("data-follow")).toBe("following");
    // And it keeps up with the words still arriving.
    await page.waitForTimeout(1_000);
    expect(await distanceFromEnd(page)).toBeLessThan(40);
    await expect(jump).toBeHidden();

    await page.locator('.composer-primary-action[data-face="stop"]').click();
    await expectNotStreaming(page, 15_000);
  });
});
